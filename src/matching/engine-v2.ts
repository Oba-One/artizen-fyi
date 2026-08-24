import type {
  FundProfileV2,
  FundRecommendationV2,
  MatchFit,
  MatchIndexV2,
  MatchReason,
  MatchRelationshipKind,
  MatchResultV2,
  ProjectFundRelationship,
  ProjectMatchInput,
  ScoreBreakdown,
} from '../artizen/types';
import { normalizeTerms } from './engine';
import { extractFacetIds, facetCategory, facetLabel } from './taxonomy';

type Terms = Map<string, number>;

type PreparedFundV2 = {
  fund: FundProfileV2;
  terms: Terms;
  facets: Set<string>;
  focusFacets: Set<string>;
};

export type PreparedMatchIndexV2 = {
  index: MatchIndexV2;
  funds: PreparedFundV2[];
  fundsById: Map<string, PreparedFundV2>;
  relationshipsByProject: Map<string, ProjectFundRelationship[]>;
  idf: Map<string, number>;
};

function addText(terms: Terms, value: string | undefined, weight = 1): void {
  if (!value || weight <= 0) return;
  for (const term of normalizeTerms(value)) terms.set(term, (terms.get(term) || 0) + weight);
}

function removeText(terms: Terms, value: string): void {
  for (const term of normalizeTerms(value)) terms.delete(term);
}

function documentFrequency(documents: Terms[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const document of documents) {
    for (const term of document.keys()) counts.set(term, (counts.get(term) || 0) + 1);
  }
  const count = Math.max(1, documents.length);
  return new Map(
    [...counts].map(([term, frequency]) => [term, Math.log(1 + count / Math.max(1, frequency))]),
  );
}

function cosine(left: Terms, right: Terms, idf: Map<string, number>): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const [term, value] of left) {
    const weighted = value * (idf.get(term) || 0);
    leftNorm += weighted * weighted;
  }
  for (const [term, value] of right) {
    const idfValue = idf.get(term) || 0;
    const weighted = value * idfValue;
    rightNorm += weighted * weighted;
    dot += weighted * (left.get(term) || 0) * idfValue;
  }
  if (!(leftNorm > 0) || !(rightNorm > 0)) return 0;
  return Math.max(0, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)));
}

/**
 * Per-project history is the canonical source; the flat relationship table is the fallback for
 * indexes built before histories existed. The split payloads carry only the histories, so a
 * browser that has fetched one project still gets that project's badges.
 *
 * The fallback is decided per project rather than for the index as a whole. A single project
 * carrying a history would otherwise switch the whole index onto that source and silently strip
 * the badges from every project that only appears in the table.
 */
function relationshipMap(index: MatchIndexV2): Map<string, ProjectFundRelationship[]> {
  const result = new Map<string, ProjectFundRelationship[]>();
  for (const project of index.projects) {
    if (!project.history?.length) continue;
    result.set(
      project.id,
      project.history.map(([fundId, kind]) => ({ projectId: project.id, fundId, kind })),
    );
  }
  const fromHistory = new Set(result.keys());
  for (const relationship of index.relationships || []) {
    if (fromHistory.has(relationship.projectId)) continue;
    const rows = result.get(relationship.projectId) || [];
    rows.push(relationship);
    result.set(relationship.projectId, rows);
  }
  return result;
}

export function prepareMatchIndexV2(index: MatchIndexV2): PreparedMatchIndexV2 {
  if (index.schemaVersion !== 2 || !Array.isArray(index.projects) || !Array.isArray(index.funds)) {
    throw new Error('Unsupported matching v2 index');
  }
  const funds = index.funds.map((fund) => {
    const terms = new Map<string, number>();
    addText(terms, fund.name, 2);
    addText(terms, fund.subtitle, 1.25);
    addText(terms, fund.forTitle, 1.75);
    for (const theme of fund.themes) addText(terms, theme, 1.5);
    for (const alias of fund.aliases) addText(terms, alias, 1.25);
    for (const preferred of fund.preferredTerms) addText(terms, preferred, 1.75);
    for (const excluded of fund.excludedTerms) removeText(terms, excluded);
    return {
      fund,
      terms,
      facets: new Set(fund.facets),
      focusFacets: new Set(fund.focusFacets),
    };
  });
  return {
    index,
    funds,
    fundsById: new Map(funds.map((candidate) => [candidate.fund.id, candidate])),
    relationshipsByProject: relationshipMap(index),
    idf: documentFrequency(funds.map((fund) => fund.terms)),
  };
}

function inputTerms(input: ProjectMatchInput): Terms {
  const terms = new Map<string, number>();
  addText(terms, input.title, 1.4);
  addText(terms, input.description, 1);
  for (const tag of input.tags) addText(terms, tag, 1.8);
  return terms;
}

function disambiguateProjectInput(input: ProjectMatchInput): ProjectMatchInput {
  const clean = (value: string | undefined) => value?.replace(/\bsoil health\b/gi, 'soil vitality');
  return {
    ...input,
    title: clean(input.title),
    description: clean(input.description) || '',
    tags: input.tags.map((tag) => clean(tag) || tag),
  };
}

