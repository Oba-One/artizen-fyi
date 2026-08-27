import type { Bubble } from '../artizen/bubble';
import type {
  FundProfile,
  MatchIndexSource,
  MatchIndex,
  MatchRelationshipKind,
  ProjectFundRelationship,
  ProjectHistory,
  ProjectProfile,
  Row,
  ScoringConfig,
} from '../artizen/types';
import { firstMedia, hidden, int, mapSome, maybeNum, mediaUrl, num, text } from '../artizen/util';
import { SEMANTIC_CATALOG } from './semantic-config';
import { cleanNarrative, splitEligibility } from './narrative';
import { projectVectorText, vectorFingerprint } from './semantic-text';
import {
  MATCH_FACETS,
  MATCH_TAXONOMY_VERSION,
  conceptCandidates,
  extractFacetIds,
  extractFundFocusFacetIds,
} from './taxonomy';

export const MATCH_INDEX_KEY = 'artizen/matching/v2';

export const DEFAULT_SCORING: ScoringConfig = {
  version: 'context-2026-08-26.1',
  lexicalWeight: 0.4,
  facetWeight: 0.4,
  coreCoverageWeight: 0.2,
  semanticWeight: 0.55,
  semanticFacetWeight: 0.25,
  semanticCoreCoverageWeight: 0.15,
  semanticLexicalWeight: 0.05,
  strongThreshold: 0.44,
  goodThreshold: 0.38,
  exploratoryThreshold: 0.1,
  unsupportedFocusPenalty: 0.35,
  eligibilityBoost: 0.15,
  exclusionPenalty: 0.2,
};

type BuildOptions = {
  previous?: MatchIndex | null;
  sourceKind?: MatchIndexSource['kind'];
};

function strings(value: unknown): string[] {
  if (value == null || value === false || value === '') return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function relationshipKind(row: Row): MatchRelationshipKind | undefined {
  if (row['Submitted'] === false) return undefined;
  if (num(row['$ amount raised']) > 0) return 'funded';
  const status = (text(row['Status']) || '').toLowerCase();
  if (status === 'curated' || status === 'approved') return 'curated';
  if (row['Project'] && row['Fund']) return 'submitted';
}

function relationshipRank(kind: MatchRelationshipKind): number {
  return kind === 'funded' ? 3 : kind === 'curated' ? 2 : 1;
}

/**
 * Folds the relationship table into each project as compact `[fundId, kind]` pairs.
 *
 * The flat table repeats the project id, the season, and a creation date on every row, and the
 * browser only ever needs the rows for the one project being matched. Carrying the pairs per
 * project lets the split payloads ship one project's history instead of the whole table, which is
 * roughly 1.5 MB of the catalog.
 */
function attachHistory(projects: ProjectProfile[], relationships: ProjectFundRelationship[]): void {
  const byProject = new Map<string, ProjectHistory>();
  for (const relationship of relationships) {
    const rows = byProject.get(relationship.projectId) || [];
    rows.push([relationship.fundId, relationship.kind]);
    byProject.set(relationship.projectId, rows);
  }
  for (const project of projects) {
    const rows = byProject.get(project.id);
    if (rows?.length) project.history = rows;
    else delete project.history;
  }
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function deriveCoreConcepts(funds: FundProfile[]): void {
  const candidatesByFund = new Map<string, string[]>();
  const documentFrequency = new Map<string, number>();
  for (const fund of funds) {
    const candidates = uniqueSorted(
      conceptCandidates(fund.name, fund.forTitle, fund.subtitle, fund.description, (fund.eligibilityCriteria || []).join(' ')),
    );
    candidatesByFund.set(fund.id, candidates);
    for (const candidate of candidates) {
      documentFrequency.set(candidate, (documentFrequency.get(candidate) || 0) + 1);
    }
  }

  const count = Math.max(1, funds.length);
  for (const fund of funds) {
    const titleCandidates = new Set(conceptCandidates(fund.name, fund.forTitle));
    fund.coreConcepts = (candidatesByFund.get(fund.id) || [])
      .map((candidate) => {
        const frequency = documentFrequency.get(candidate) || 1;
        const idf = Math.log(1 + count / frequency);
        const phraseBoost = candidate.includes(' ') ? 1.3 : 1;
        const titleBoost = titleCandidates.has(candidate) ? 1.35 : 1;
        return { candidate, score: idf * phraseBoost * titleBoost, frequency };
      })
      .filter((row) => row.frequency / count <= 0.18)
      .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))
      .slice(0, 8)
      .map((row) => row.candidate);
  }
}

