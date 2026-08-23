import type {
  FundProfile,
  FundRecommendation,
  MatchIndexV1,
  MatchReason,
  MatchRelationshipKind,
  ProjectFundRelationship,
  ProjectMatchInput,
  ProjectProfile,
} from '../artizen/types';

const STOP_WORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'fund',
  'has',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'our',
  'project',
  'projects',
  'shared',
  'shar',
  'that',
  'the',
  'their',
  'this',
  'through',
  'to',
  'we',
  'with',
  'work',
  'works',
  'led',
]);

const KIND_STRENGTH: Record<MatchRelationshipKind, number> = {
  submitted: 0.5,
  curated: 0.85,
  funded: 1,
};

type Terms = Map<string, number>;

type PreparedFund = {
  fund: FundProfile;
  terms: Terms;
  tagKeys: Map<string, string>;
};

type PreparedProject = {
  project: ProjectProfile;
  terms: Terms;
  tagKeys: Set<string>;
};

export type PreparedMatchIndex = {
  index: MatchIndexV1;
  funds: PreparedFund[];
  projects: PreparedProject[];
  fundsById: Map<string, PreparedFund>;
  projectsById: Map<string, PreparedProject>;
  relationshipsByProject: Map<string, ProjectFundRelationship[]>;
  relationshipsByFund: Map<string, ProjectFundRelationship[]>;
  fundIdf: Map<string, number>;
  averageFundLength: number;
  projectIdf: Map<string, number>;
};

export type MatchResult = {
  sufficient: boolean;
  recommendations: FundRecommendation[];
};

export const MATCH_INDEX_STALE_MS = 26 * 60 * 60 * 1000;

export function isMatchIndexStale(
  index: Pick<MatchIndexV1, 'generatedAt'>,
  now = Date.now(),
  maxAgeMs = MATCH_INDEX_STALE_MS,
): boolean {
  const generatedAt = Date.parse(index.generatedAt);
  return !Number.isFinite(generatedAt) || now - generatedAt > maxAgeMs;
}

function stem(term: string): string {
  if (term.length <= 3) return term;
  if (term.endsWith('ies') && term.length > 4) return `${term.slice(0, -3)}y`;
  if (term.endsWith('ing') && term.length > 6) return term.slice(0, -3);
  if (term.endsWith('ed') && term.length > 5) return term.slice(0, -2);
  if (term.endsWith('es') && term.length > 5) return term.slice(0, -2);
  if (term.endsWith('s') && !term.endsWith('ss') && term.length > 4) return term.slice(0, -1);
  return term;
}

export function normalizeTerms(value: string): string[] {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[’']/g, '')
    .match(/[\p{L}\p{N}]+/gu)
    ?.map(stem)
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term)) || [];
}

function addText(terms: Terms, value: string | undefined, weight = 1): void {
  if (!value || !(weight > 0)) return;
  for (const term of normalizeTerms(value)) terms.set(term, (terms.get(term) || 0) + weight);
}

function tagKey(value: string): string {
  return normalizeTerms(value).join(' ');
}

function documentFrequency(documents: Terms[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const document of documents) {
    for (const term of document.keys()) counts.set(term, (counts.get(term) || 0) + 1);
  }
  const count = Math.max(1, documents.length);
  return new Map(
    [...counts].map(([term, frequency]) => [term, Math.log(1 + (count - frequency + 0.5) / (frequency + 0.5))]),
  );
}

function termLength(terms: Terms): number {
  let total = 0;
  for (const value of terms.values()) total += value;
  return total;
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
    const weighted = value * (idf.get(term) || 0);
    rightNorm += weighted * weighted;
    const leftValue = left.get(term);
    if (leftValue) dot += weighted * leftValue * (idf.get(term) || 0);
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

function bm25(query: Terms, document: Terms, idf: Map<string, number>, averageLength: number): number {
  const length = Math.max(1, termLength(document));
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const [term, queryWeight] of query) {
    const frequency = document.get(term) || 0;
    if (!(frequency > 0)) continue;
    const denominator = frequency + k1 * (1 - b + b * (length / Math.max(1, averageLength)));
    score += (idf.get(term) || 0) * ((frequency * (k1 + 1)) / denominator) * Math.min(2, queryWeight);
  }
  return score;
}