const FACET_WEIGHTS: Record<string, number> = {
  domain: 1,
  medium: 1.15,
  approach: 0.8,
  audience: 0.75,
  place: 0.65,
};

function facetWeight(id: string): number {
  return FACET_WEIGHTS[facetCategory(id) || 'domain'] || 1;
}

function facetAlignment(
  input: Set<string>,
  fund: Set<string>,
  focus: Set<string>,
): { score: number; shared: string[]; supportedFocus: boolean } {
  const shared = [...input].filter((id) => fund.has(id));
  const overlapWeight = shared.reduce((sum, id) => sum + facetWeight(id), 0);
  const inputWeight = [...input].reduce((sum, id) => sum + facetWeight(id), 0);
  const fundWeight = [...fund].reduce((sum, id) => sum + facetWeight(id), 0);
  const projectPrecision = inputWeight > 0 ? overlapWeight / inputWeight : 0;
  const fundCoverage = fundWeight > 0 ? overlapWeight / fundWeight : 0;
  const balancedOverlap =
    projectPrecision + fundCoverage > 0
      ? (2 * projectPrecision * fundCoverage) / (projectPrecision + fundCoverage)
      : 0;
  const focusWeight = [...focus].reduce((sum, id) => sum + facetWeight(id), 0);
  const focusOverlap = [...focus]
    .filter((id) => input.has(id))
    .reduce((sum, id) => sum + facetWeight(id), 0);
  const focusCoverage = focusWeight > 0 ? focusOverlap / focusWeight : 0;
  return {
    score: focus.size > 0 ? focusCoverage * 0.7 + fundCoverage * 0.2 + projectPrecision * 0.1 : balancedOverlap,
    shared: shared.sort(
      (a, b) => Number(focus.has(b)) - Number(focus.has(a)) || facetWeight(b) - facetWeight(a) || a.localeCompare(b),
    ),
    supportedFocus: focus.size === 0 || focusOverlap > 0,
  };
}

function normalizedInputPhrases(input: ProjectMatchInput): Set<string> {
  const terms = normalizeTerms([input.title, input.description, ...input.tags].filter(Boolean).join(' '));
  const phrases = new Set(terms);
  for (let index = 0; index < terms.length - 1; index += 1) phrases.add(`${terms[index]} ${terms[index + 1]}`);
  return phrases;
}

function coreCoverage(inputPhrases: Set<string>, concepts: string[]): { score: number; matched: string[] } {
  if (concepts.length === 0) return { score: 0, matched: [] };
  const matched = concepts.filter((concept) => inputPhrases.has(concept));
  return { score: matched.length / concepts.length, matched };
}

const RELATIONSHIP_STRENGTH: Record<MatchRelationshipKind, number> = {
  submitted: 1,
  curated: 2,
  funded: 3,
};

function knownRelationship(rows: ProjectFundRelationship[] | undefined, fundId: string): MatchRelationshipKind | undefined {
  return (rows || [])
    .filter((row) => row.fundId === fundId)
    .map((row) => row.kind)
    .sort((a, b) => RELATIONSHIP_STRENGTH[b] - RELATIONSHIP_STRENGTH[a])[0];
}

function readableConcept(value: string): string {
  const replacements: Record<string, string> = {
    agroforestry: 'Agroforestry',
    desci: 'DeSci',
    educat: 'Education',
    environ: 'Environment',
    film: 'Film',
    govern: 'Governance',
    decentraliz: 'Decentralized',
  };
  return value
    .split(' ')
    .map((word) => replacements[word] || word.replace(/\b\w/g, (letter) => letter.toUpperCase()))
    .join(' ');
}

const GENERIC_REASON_TERMS = new Set([
  'action',
  'art',
  'build',
  'community',
  'creat',
  'creative',
  'environment',
  'fund',
  'help',
  'impact',
  'initiative',
  'local',
  'open',
  'people',
  'project',
  'research',
  'researcher',
  'support',
]);

function contentReason(query: Terms, fund: Terms, idf: Map<string, number>): MatchReason | undefined {
  const shared = specificSharedTerms(query, fund, idf).slice(0, 3).map(readableConcept);
  return shared.length ? { kind: 'content', label: `Shared language: ${shared.join(', ')}` } : undefined;
}

function specificSharedTerms(query: Terms, fund: Terms, idf: Map<string, number>): string[] {
  return [...query.keys()]
    .filter((term) => term.length > 2 && !GENERIC_REASON_TERMS.has(term) && fund.has(term))
    .sort((a, b) => (idf.get(b) || 0) - (idf.get(a) || 0) || a.localeCompare(b));
}