function rejectUnexpectedDrop(previous: MatchIndex | null | undefined, next: MatchIndex): void {
  if (!previous || previous.source.kind !== 'artizen-api' || next.source.kind !== 'artizen-api') return;
  for (const field of ['projects', 'funds', 'relationships'] as const) {
    const before = previous.source[field];
    const after = next.source[field];
    if (before > 0 && after < before * 0.8) {
      throw new Error(`matching v2 ${field} count dropped from ${before} to ${after}`);
    }
  }
}

export async function buildMatchIndex(client: Bubble, options: BuildOptions = {}): Promise<MatchIndex> {
  const [projectRows, fundRows, extendedRows, submissionRows, tagRows, artifactRows] = await Promise.all([
    client.list('project', { concurrency: 6 }),
    client.list('fund', { concurrency: 6 }),
    client.list('fundextendedinfo', { concurrency: 6 }),
    client.list('projectsubmission', { concurrency: 6 }),
    client.list('impacttag', { concurrency: 6 }),
    // Cosmetic data on the biggest table crawled here. A network or upstream API failure must not
    // cost the catalog its build; project images can fall back to legacy fields.
    client.list('artifact', { concurrency: 6 }).catch((error) => {
      console.warn(`[Artizen] artifact crawl failed, project images fall back to legacy fields: ${error}`);
      return [] as Row[];
    }),
  ]);

  // Artifact art is the project image people actually recognise. The two legacy fields on the
  // project row cover only a quarter of the catalog, so without this most cards fall back to a
  // blank tile. Keep the newest season's artwork per project.
  const artifactImages = new Map<string, { season: number; created: string; image: string }>();
  for (const row of artifactRows) {
    if (hidden(row)) continue;
    const projectId = text(row['Project']);
    if (!projectId) continue;
    const image = firstMedia(row['image - crop'], row['image - compressed'], row['image - original']);
    if (!image) continue;
    const season = row['season number'] == null ? -1 : int(row['season number']);
    const created = text(row['Created Date']) || '';
    const held = artifactImages.get(projectId);
    if (!held || season > held.season || (season === held.season && created > held.created)) {
      artifactImages.set(projectId, { season, created, image });
    }
  }

  const tagsById = new Map(
    tagRows.flatMap((row) => {
      const id = text(row['_id']);
      const name = text(row['name']);
      return id && name ? [[id, name] as const] : [];
    }),
  );
  const extendedById = new Map(extendedRows.flatMap((row) => (row['_id'] ? [[String(row['_id']), row] as const] : [])));

  const projects: ProjectProfile[] = mapSome(projectRows, (row) => {
    if (hidden(row)) return undefined;
    const id = text(row['_id']);
    const name = text(row['Name']);
    if (!id || !name) return undefined;
    const description = text(row['Logline']) || '';
    const context = {
      description: cleanNarrative(row['Description']) || undefined,
      impact: cleanNarrative(row['Impact']) || undefined,
      progress: cleanNarrative(row['Progress']) || undefined,
      team: cleanNarrative(row['Team']) || undefined,
    };
    const tags = uniqueSorted(strings(row['impact tags (impact tag)']).flatMap((tagId) => tagsById.get(tagId) || []));
    const project: ProjectProfile = {
      id,
      slug: text(row['Slug']) || id,
      name,
      description,
      tags,
      context,
      // Team biographies and progress reports are useful eligibility evidence, but they do not
      // define what the work is about and must not mint hard project facets.
      facets: extractFacetIds(name, description, context.description, context.impact, tags.join(' ')),
      image:
        artifactImages.get(id)?.image ||
        firstMedia(row['(old) Artifact Image -crop'], row['Profile image lead creator']),
    };
    project.semanticFingerprint = vectorFingerprint(projectVectorText(project));
    return project;
  }).sort((a, b) => a.name.localeCompare(b.name));

  const funds: FundProfile[] = [];
  for (const row of fundRows) {
    if (hidden(row)) continue;
    const id = text(row['_id']);
    const baseName = text(row['name']);
    if (!id || !baseName) continue;
    const slug = text(row['Slug']) || id;
    const ext = extendedById.get(String(row['Extended info'] ?? ''));
    const name = text(ext?.['full title']) || baseName;
    const subtitle = text(ext?.['subtitle']);
    const forTitle = text(ext?.['for title']);
    const description = cleanNarrative(ext?.['description']) || undefined;
    const eligibility = splitEligibility(ext?.['eligibility']);
    const themes: string[] = [];
    const aliases: string[] = [];
    const preferredTerms: string[] = [];
    const excludedTerms: string[] = [];
    const profileText = [
      name,
      subtitle,
      forTitle,
      description,
      ...eligibility.criteria,
      ...themes,
      ...aliases,
      ...preferredTerms,
    ].filter(Boolean).join('. ');
    const facets = uniqueSorted(extractFacetIds(profileText));
    // Long narratives often name problems, examples, or adjacent methods that the fund is not
    // narrowly for. Keep hard focus guards grounded in the headline fields; narrative matches
    // remain ordinary facets until they have been reviewed across the live catalog.
    const focusFacets = extractFundFocusFacetIds(name, forTitle, subtitle).filter((facetId) =>
      facets.includes(facetId),
    );
    funds.push({
      id,
      slug,
      name,
      subtitle,
      forTitle,
      description,
      eligibility: eligibility.text || undefined,
      eligibilityCriteria: eligibility.criteria,
      eligibilityExclusions: eligibility.exclusions,
      active: row['active'] !== false,
      available: maybeNum(row['Funding - current']),
      themes,
      aliases,
      preferredTerms,
      excludedTerms,
      profileText,
      profileHash: await digest({
        name,
        subtitle,
        forTitle,
        description,
        eligibilityCriteria: eligibility.criteria,
        eligibilityExclusions: eligibility.exclusions,
        themes,
        aliases,
        preferredTerms,
        excludedTerms,
        facets,
        focusFacets,
      }),
      facets,
      focusFacets,
      coreConcepts: [],
      image: mediaUrl(row['cover image']),
    });
  }
  funds.sort((a, b) => a.name.localeCompare(b.name));
  deriveCoreConcepts(funds);

  const projectIds = new Set(projects.map((project) => project.id));
  const fundIds = new Set(funds.map((fund) => fund.id));
  const relationshipByPair = new Map<string, ProjectFundRelationship>();
  for (const row of submissionRows) {
    const projectId = text(row['Project']);
    const fundId = text(row['Fund']);
    const kind = relationshipKind(row);
    if (!projectId || !fundId || !kind || !projectIds.has(projectId) || !fundIds.has(fundId)) continue;
    const seasonNumber = row['season number'] == null ? undefined : int(row['season number']);
    const createdAt = text(row['Created Date']);
    const candidate: ProjectFundRelationship = { projectId, fundId, kind, seasonNumber, createdAt };
    const key = `${projectId}\0${fundId}`;
    const previous = relationshipByPair.get(key);
    if (
      !previous ||
      relationshipRank(candidate.kind) > relationshipRank(previous.kind) ||
      (relationshipRank(candidate.kind) === relationshipRank(previous.kind) &&
        (candidate.seasonNumber || 0) >= (previous.seasonNumber || 0))
    ) {
      relationshipByPair.set(key, candidate);
    }
  }
  const relationships = [...relationshipByPair.values()].sort(
    (a, b) => a.projectId.localeCompare(b.projectId) || a.fundId.localeCompare(b.fundId),
  );
  attachHistory(projects, relationships);

  const source: MatchIndexSource = {
    kind: options.sourceKind || 'artizen-api',
    projects: projects.length,
    funds: funds.length,
    relationships: relationships.length,
  };
  const versionable = {
    source,
    taxonomyVersion: MATCH_TAXONOMY_VERSION,
    facets: MATCH_FACETS,
    projects,
    funds,
    relationships,
    scoring: DEFAULT_SCORING,
    semantic: SEMANTIC_CATALOG,
  };
  const index: MatchIndex = {
    schemaVersion: 2,
    indexVersion: (await digest(versionable)).slice(0, 20),
    generatedAt: new Date().toISOString(),
    ...versionable,
  };
  validateMatchIndex(index);
  rejectUnexpectedDrop(options.previous, index);
  return index;
}