function relationshipMap(
  relationships: ProjectFundRelationship[],
  key: 'projectId' | 'fundId',
): Map<string, ProjectFundRelationship[]> {
  const result = new Map<string, ProjectFundRelationship[]>();
  for (const relationship of relationships) {
    const id = relationship[key];
    const rows = result.get(id) || [];
    rows.push(relationship);
    result.set(id, rows);
  }
  return result;
}

export function prepareMatchIndex(index: MatchIndexV1): PreparedMatchIndex {
  if (index.schemaVersion !== 1 || !Array.isArray(index.projects) || !Array.isArray(index.funds)) {
    throw new Error('Unsupported matching index');
  }
  const relationshipsByProject = relationshipMap(index.relationships, 'projectId');
  const relationshipsByFund = relationshipMap(index.relationships, 'fundId');
  const projects: PreparedProject[] = index.projects.map((project) => {
    const terms = new Map<string, number>();
    addText(terms, project.name, 1.4);
    addText(terms, project.description, 1);
    for (const tag of project.tags) addText(terms, tag, 2);
    return { project, terms, tagKeys: new Set(project.tags.map(tagKey).filter(Boolean)) };
  });
  const projectById = new Map(projects.map((project) => [project.project.id, project]));

  const funds: PreparedFund[] = index.funds.map((fund) => {
    const terms = new Map<string, number>();
    addText(terms, fund.name, 2);
    addText(terms, fund.subtitle, 1.5);
    addText(terms, fund.forTitle, 1.5);
    for (const theme of fund.themes) addText(terms, theme, 2);
    for (const theme of fund.derivedThemes || []) addText(terms, theme, 1.4);
    for (const alias of fund.aliases) addText(terms, alias, 1.5);
    for (const preferred of fund.preferredTerms) addText(terms, preferred, 2);

    const history = (relationshipsByFund.get(fund.id) || [])
      .filter((relationship) => relationship.kind !== 'submitted')
      .sort((a, b) => (b.seasonNumber || 0) - (a.seasonNumber || 0))
      .slice(0, index.scoring.fundHistoryLimit);
    const historyWeight = history.length ? 0.35 / Math.sqrt(history.length) : 0;
    for (const relationship of history) {
      const project = projectById.get(relationship.projectId)?.project;
      if (!project) continue;
      addText(terms, project.description, historyWeight);
      for (const tag of project.tags) addText(terms, tag, historyWeight * 2);
    }
    for (const excluded of fund.excludedTerms) {
      for (const term of normalizeTerms(excluded)) terms.delete(term);
    }
    const tagKeys = new Map<string, string>();
    for (const theme of [...fund.themes, ...(fund.derivedThemes || [])]) {
      const key = tagKey(theme);
      if (key) tagKeys.set(key, theme);
    }
    return { fund, terms, tagKeys };
  });
  const fundLengths = funds.map((fund) => termLength(fund.terms));
  return {
    index,
    funds,
    projects,
    fundsById: new Map(funds.map((fund) => [fund.fund.id, fund])),
    projectsById: projectById,
    relationshipsByProject,
    relationshipsByFund,
    fundIdf: documentFrequency(funds.map((fund) => fund.terms)),
    averageFundLength: fundLengths.reduce((sum, length) => sum + length, 0) / Math.max(1, fundLengths.length),
    projectIdf: documentFrequency(projects.map((project) => project.terms)),
  };
}

