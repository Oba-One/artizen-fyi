import type {
  FundProfile,
  FundRecommendation,
  MatchFit,
  MatchIndex,
  MatchReason,
  MatchRelationshipKind,
  MatchResult,
  ProjectFundRelationship,
  ProjectMatchInput,
  ScoreBreakdown,
  ScoringConfig,
} from '../artizen/types';
import { normalizeTerms } from './terms';
import { extractFacetIds, facetCategory, facetLabel } from './taxonomy';

type Terms = Map<string, number>;

type PreparedExclusion = {
  terms: Terms;
  phrases: string[];
  qualifierPhrases: string[];
  requiredTerms: string[];
  requiredPhrases: string[];
  scorable: boolean;
  singleTerm?: string;
};

type PreparedFund = {
  fund: FundProfile;
  terms: Terms;
  eligibilityTerms: Terms;
  exclusionTerms: Terms;
  exclusions: PreparedExclusion[];
  facets: Set<string>;
  focusFacets: Set<string>;
};

export type PreparedMatchIndex = {
  index: MatchIndex;
  funds: PreparedFund[];
  fundsById: Map<string, PreparedFund>;
  relationshipsByProject: Map<string, ProjectFundRelationship[]>;
  idf: Map<string, number>;
  eligibilityIdf: Map<string, number>;
  exclusionIdf: Map<string, number>;
};

function addText(terms: Terms, value: string | undefined, weight = 1): void {
  if (!value || weight <= 0) return;
  for (const term of normalizeTerms(value)) terms.set(term, (terms.get(term) || 0) + weight);
}

function addTerms(terms: Terms, values: string[]): void {
  for (const term of values) terms.set(term, (terms.get(term) || 0) + 1);
}

function removeText(terms: Terms, value: string): void {
  for (const term of normalizeTerms(value)) terms.delete(term);
}

function adjacentPhrases(values: Array<string | undefined>): Set<string> {
  const phrases = new Set<string>();
  for (const value of values) {
    const terms = normalizeTerms(value || '');
    for (let index = 0; index < terms.length - 1; index += 1) {
      phrases.add(`${terms[index]} ${terms[index + 1]}`);
    }
  }
  return phrases;
}

const EXCLUSION_POLICY_TERMS = new Set([
  'also',
  'cant',
  'cannot',
  'current',
  'do',
  'eligible',
  'eligibility',
  'exclud',
  'fit',
  'former',
  'ineligible',
  'may',
  'must',
  'no',
  'not',
  'out',
  'outside',
  'past',
  'qualify',
  'scope',
  'should',
  'within',
  'without',
  'year',
]);

function exclusionContentTerms(value: string): string[] {
  return normalizeTerms(value).filter((term) => !EXCLUSION_POLICY_TERMS.has(term));
}

function exclusionCoreText(value: string): string {
  let core = value.split(/\b(?:unless|except when|provided that)\b/i, 1)[0].trim();
  const colon = core.indexOf(':');
  if (colon < 0) return core;
  const prefix = core.slice(0, colon).trim();
  const suffix = core.slice(colon + 1).trim();
  if (
    /^(?:not eligible|ineligible|out of scope|also out)\b/i.test(prefix) ||
    /\b(?:not eligible|ineligible)\b.*\bfund\b/i.test(prefix)
  ) {
    return suffix;
  }
  return exclusionContentTerms(prefix).length > 0 ? prefix : suffix;
}

function phrasesFromTerms(terms: string[]): string[] {
  return terms.slice(0, -1).map((term, index) => `${term} ${terms[index + 1]}`);
}

