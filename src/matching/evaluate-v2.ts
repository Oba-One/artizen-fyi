import type { FundRecommendation, FundRecommendationV2, MatchIndexV2, ScoringConfigV2 } from '../artizen/types';
import { matchFundsV2, prepareMatchIndexV2 } from './engine-v2';

export type HumanMatchRating = {
  projectId: string;
  fundId: string;
  grade: 0 | 1 | 2 | 3;
  note?: string;
  baseline?: FundRecommendationV2;
  semantic?: FundRecommendationV2;
  v1?: FundRecommendation;
};

export type HumanMatchMetrics = {
  reviewedProjects: number;
  fullyJudgedProjects: number;
  macroNdcgAt7: number;
  precisionAt7: number;
  judgedRecallAt7: number;
  mrr: number;
  gradeZeroRateAt7: number;
};

type Ranking = { fundId: string; score: number };
type Constraints = { minPrecisionAt7?: number; maxGradeZeroRateAt7?: number };

const REVIEW_VERSION = 'cross-domain-review-2026-08-23.1';

export function evaluationSplit(projectId: string): 'tuning' | 'holdout' {
  let hash = 2166136261;
  const value = `${REVIEW_VERSION}:${projectId}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 4 === 0 ? 'holdout' : 'tuning';
}

function dcg(grades: number[]): number {
  return grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
}

export function evaluateHumanRankings(
  rankings: Map<string, Ranking[]>,
  ratings: HumanMatchRating[],
  split?: 'tuning' | 'holdout',
): HumanMatchMetrics {
  const ratingsByProject = new Map<string, Map<string, HumanMatchRating>>();
  for (const rating of ratings) {
    if (split && evaluationSplit(rating.projectId) !== split) continue;
    const rows = ratingsByProject.get(rating.projectId) || new Map<string, HumanMatchRating>();
    rows.set(rating.fundId, rating);
    ratingsByProject.set(rating.projectId, rows);
  }
  const projects = [...ratingsByProject.keys()].filter((projectId) => rankings.has(projectId));
  const perProject: Array<{ ndcg: number; precision: number; recall: number; mrr: number; zeroRate: number }> = [];
  for (const projectId of projects) {
    const judged = ratingsByProject.get(projectId)!;
    const top = rankings.get(projectId)!.slice(0, 7);
    if (top.length === 0 || top.some((row) => !judged.has(row.fundId))) continue;
    const grades = top.map((row) => judged.get(row.fundId)!.grade);
    const ideal = [...judged.values()]
      .map((rating) => rating.grade)
      .sort((a, b) => b - a)
      .slice(0, 7);
    const relevant = [...judged.values()].filter((rating) => rating.grade >= 2).length;
    const relevantRanks = grades.flatMap((grade, index) => (grade >= 2 ? [index + 1] : []));
    perProject.push({
      ndcg: dcg(ideal) > 0 ? dcg(grades) / dcg(ideal) : 0,
      precision: grades.filter((grade) => grade >= 2).length / grades.length,
      recall: relevant > 0 ? relevantRanks.length / relevant : 0,
      mrr: relevantRanks.length ? 1 / relevantRanks[0] : 0,
      zeroRate: grades.filter((grade) => grade === 0).length / grades.length,
    });
  }
  const average = (field: keyof (typeof perProject)[number]) =>
    perProject.length ? perProject.reduce((sum, row) => sum + row[field], 0) / perProject.length : 0;
  return {
    reviewedProjects: projects.length,
    fullyJudgedProjects: perProject.length,
    macroNdcgAt7: average('ndcg'),
    precisionAt7: average('precision'),
    judgedRecallAt7: average('recall'),
    mrr: average('mrr'),
    gradeZeroRateAt7: average('zeroRate'),
  };
}

export function baselineRankings(index: MatchIndexV2): Map<string, Ranking[]> {
  const prepared = prepareMatchIndexV2(index);
  return new Map(
    index.projects.map((project) => {
      const result = matchFundsV2(prepared, {
        projectId: project.id,
        title: project.name,
        description: project.description,
        tags: project.tags,
      });
      return [project.id, result.recommendations.map((row) => ({ fundId: row.fundId, score: row.score }))];
    }),
  );
}

function satisfies(metrics: HumanMatchMetrics, constraints: Constraints): boolean {
  return (
    metrics.precisionAt7 >= (constraints.minPrecisionAt7 || 0) &&
    metrics.gradeZeroRateAt7 <= (constraints.maxGradeZeroRateAt7 ?? 1)
  );
}

export function tuneBaselineWeights(
  index: MatchIndexV2,
  ratings: HumanMatchRating[],
  constraints: Constraints = {},
): { scoring: ScoringConfigV2; metrics: HumanMatchMetrics } {
  let best = { scoring: { ...index.scoring }, metrics: evaluateHumanRankings(baselineRankings(index), ratings, 'tuning') };
  for (let lexical = 0; lexical <= 20; lexical += 1) {
    for (let facets = 0; facets <= 20 - lexical; facets += 1) {
      const core = 20 - lexical - facets;
      const scoring = {
        ...index.scoring,
        lexicalWeight: lexical * 0.05,
        facetWeight: facets * 0.05,
        coreCoverageWeight: core * 0.05,
      };
      const candidateIndex = { ...index, scoring };
      const metrics = evaluateHumanRankings(baselineRankings(candidateIndex), ratings, 'tuning');
      if (!satisfies(metrics, constraints)) continue;
      if (metrics.macroNdcgAt7 > best.metrics.macroNdcgAt7 + 1e-9) best = { scoring, metrics };
    }
  }
  return best;
}

export function tuneSemanticWeights(
  ratings: HumanMatchRating[],
  scoring: ScoringConfigV2,
  constraints: Constraints = {},
): { scoring: ScoringConfigV2; metrics: HumanMatchMetrics } | null {
  const complete = ratings.filter((rating) => rating.semantic?.breakdown.semantic != null);
  if (complete.length === 0) return null;
  let best: { scoring: ScoringConfigV2; metrics: HumanMatchMetrics } | undefined;
  for (let semantic = 0; semantic <= 20; semantic += 1) {
    for (let facets = 0; facets <= 20 - semantic; facets += 1) {
      for (let core = 0; core <= 20 - semantic - facets; core += 1) {
        const lexical = 20 - semantic - facets - core;
        const rankings = new Map<string, Ranking[]>();
        for (const rating of complete) {
          const breakdown = rating.semantic!.breakdown;
          const raw =
            breakdown.semantic! * semantic * 0.05 +
            breakdown.facets * facets * 0.05 +
            breakdown.coreCoverage * core * 0.05 +
            breakdown.lexical * lexical * 0.05;
          const score = rating.semantic!.supportedFocus ? raw : raw * scoring.unsupportedFocusPenalty;
          const rows = rankings.get(rating.projectId) || [];
          rows.push({ fundId: rating.fundId, score });
          rankings.set(rating.projectId, rows);
        }
        for (const rows of rankings.values()) rows.sort((a, b) => b.score - a.score || a.fundId.localeCompare(b.fundId));
        const metrics = evaluateHumanRankings(rankings, complete, 'tuning');
        if (!satisfies(metrics, constraints)) continue;
        if (
          !best ||
          metrics.macroNdcgAt7 > best.metrics.macroNdcgAt7 + 1e-9 ||
          (Math.abs(metrics.macroNdcgAt7 - best.metrics.macroNdcgAt7) <= 1e-9 && semantic < best.scoring.semanticWeight * 20)
        ) {
          best = {
            scoring: {
              ...scoring,
              semanticWeight: semantic * 0.05,
              semanticFacetWeight: facets * 0.05,
              semanticCoreCoverageWeight: core * 0.05,
              semanticLexicalWeight: lexical * 0.05,
            },
            metrics,
          };
        }
      }
    }
  }
  return best || null;
}