function inputTerms(input: ProjectMatchInput): Terms {
  const terms = new Map<string, number>();
  addText(terms, input.title, 1.4);
  addText(terms, input.description, 1);
  for (const tag of input.tags) addText(terms, tag, 2);
  return terms;
}

function tagOverlap(input: Set<string>, fund: Map<string, string>): { score: number; labels: string[] } {
  if (input.size === 0 || fund.size === 0) return { score: 0, labels: [] };
  const labels: string[] = [];
  for (const key of input) {
    const label = fund.get(key);
    if (label) labels.push(label);
  }
  const union = new Set([...input, ...fund.keys()]).size;
  return { score: union ? labels.length / union : 0, labels };
}

function maxNormalize(values: Map<string, number>): Map<string, number> {
  const max = Math.max(0, ...values.values());
  return new Map([...values].map(([key, value]) => [key, max > 0 ? value / max : 0]));
}

function knownRelationship(rows: ProjectFundRelationship[] | undefined, fundId: string): MatchRelationshipKind | undefined {
  const candidates = (rows || []).filter((row) => row.fundId === fundId).map((row) => row.kind);
  return candidates.sort((a, b) => KIND_STRENGTH[b] - KIND_STRENGTH[a])[0];
}

function readableTerm(term: string): string {
  const labels: Record<string, string> = {
    artist: 'Art',
    creat: 'Creative work',
    educat: 'Education',
    environ: 'Environment',
    film: 'Film',
    good: 'Public goods',
    govern: 'Governance',
    owned: 'Ownership',
    owner: 'Ownership',
    storytell: 'Storytelling',
  };
  return labels[term] || term.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function contentReason(query: Terms, document: Terms, idf: Map<string, number>): MatchReason | undefined {
  const shared = [...query.keys()]
    .filter((term) => document.has(term) && term.length > 2)
    .sort((a, b) => (idf.get(b) || 0) - (idf.get(a) || 0) || a.localeCompare(b))
    .slice(0, 3);
  const labels = [...new Set(shared.map(readableTerm))];
  return labels.length ? { kind: 'content', label: `Shared focus: ${labels.join(', ')}` } : undefined;
}

function relationshipReason(kind: MatchRelationshipKind | undefined): MatchReason | undefined {
  if (!kind) return undefined;
  const labels: Record<MatchRelationshipKind, string> = {
    submitted: 'This project previously submitted to this fund',
    curated: 'This project was previously curated by this fund',
    funded: 'This project previously received support from this fund',
  };
  return { kind: 'relationship', label: labels[kind] };
}

function fitFor(score: number, max: number): FundRecommendation['fit'] {
  if (score >= 0.25 && score >= max * 0.72) return 'strong';
  if (score >= 0.1 && score >= max * 0.38) return 'good';
  return 'exploratory';
}

export function matchFunds(prepared: PreparedMatchIndex, input: ProjectMatchInput): MatchResult {
  const query = inputTerms(input);
  const inputTagKeys = new Set(input.tags.map(tagKey).filter(Boolean));
  const directRows = input.projectId ? prepared.relationshipsByProject.get(input.projectId) || [] : [];
  const sufficient = query.size >= 2 || inputTagKeys.size > 0 || directRows.length > 0;
  if (!sufficient) return { sufficient: false, recommendations: [] };

  const rawContent = new Map<string, number>();
  const tagScores = new Map<string, number>();
  const tagLabels = new Map<string, string[]>();
  for (const candidate of prepared.funds) {
    rawContent.set(
      candidate.fund.id,
      bm25(query, candidate.terms, prepared.fundIdf, prepared.averageFundLength),
    );
    const overlap = tagOverlap(inputTagKeys, candidate.tagKeys);
    tagScores.set(candidate.fund.id, overlap.score);
    tagLabels.set(candidate.fund.id, overlap.labels);
  }
  const contentScores = maxNormalize(rawContent);

  const similarProjects = prepared.projects
    .filter((candidate) => candidate.project.id !== input.projectId)
    .map((candidate) => ({
      candidate,
      score: cosine(query, candidate.terms, prepared.projectIdf),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.project.name.localeCompare(b.candidate.project.name))
    .slice(0, prepared.index.scoring.similarProjectLimit);
  const neighborRaw = new Map<string, number>();
  const neighborEvidence = new Map<string, { name: string; score: number }>();
  const similarityTotal = similarProjects.reduce((sum, row) => sum + row.score, 0) || 1;
  for (const row of similarProjects) {
    for (const relationship of prepared.relationshipsByProject.get(row.candidate.project.id) || []) {
      const contribution = (row.score / similarityTotal) * KIND_STRENGTH[relationship.kind];
      neighborRaw.set(relationship.fundId, (neighborRaw.get(relationship.fundId) || 0) + contribution);
      const previous = neighborEvidence.get(relationship.fundId);
      if (!previous || contribution > previous.score) {
        neighborEvidence.set(relationship.fundId, { name: row.candidate.project.name, score: contribution });
      }
    }
  }
  const neighborScores = maxNormalize(neighborRaw);
  const graphScores = new Map<string, number>();
  for (const candidate of prepared.funds) {
    const direct = knownRelationship(directRows, candidate.fund.id);
    const neighbor = neighborScores.get(candidate.fund.id) || 0;
    graphScores.set(
      candidate.fund.id,
      direct
        ? prepared.index.scoring.directRelationshipShare * KIND_STRENGTH[direct] +
            (1 - prepared.index.scoring.directRelationshipShare) * neighbor
        : neighbor,
    );
  }

  const config = prepared.index.scoring;
  const signalWeights = {
    content: query.size > 0 && [...contentScores.values()].some((score) => score > 0) ? config.contentWeight : 0,
    tags: inputTagKeys.size > 0 && [...tagScores.values()].some((score) => score > 0) ? config.tagWeight : 0,
    graph: [...graphScores.values()].some((score) => score > 0) ? config.graphWeight : 0,
  };
  const weightTotal = signalWeights.content + signalWeights.tags + signalWeights.graph;
  if (!(weightTotal > 0)) return { sufficient: true, recommendations: [] };

  const scored = prepared.funds
    .map((candidate) => {
      const fundId = candidate.fund.id;
      const score =
        ((contentScores.get(fundId) || 0) * signalWeights.content +
          (tagScores.get(fundId) || 0) * signalWeights.tags +
          (graphScores.get(fundId) || 0) * signalWeights.graph) /
        weightTotal;
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score || a.candidate.fund.name.localeCompare(b.candidate.fund.name));
  const max = scored[0]?.score || 0;
  const recommendations: FundRecommendation[] = scored.map(({ candidate, score }) => {
    const fundId = candidate.fund.id;
    const known = knownRelationship(directRows, fundId);
    const reasons: Array<MatchReason | undefined> = [
      relationshipReason(known),
      ...(tagLabels.get(fundId) || []).slice(0, 1).map((tag) => ({
        kind: 'tag' as const,
        label: `Shared impact tag: ${tag}`,
      })),
      contentReason(query, candidate.terms, prepared.fundIdf),
      neighborEvidence.has(fundId)
        ? {
            kind: 'similar-project' as const,
            label: `Supports projects similar to ${neighborEvidence.get(fundId)!.name}`,
          }
        : undefined,
    ];
    const evidenceReasons = reasons.filter((reason): reason is MatchReason => Boolean(reason)).slice(0, 3);
    return {
      fundId,
      score,
      fit: fitFor(score, max),
      reasons: evidenceReasons.length
        ? evidenceReasons
        : [{ kind: 'limited-evidence', label: 'No strong alignment evidence found for this fund' }],
      knownRelationship: known,
      active: candidate.fund.active,
      available: candidate.fund.available,
    };
  });
  return { sufficient: true, recommendations };
}
