import { describe, expect, it } from 'vitest';
import type { MatchIndex } from '../src/artizen/types';
import { baselineRankings, semanticTuningScore } from '../src/matching/evaluate';
import { adjustMatchScore, matchFunds, prepareMatchIndex } from '../src/matching/engine';
import { DEFAULT_SCORING } from '../src/matching/index';
import { matchInputForProject } from '../src/matching/project-search';
import { MATCH_FACETS, MATCH_TAXONOMY_VERSION } from '../src/matching/taxonomy';

const hash = 'a'.repeat(64);

function fixture(): MatchIndex {
  return {
    schemaVersion: 2,
    indexVersion: 'evaluation-context',
    generatedAt: '2026-08-29T00:00:00.000Z',
    source: { kind: 'fixture', projects: 1, funds: 2, relationships: 0 },
    taxonomyVersion: MATCH_TAXONOMY_VERSION,
    facets: MATCH_FACETS,
    projects: [
      {
        id: 'project',
        slug: 'project',
        name: 'Common Ground',
        description: 'A community initiative',
        tags: [],
        context: {
          description: 'Restoring coral reefs and marine habitats',
          impact: 'Coastal conservation led by fishing communities',
          team: 'A documentary filmmaker advises the team',
        },
        facets: [],
      },
    ],
    funds: [
      {
        id: 'ocean',
        slug: 'ocean',
        name: 'Ocean Fund',
        subtitle: 'Marine conservation and coral reef restoration',
        active: true,
        themes: [],
        aliases: [],
        preferredTerms: [],
        excludedTerms: [],
        profileText: 'Ocean Fund. Marine conservation and coral reef restoration',
        profileHash: hash,
        facets: ['domain:marine-ocean'],
        focusFacets: ['domain:marine-ocean'],
        coreConcepts: ['coral reef'],
      },
      {
        id: 'film',
        slug: 'film',
        name: 'Film Fund',
        subtitle: 'Documentary filmmaking',
        active: true,
        themes: [],
        aliases: [],
        preferredTerms: [],
        excludedTerms: [],
        profileText: 'Film Fund. Documentary filmmaking',
        profileHash: hash,
        facets: ['medium:film-storytelling'],
        focusFacets: ['medium:film-storytelling'],
        coreConcepts: ['documentari'],
      },
    ],
    relationships: [],
    scoring: { ...DEFAULT_SCORING },
  };
}

describe('matching evaluation inputs', () => {
  it('uses the same hydrated narrative context as production baseline scoring', () => {
    const index = fixture();
    const production = matchFunds(prepareMatchIndex(index), matchInputForProject(index.projects[0]));
    const evaluation = baselineRankings(index).get('project');

    expect(evaluation).toEqual(
      production.recommendations.map((row) => ({ fundId: row.fundId, score: row.score })),
    );
    expect(evaluation?.[0].fundId).toBe('ocean');
  });

  it('applies production eligibility, exclusion, and focus adjustments during semantic tuning', () => {
    const scoring = {
      ...DEFAULT_SCORING,
      semanticWeight: 1,
      semanticFacetWeight: 0,
      semanticCoreCoverageWeight: 0,
      semanticLexicalWeight: 0,
    };
    const recommendation = {
      supportedFocus: false,
      breakdown: {
        semantic: DEFAULT_SCORING.goodThreshold,
        lexical: 0,
        facets: 0,
        coreCoverage: 0,
        eligibility: 1,
        exclusionRisk: 0.5,
      },
    };

    expect(semanticTuningScore(recommendation, scoring)).toBeCloseTo(
      adjustMatchScore(
        DEFAULT_SCORING.goodThreshold,
        recommendation.breakdown,
        recommendation.supportedFocus,
        scoring,
      ),
    );
    expect(semanticTuningScore(recommendation, scoring)).not.toBe(DEFAULT_SCORING.goodThreshold);
  });
});