function fitFor(score: number, supportedFocus: boolean, definingEvidence: boolean, index: MatchIndexV2): MatchFit {
  const config = index.scoring;
  if ((!supportedFocus || !definingEvidence) && score >= config.exploratoryThreshold) return 'exploratory';
  if (score >= config.strongThreshold) return 'strong';
  if (score >= config.goodThreshold) return 'good';
  if (score >= config.exploratoryThreshold) return 'exploratory';
  return 'limited';
}

const GENERIC_ALIGNMENT_FACETS = new Set([
  'domain:arts-media',
  'domain:climate-ecology',
  'domain:community-economy',
  'domain:culture-identity',
]);

function baselineScore(breakdown: ScoreBreakdown, index: MatchIndexV2): number {
  const config = index.scoring;
  return (
    breakdown.lexical * config.lexicalWeight +
    breakdown.facets * config.facetWeight +
    breakdown.coreCoverage * config.coreCoverageWeight
  );
}

function semanticScore(breakdown: ScoreBreakdown, index: MatchIndexV2): number {
  const config = index.scoring;
  return (
    (breakdown.semantic || 0) * config.semanticWeight +
    breakdown.facets * config.semanticFacetWeight +
    breakdown.coreCoverage * config.semanticCoreCoverageWeight +
    breakdown.lexical * config.semanticLexicalWeight
  );
}

export function matchFundsV2(
  prepared: PreparedMatchIndexV2,
  input: ProjectMatchInput,
  semanticScores?: Map<string, number>,
): MatchResultV2 {
  const scoringInput = disambiguateProjectInput(input);
  const query = inputTerms(scoringInput);
  const inputFacets = new Set(extractFacetIds(scoringInput.title, scoringInput.description, scoringInput.tags.join(' ')));
  const inputPhrases = normalizedInputPhrases(scoringInput);
  const specificTerms = [...query.keys()].filter((term) => !GENERIC_REASON_TERMS.has(term));
  const sufficient =
    specificTerms.length >= 2 || [...inputFacets].some((facetId) => !GENERIC_ALIGNMENT_FACETS.has(facetId));
  if (!sufficient) return { sufficient: false, recommendations: [], mode: semanticScores ? 'semantic' : 'baseline' };

  const rows = prepared.funds.map((candidate) => {
    const alignment = facetAlignment(inputFacets, candidate.facets, candidate.focusFacets);
    const coverage = coreCoverage(inputPhrases, candidate.fund.coreConcepts);
    const semantic = semanticScores?.get(candidate.fund.id);
    const breakdown: ScoreBreakdown = {
      lexical: cosine(query, candidate.terms, prepared.idf),
      facets: alignment.score,
      coreCoverage: coverage.score,
      ...(semantic == null ? {} : { semantic: Math.max(0, Math.min(1, semantic)) }),
    };
    const combined = semantic == null ? baselineScore(breakdown, prepared.index) : semanticScore(breakdown, prepared.index);
    const score = alignment.supportedFocus
      ? combined
      : combined * prepared.index.scoring.unsupportedFocusPenalty;
    const definingEvidence =
      alignment.shared.some((facetId) => !GENERIC_ALIGNMENT_FACETS.has(facetId)) ||
      coverage.matched.length > 0 ||
      specificSharedTerms(query, candidate.terms, prepared.idf).length > 0;
    return { candidate, alignment, coverage, breakdown, score, definingEvidence };
  });

  rows.sort((a, b) => b.score - a.score || a.candidate.fund.name.localeCompare(b.candidate.fund.name));
  const directRows = input.projectId ? prepared.relationshipsByProject.get(input.projectId) || [] : [];
  const recommendations: FundRecommendationV2[] = rows.map(({ candidate, alignment, coverage, breakdown, score, definingEvidence }) => {
    const known = knownRelationship(directRows, candidate.fund.id);
    const reasons: Array<MatchReason | undefined> = [
      alignment.shared.length
        ? {
            kind: 'facet',
            label: `Shared focus: ${alignment.shared.slice(0, 2).map(facetLabel).join(', ')}`,
          }
        : undefined,
      coverage.matched.length
        ? {
            kind: 'core-concept',
            label: `Specific overlap: ${coverage.matched.slice(0, 2).map(readableConcept).join(', ')}`,
          }
        : undefined,
      contentReason(query, candidate.terms, prepared.idf),
      breakdown.semantic != null && breakdown.semantic >= 0.6
        ? { kind: 'semantic', label: 'The project description is similar to this fund’s stated focus' }
        : undefined,
    ];
    const evidence = reasons.filter((reason): reason is MatchReason => Boolean(reason)).slice(0, 3);
    return {
      fundId: candidate.fund.id,
      score,
      fit: fitFor(score, alignment.supportedFocus, definingEvidence, prepared.index),
      reasons: evidence.length
        ? evidence
        : [{ kind: 'limited-evidence', label: 'No clear alignment evidence found for this fund' }],
      knownRelationship: known,
      active: candidate.fund.active,
      available: candidate.fund.available,
      breakdown,
      supportedFocus: alignment.supportedFocus,
    };
  });
  return { sufficient: true, recommendations, mode: semanticScores ? 'semantic' : 'baseline' };
}