function exclusionRequiredTerms(value: string): string[] {
  const terms = new Set<string>();
  for (const match of value.matchAll(/\b(?:no|not(?:\s+(?:a|an|for))?)\s+([\p{L}\p{N}'’-]+)/giu)) {
    const [term] = exclusionContentTerms(match[1]);
    if (term) terms.add(term);
  }
  return [...terms];
}

function exclusionRequiredPhrases(value: string): string[] {
  const relative = value.search(/\b(?:that|which|whose)\b/i);
  if (relative < 0) return [];
  const subject = value.slice(0, relative);
  const terms = exclusionContentTerms(subject);
  return terms.length >= 3 ? phrasesFromTerms(terms) : [];
}

// Directional words reverse the nearby subject: mentioning Kenya does not satisfy "outside
// Kenya", and having a fiscal sponsor does not satisfy "without a fiscal sponsor". Preserve the
// smallest ordered phrase needed to prove that the project describes the excluded side.
function exclusionQualifierPhrases(value: string): string[] {
  const phrases = new Set<string>();
  const directional =
    /\b(?:outside(?:\s+of)?|without)\s+(?:(?:a|an|the)\s+)?[\p{L}\p{N}][\p{L}\p{N}'’-]*/giu;
  for (const match of value.matchAll(directional)) {
    const terms = normalizeTerms(match[0]);
    if (terms.length >= 2) phrases.add(`${terms[0]} ${terms[1]}`);
  }
  const negatedProperty = /\bnot\s+(?:based|located|operating|registered|living|working)\b/giu;
  for (const match of value.matchAll(negatedProperty)) {
    const terms = normalizeTerms(match[0]);
    if (terms.length >= 2) phrases.add(`${terms[0]} ${terms[1]}`);
  }
  return [...phrases];
}

function documentFrequency(documents: Terms[]): Map<string, number> {
  const populated = documents.filter((document) => document.size > 0);
  const counts = new Map<string, number>();
  for (const document of populated) {
    for (const term of document.keys()) counts.set(term, (counts.get(term) || 0) + 1);
  }
  const count = Math.max(1, populated.length);
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
function relationshipMap(index: MatchIndex): Map<string, ProjectFundRelationship[]> {
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

/**
 * Matching catalogs are immutable release assets, not hourly cache entries. A month without a
 * catalog-building deployment is old enough to flag as an operational freshness issue without
 * warning every visitor the day after a healthy release.
 */
export const MATCH_INDEX_STALE_MS = 30 * 24 * 60 * 60 * 1000;

export function isMatchIndexStale(
  index: Pick<MatchIndex, 'generatedAt'>,
  now = Date.now(),
  maxAgeMs = MATCH_INDEX_STALE_MS,
): boolean {
  const generatedAt = Date.parse(index.generatedAt);
  return !Number.isFinite(generatedAt) || now - generatedAt > maxAgeMs;
}

export function prepareMatchIndex(index: MatchIndex): PreparedMatchIndex {
  if (index.schemaVersion !== 2 || !Array.isArray(index.projects) || !Array.isArray(index.funds)) {
    throw new Error('Unsupported matching v2 index');
  }
  const funds = index.funds.map((fund) => {
    const terms = new Map<string, number>();
    const eligibilityTerms = new Map<string, number>();
    const exclusionTerms = new Map<string, number>();
    addText(terms, fund.name, 2);
    addText(terms, fund.subtitle, 1.25);
    addText(terms, fund.forTitle, 1.75);
    addText(terms, fund.description, 1);
    for (const criterion of fund.eligibilityCriteria || []) addText(eligibilityTerms, criterion);
    const exclusions = (fund.eligibilityExclusions || []).map((exclusion) => {
      const core = exclusionCoreText(exclusion);
      const contentTerms = exclusionContentTerms(core);
      const clauseTerms = new Map<string, number>();
      addTerms(clauseTerms, contentTerms);
      addTerms(exclusionTerms, contentTerms);
      const explicitlyNegative = /^\s*(?:no|not)\b/i.test(core) || /\b(?:is|are)\s+not[.!?]*$/i.test(core);
      return {
        terms: clauseTerms,
        phrases: phrasesFromTerms(contentTerms),
        qualifierPhrases: exclusionQualifierPhrases(core),
        requiredTerms: exclusionRequiredTerms(core),
        requiredPhrases: exclusionRequiredPhrases(core),
        scorable: !contentTerms.some((term) => /\d/.test(term)),
        ...(explicitlyNegative && contentTerms.length === 1 ? { singleTerm: contentTerms[0] } : {}),
      };
    });
    for (const theme of fund.themes) addText(terms, theme, 1.5);
    for (const alias of fund.aliases) addText(terms, alias, 1.25);
    for (const preferred of fund.preferredTerms) addText(terms, preferred, 1.75);
    for (const excluded of fund.excludedTerms) removeText(terms, excluded);
    return {
      fund,
      terms,
      eligibilityTerms,
      exclusionTerms,
      exclusions,
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
    eligibilityIdf: documentFrequency(funds.map((fund) => fund.eligibilityTerms)),
    exclusionIdf: documentFrequency(funds.map((fund) => fund.exclusionTerms)),
  };
}

function inputTerms(input: ProjectMatchInput): Terms {
  const terms = new Map<string, number>();
  addText(terms, input.title, 1.4);
  addText(terms, input.description, 1);
  addText(terms, input.context?.description, 1);
  addText(terms, input.context?.impact, 1);
  for (const tag of input.tags) addText(terms, tag, 1.8);
  return terms;
}

function eligibilityInputTerms(input: ProjectMatchInput): Terms {
  const terms = inputTerms(input);
  addText(terms, input.context?.progress, 0.75);
  addText(terms, input.context?.team, 0.75);
  return terms;
}

function eligibilityInputPhrases(input: ProjectMatchInput): Set<string> {
  return adjacentPhrases([
    input.title,
    input.description,
    ...input.tags,
    input.context?.description,
    input.context?.impact,
    input.context?.progress,
    input.context?.team,
  ]);
}

function disambiguateProjectInput(input: ProjectMatchInput): ProjectMatchInput {
  const clean = (value: string | undefined) => value?.replace(/\bsoil health\b/gi, 'soil vitality');
  return {
    ...input,
    title: clean(input.title),
    description: clean(input.description) || '',
    tags: input.tags.map((tag) => clean(tag) || tag),
    context: input.context
      ? {
          description: clean(input.context.description),
          impact: clean(input.context.impact),
          progress: clean(input.context.progress),
          team: clean(input.context.team),
        }
      : undefined,
  };
}

const FACET_WEIGHTS: Record<string, number> = {
  domain: 1,
  medium: 1.15,
  approach: 0.8,
  audience: 0.75,
  place: 0.65,
};

const DISTINCTIVE_APPROACH_FACETS = new Set([
  'approach:circular-economy',
  'approach:systems-change',
]);

function facetWeight(id: string): number {
  return FACET_WEIGHTS[facetCategory(id) || 'domain'] || 1;
}

function facetAlignment(
  input: Set<string>,
  fund: Set<string>,
  focus: Set<string>,
): { score: number; shared: string[]; supportedFocus: boolean; distinctiveApproach: boolean } {
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
  const baseScore =
    focus.size > 0 ? focusCoverage * 0.7 + fundCoverage * 0.2 + projectPrecision * 0.1 : balancedOverlap;
  // These two approaches bridge language that otherwise looks unrelated (for example,
  // regenerative economics and internalized externalities). They deliberately remain ordinary
  // facets rather than hard focus guards. Exact overlap is carried into the shared post-channel
  // adjustment so the bonus is not diluted by the facet channel's weight.
  const hasDistinctiveApproach = shared.some((id) => DISTINCTIVE_APPROACH_FACETS.has(id));
  return {
    score: baseScore,
    shared: shared.sort(
      (a, b) => Number(focus.has(b)) - Number(focus.has(a)) || facetWeight(b) - facetWeight(a) || a.localeCompare(b),
    ),
    supportedFocus: focus.size === 0 || focusOverlap > 0,
    distinctiveApproach: hasDistinctiveApproach,
  };
}

function normalizedInputPhrases(input: ProjectMatchInput): Set<string> {
  const terms = normalizeTerms(
    [
      input.title,
      input.description,
      input.context?.description,
      input.context?.impact,
      ...input.tags,
    ]
      .filter(Boolean)
      .join(' '),
  );
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
  'chain',
  'community',
  'creat',
  'creative',
  'environment',
  'fund',
  'help',
  'impact',
  'initiative',
  'local',
  'need',
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

function exclusionMatch(
  query: Terms,
  phrases: Set<string>,
  exclusions: PreparedExclusion[],
  idf: Map<string, number>,
): { risk: number; terms: string[] } {
  let best = { risk: 0, terms: [] as string[] };
  for (const exclusion of exclusions) {
    if (!exclusion.scorable) continue;
    if (exclusion.requiredTerms.length > 0 && !exclusion.requiredTerms.some((term) => query.has(term))) {
      continue;
    }
    if (exclusion.requiredPhrases.some((phrase) => !phrases.has(phrase))) continue;
    // Exclusion warnings are cautious review signals. If an exclusion contains a directional
    // condition, unordered overlap is not enough to assert that the project meets that condition.
    if (
      exclusion.qualifierPhrases.length > 0 &&
      !exclusion.qualifierPhrases.some((phrase) => phrases.has(phrase))
    ) {
      continue;
    }
    const shared = specificSharedTerms(query, exclusion.terms, idf);
    const singleTermMatch = exclusion.singleTerm != null && query.has(exclusion.singleTerm);
    const phraseMatch = exclusion.phrases.some((phrase) => phrases.has(phrase));
    if (!singleTermMatch && (shared.length < 2 || !phraseMatch)) continue;
    const similarity = cosine(query, exclusion.terms, idf);
    if (similarity >= 0.18 && similarity > best.risk) {
      best = { risk: similarity, terms: singleTermMatch ? [exclusion.singleTerm!] : shared };
    }
  }
  return best;
}

function fitFor(score: number, supportedFocus: boolean, definingEvidence: boolean, index: MatchIndex): MatchFit {
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

function baselineScore(breakdown: ScoreBreakdown, config: ScoringConfig): number {
  return (
    breakdown.lexical * config.lexicalWeight +
    breakdown.facets * config.facetWeight +
    breakdown.coreCoverage * config.coreCoverageWeight
  );
}

function semanticScore(breakdown: ScoreBreakdown, config: ScoringConfig): number {
  return (
    (breakdown.semantic || 0) * config.semanticWeight +
    breakdown.facets * config.semanticFacetWeight +
    breakdown.coreCoverage * config.semanticCoreCoverageWeight +
    breakdown.lexical * config.semanticLexicalWeight
  );
}

/** Eligibility may reorder peers, but published criteria alone cannot promote a fit label. */
function eligibilityBandCeiling(score: number, config: ScoringConfig): number | undefined {
  if (score < config.exploratoryThreshold) return config.exploratoryThreshold;
  if (score < config.goodThreshold) return config.goodThreshold;
  if (score < config.strongThreshold) return config.strongThreshold;
}

export function adjustMatchScore(
  score: number,
  breakdown: Pick<ScoreBreakdown, 'distinctiveApproach' | 'eligibility' | 'exclusionRisk'>,
  supportedFocus: boolean,
  config: ScoringConfig,
): number {
  const distinctiveApproachBoost = config.distinctiveApproachBoost ?? 0.25;
  const topicalScore =
    score + (1 - score) * distinctiveApproachBoost * (breakdown.distinctiveApproach || 0);
  const eligibility = breakdown.eligibility || 0;
  const eligibilityBoost = config.eligibilityBoost ?? 0.15;
  const boosted = topicalScore + (1 - topicalScore) * eligibilityBoost * eligibility;
  const ceiling = eligibilityBandCeiling(topicalScore, config);
  const bandCap = ceiling == null ? undefined : Math.max(topicalScore, ceiling - 1e-9);
  const eligibilityAdjusted = bandCap == null ? boosted : Math.min(boosted, bandCap);
  const focusAdjusted = supportedFocus
    ? eligibilityAdjusted
    : eligibilityAdjusted * config.unsupportedFocusPenalty;
  const exclusionPenalty = config.exclusionPenalty ?? 0.2;
  return focusAdjusted * (1 - exclusionPenalty * (breakdown.exclusionRisk || 0));
}

export function semanticRecommendationScore(
  breakdown: ScoreBreakdown,
  supportedFocus: boolean,
  config: ScoringConfig,
): number {
  return adjustMatchScore(semanticScore(breakdown, config), breakdown, supportedFocus, config);
}

export function matchFunds(
  prepared: PreparedMatchIndex,
  input: ProjectMatchInput,
  semanticScores?: Map<string, number>,
): MatchResult {
  const scoringInput = disambiguateProjectInput(input);
  const query = inputTerms(scoringInput);
  const eligibilityQuery = eligibilityInputTerms(scoringInput);
  const eligibilityPhrases = eligibilityInputPhrases(scoringInput);
  const inputFacets = new Set(
    extractFacetIds(
      scoringInput.title,
      scoringInput.description,
      scoringInput.context?.description,
      scoringInput.context?.impact,
      scoringInput.tags.join(' '),
    ),
  );
  const inputPhrases = normalizedInputPhrases(scoringInput);
  const specificTerms = [...query.keys()].filter((term) => !GENERIC_REASON_TERMS.has(term));
  const sufficient =
    specificTerms.length >= 2 || [...inputFacets].some((facetId) => !GENERIC_ALIGNMENT_FACETS.has(facetId));
  if (!sufficient) return { sufficient: false, recommendations: [], mode: semanticScores ? 'semantic' : 'baseline' };

  const rows = prepared.funds.map((candidate) => {
    const alignment = facetAlignment(inputFacets, candidate.facets, candidate.focusFacets);
    const coverage = coreCoverage(inputPhrases, candidate.fund.coreConcepts);
    const semantic = semanticScores?.get(candidate.fund.id);
    const eligibilitySimilarity = cosine(eligibilityQuery, candidate.eligibilityTerms, prepared.eligibilityIdf);
    const sharedEligibilityTerms = specificSharedTerms(
      eligibilityQuery,
      candidate.eligibilityTerms,
      prepared.eligibilityIdf,
    );
    const eligibility =
      sharedEligibilityTerms.length >= 2 && eligibilitySimilarity >= 0.18 ? eligibilitySimilarity : 0;
    const eligibilityEvidence = eligibility ? sharedEligibilityTerms : [];
    const exclusion = exclusionMatch(
      eligibilityQuery,
      eligibilityPhrases,
      candidate.exclusions,
      prepared.exclusionIdf,
    );
    const exclusionRisk = exclusion.risk;
    const exclusionTerms = exclusion.terms;
    const breakdown: ScoreBreakdown = {
      lexical: cosine(query, candidate.terms, prepared.idf),
      facets: alignment.score,
      coreCoverage: coverage.score,
      ...(alignment.distinctiveApproach ? { distinctiveApproach: 1 } : {}),
      ...(candidate.eligibilityTerms.size ? { eligibility } : {}),
      ...(candidate.exclusionTerms.size ? { exclusionRisk } : {}),
      ...(semantic == null ? {} : { semantic: Math.max(0, Math.min(1, semantic)) }),
    };
    const combined =
      semantic == null
        ? baselineScore(breakdown, prepared.index.scoring)
        : semanticScore(breakdown, prepared.index.scoring);
    const score = adjustMatchScore(combined, breakdown, alignment.supportedFocus, prepared.index.scoring);
    const definingEvidence =
      alignment.shared.some((facetId) => !GENERIC_ALIGNMENT_FACETS.has(facetId)) ||
      coverage.matched.length > 0 ||
      specificSharedTerms(query, candidate.terms, prepared.idf).length > 0 ||
      eligibilityEvidence.length > 0;
    return {
      candidate,
      alignment,
      coverage,
      breakdown,
      score,
      definingEvidence,
      eligibilityEvidence,
      exclusionTerms,
      exclusionRisk,
    };
  });

  rows.sort((a, b) => b.score - a.score || a.candidate.fund.name.localeCompare(b.candidate.fund.name));
  const directRows = input.projectId ? prepared.relationshipsByProject.get(input.projectId) || [] : [];
  const recommendations: FundRecommendation[] = rows.map(({
    candidate,
    alignment,
    coverage,
    breakdown,
    score,
    definingEvidence,
    eligibilityEvidence,
    exclusionTerms,
    exclusionRisk,
  }) => {
    const known = knownRelationship(directRows, candidate.fund.id);
    const focusedReasons = alignment.shared.filter((facetId) => candidate.focusFacets.has(facetId));
    const reasonFacets = focusedReasons.length ? focusedReasons : alignment.shared;
    const reasons: Array<MatchReason | undefined> = [
      reasonFacets.length
        ? {
            kind: 'facet',
            label: `Shared focus: ${reasonFacets.slice(0, 2).map(facetLabel).join(', ')}`,
          }
        : undefined,
      coverage.matched.length
        ? {
            kind: 'core-concept',
            label: `Specific overlap: ${coverage.matched.slice(0, 2).map(readableConcept).join(', ')}`,
          }
        : undefined,
      eligibilityEvidence.length
        ? {
            kind: 'eligibility',
            label: `Published criteria overlap: ${eligibilityEvidence.slice(0, 3).map(readableConcept).join(', ')}`,
          }
        : breakdown.eligibility != null && breakdown.eligibility >= 0.25
          ? { kind: 'eligibility', label: 'The project aligns with this fund’s published criteria' }
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
      warnings: exclusionRisk
        ? [
            {
              kind: 'eligibility-exclusion',
              label: `Review this fund’s exclusions: shared language includes ${exclusionTerms
                .slice(0, 3)
                .map(readableConcept)
                .join(', ')}`,
            },
          ]
        : undefined,
      knownRelationship: known,
      active: candidate.fund.active,
      available: candidate.fund.available,
      breakdown,
      supportedFocus: alignment.supportedFocus,
    };
  });
  return { sufficient: true, recommendations, mode: semanticScores ? 'semantic' : 'baseline' };
}