export function validateMatchIndex(index: MatchIndex): void {
  if (index.schemaVersion !== 2) throw new Error('unsupported matching v2 schema');
  if (!index.indexVersion || !index.generatedAt) throw new Error('matching v2 version is missing');
  if (!index.source || index.source.projects !== index.projects.length || index.source.funds !== index.funds.length) {
    throw new Error('matching v2 source counts do not match the catalog');
  }
  if (index.projects.length === 0 || index.funds.length === 0) throw new Error('matching v2 catalog is empty');
  const projectIds = new Set(index.projects.map((project) => project.id));
  const fundIds = new Set(index.funds.map((fund) => fund.id));
  if (projectIds.size !== index.projects.length || fundIds.size !== index.funds.length) {
    throw new Error('matching v2 catalog contains duplicate ids');
  }
  const facetIds = new Set(index.facets.map((facet) => facet.id));
  for (const fund of index.funds) {
    if (!fund.profileHash || !fund.profileText || fund.profileHash.length !== 64) {
      throw new Error(`matching v2 fund profile is invalid: ${fund.id}`);
    }
    if ([...fund.facets, ...fund.focusFacets].some((facetId) => !facetIds.has(facetId))) {
      throw new Error(`matching v2 fund has an unknown facet: ${fund.id}`);
    }
  }
  for (const relationship of index.relationships) {
    if (!projectIds.has(relationship.projectId) || !fundIds.has(relationship.fundId)) {
      throw new Error('matching v2 relationship references a missing record');
    }
  }
  for (const project of index.projects) {
    if (project.semanticFingerprint && !/^[a-f0-9]{16}$/.test(project.semanticFingerprint)) {
      throw new Error(`matching v2 project semantic fingerprint is invalid: ${project.id}`);
    }
    for (const [fundId] of project.history || []) {
      if (!fundIds.has(fundId)) throw new Error('matching v2 project history references a missing fund');
    }
  }
  const baselineWeight = index.scoring.lexicalWeight + index.scoring.facetWeight + index.scoring.coreCoverageWeight;
  const semanticWeight =
    index.scoring.semanticWeight +
    index.scoring.semanticFacetWeight +
    index.scoring.semanticCoreCoverageWeight +
    index.scoring.semanticLexicalWeight;
  if (Math.abs(baselineWeight - 1) > 0.0001 || Math.abs(semanticWeight - 1) > 0.0001) {
    throw new Error('matching v2 weights must total 1');
  }
  const boundedAdjustments = [
    index.scoring.eligibilityBoost ?? 0.15,
    index.scoring.exclusionPenalty ?? 0.2,
  ];
  if (boundedAdjustments.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error('matching v2 eligibility adjustments must be between 0 and 1');
  }
}
