import type {
  MatchIndexV1,
  ProjectFundRelationship,
  ProjectMatchInput,
  ScoringConfig,
} from '../artizen/types';
import { matchFunds, prepareMatchIndex } from './engine';

export type EvaluationMetrics = {
  cases: number;
  recallAt7: number;
  ndcgAt7: number;
  mrr: number;
};

export type MatchingEvaluation = {
  hybrid: EvaluationMetrics;
  contentOnly: EvaluationMetrics;
  graphOnly: EvaluationMetrics;
};

function newest(left: ProjectFundRelationship, right: ProjectFundRelationship): number {
  const season = (right.seasonNumber || 0) - (left.seasonNumber || 0);
  if (season) return season;
  return String(right.createdAt || '').localeCompare(String(left.createdAt || ''));
}

function holdouts(index: MatchIndexV1): ProjectFundRelationship[] {
  const byProject = new Map<string, ProjectFundRelationship[]>();
  for (const relationship of index.relationships) {
    if (relationship.kind === 'submitted') continue;
    const rows = byProject.get(relationship.projectId) || [];
    rows.push(relationship);
    byProject.set(relationship.projectId, rows);
  }
  return [...byProject.values()].map((rows) => [...rows].sort(newest)[0]);
}

function derivedThemes(index: MatchIndexV1, relationships: ProjectFundRelationship[]): Map<string, string[]> {
  const projectById = new Map(index.projects.map((project) => [project.id, project]));
  const countsByFund = new Map<string, Map<string, number>>();
  for (const relationship of relationships) {
    if (relationship.kind === 'submitted') continue;
    const project = projectById.get(relationship.projectId);
    if (!project) continue;
    const counts = countsByFund.get(relationship.fundId) || new Map<string, number>();
    for (const tag of project.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    countsByFund.set(relationship.fundId, counts);
  }
  return new Map(
    [...countsByFund].map(([fundId, counts]) => [
      fundId,
      [...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 16)
        .map(([tag]) => tag),
    ]),
  );
}

function withoutHoldout(index: MatchIndexV1, holdout: ProjectFundRelationship, scoring: ScoringConfig): MatchIndexV1 {
  const relationships = index.relationships.filter(
    (relationship) => !(relationship.projectId === holdout.projectId && relationship.fundId === holdout.fundId),
  );
  const themes = derivedThemes(index, relationships);
  return {
    ...index,
    funds: index.funds.map((fund) => ({ ...fund, derivedThemes: themes.get(fund.id) || [] })),
    relationships,
    scoring,
  };
}

function inputFor(index: MatchIndexV1, projectId: string): ProjectMatchInput | undefined {
  const project = index.projects.find((candidate) => candidate.id === projectId);
  return project
    ? { projectId: project.id, title: project.name, description: project.description, tags: project.tags }
    : undefined;
}

function score(index: MatchIndexV1, scoring: ScoringConfig): EvaluationMetrics {
  let recalled = 0;
  let ndcg = 0;
  let reciprocalRank = 0;
  let cases = 0;
  for (const holdout of holdouts(index)) {
    const input = inputFor(index, holdout.projectId);
    if (!input) continue;
    const result = matchFunds(prepareMatchIndex(withoutHoldout(index, holdout, scoring)), input);
    const position = result.recommendations.findIndex((recommendation) => recommendation.fundId === holdout.fundId) + 1;
    cases += 1;
    if (position > 0) reciprocalRank += 1 / position;
    if (position > 0 && position <= 7) {
      recalled += 1;
      ndcg += 1 / Math.log2(position + 1);
    }
  }
  return {
    cases,
    recallAt7: cases ? recalled / cases : 0,
    ndcgAt7: cases ? ndcg / cases : 0,
    mrr: cases ? reciprocalRank / cases : 0,
  };
}

export function evaluateMatchIndex(index: MatchIndexV1): MatchingEvaluation {
  const base = index.scoring;
  return {
    hybrid: score(index, base),
    contentOnly: score(index, { ...base, contentWeight: 1, tagWeight: 0, graphWeight: 0 }),
    graphOnly: score(index, { ...base, contentWeight: 0, tagWeight: 0, graphWeight: 1 }),
  };
}
