import type { Bubble } from '../artizen/bubble';
import type {
  FundProfile,
  MatchIndexV1,
  MatchRelationshipKind,
  ProjectFundRelationship,
  ProjectProfile,
  Row,
  ScoringConfig,
} from '../artizen/types';
import { hidden, int, mapSome, maybeNum, num, text } from '../artizen/util';
import { FUND_PROFILE_OVERRIDES } from './overrides';

export const MATCH_INDEX_KEY = 'artizen/matching/v1';

export const DEFAULT_SCORING: ScoringConfig = {
  contentWeight: 0.45,
  tagWeight: 0.25,
  graphWeight: 0.3,
  directRelationshipShare: 0.6,
  similarProjectLimit: 20,
  fundHistoryLimit: 24,
};

function strings(value: unknown): string[] {
  if (value == null || value === false || value === '') return [];
  return (Array.isArray(value) ? value : [value]).map(String);
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

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

async function versionFor(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 10)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function buildMatchIndex(client: Bubble): Promise<MatchIndexV1> {
  const [projectRows, fundRows, extendedRows, submissionRows, tagRows] = await Promise.all([
    client.list('project', { concurrency: 6 }),
    client.list('fund', { concurrency: 6 }),
    client.list('fundextendedinfo', { concurrency: 6 }),
    client.list('projectsubmission', { concurrency: 6 }),
    client.list('impacttag', { concurrency: 6 }),
  ]);

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
    return {
      id,
      slug: text(row['Slug']) || id,
      name,
      description: text(row['Logline']) || '',
      tags: uniqueSorted(strings(row['impact tags (impact tag)']).flatMap((tagId) => tagsById.get(tagId) || [])),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const funds: FundProfile[] = mapSome(fundRows, (row) => {
    const id = text(row['_id']);
    const baseName = text(row['name']);
    if (!id || !baseName) return undefined;
    const slug = text(row['Slug']) || id;
    const ext = extendedById.get(String(row['Extended info'] ?? ''));
    const override = FUND_PROFILE_OVERRIDES[slug] || {};
    return {
      id,
      slug,
      name: text(ext?.['full title']) || baseName,
      subtitle: text(ext?.['subtitle']),
      forTitle: text(ext?.['for title']),
      active: row['active'] !== false,
      available: maybeNum(row['Funding - current']),
      themes: uniqueSorted(override.themes || []),
      derivedThemes: [],
      aliases: uniqueSorted(override.aliases || []),
      preferredTerms: uniqueSorted(override.preferredTerms || []),
      excludedTerms: uniqueSorted(override.excludedTerms || []),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

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

  const projectById = new Map(projects.map((project) => [project.id, project]));
  const tagCountsByFund = new Map<string, Map<string, number>>();
  for (const relationship of relationships) {
    if (relationship.kind === 'submitted') continue;
    const project = projectById.get(relationship.projectId);
    if (!project) continue;
    let counts = tagCountsByFund.get(relationship.fundId);
    if (!counts) {
      counts = new Map();
      tagCountsByFund.set(relationship.fundId, counts);
    }
    for (const tag of project.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  for (const fund of funds) {
    const derived = [...(tagCountsByFund.get(fund.id) || new Map()).entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 16)
      .map(([tag]) => tag);
    fund.derivedThemes = uniqueSorted(derived);
  }

  const generatedAt = new Date().toISOString();
  const versionable = { projects, funds, relationships, scoring: DEFAULT_SCORING };
  const index: MatchIndexV1 = {
    schemaVersion: 1,
    indexVersion: await versionFor(versionable),
    generatedAt,
    ...versionable,
  };
  validateMatchIndex(index);
  return index;
}

export function validateMatchIndex(index: MatchIndexV1): void {
  if (index.schemaVersion !== 1) throw new Error('unsupported matching index schema');
  if (!index.indexVersion || !index.generatedAt) throw new Error('matching index version is missing');
  if (index.projects.length === 0 || index.funds.length === 0) throw new Error('matching index catalog is empty');

  const projectIds = new Set<string>();
  for (const project of index.projects) {
    if (!project.id || !project.slug || !project.name || projectIds.has(project.id)) {
      throw new Error(`invalid or duplicate matching project ${project.id}`);
    }
    projectIds.add(project.id);
  }
  const fundIds = new Set<string>();
  for (const fund of index.funds) {
    if (!fund.id || !fund.slug || !fund.name || fundIds.has(fund.id)) {
      throw new Error(`invalid or duplicate matching fund ${fund.id}`);
    }
    fundIds.add(fund.id);
  }
  for (const relationship of index.relationships) {
    if (!projectIds.has(relationship.projectId) || !fundIds.has(relationship.fundId)) {
      throw new Error('matching relationship references a missing record');
    }
  }
  const weight = index.scoring.contentWeight + index.scoring.tagWeight + index.scoring.graphWeight;
  if (Math.abs(weight - 1) > 0.0001) throw new Error('matching weights must total 1');
}
