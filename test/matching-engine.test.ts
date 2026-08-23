import { describe, expect, it } from 'vitest';
import type { FundProfile, MatchIndexV1, ProjectProfile } from '../src/artizen/types';
import { isMatchIndexStale, matchFunds, normalizeTerms, prepareMatchIndex } from '../src/matching/engine';
import { evaluateMatchIndex } from '../src/matching/evaluate';
import { DEFAULT_SCORING } from '../src/matching/index';

function project(id: string, name: string, description: string, tags: string[] = []): ProjectProfile {
  return { id, slug: id, name, description, tags };
}

function fund(
  id: string,
  name: string,
  subtitle: string,
  themes: string[] = [],
  active = true,
  available = 0,
): FundProfile {
  return {
    id,
    slug: id,
    name,
    subtitle,
    active,
    available,
    themes,
    derivedThemes: [],
    aliases: [],
    preferredTerms: [],
    excludedTerms: [],
  };
}

function fixture(): MatchIndexV1 {
  return {
    schemaVersion: 1,
    indexVersion: 'fixture',
    generatedAt: '2026-08-22T00:00:00.000Z',
    scoring: { ...DEFAULT_SCORING },
    projects: [
      project('p-climate-film', 'Climate Frames', 'Documentary films about climate action', ['Climate', 'Film']),
      project('p-community-film', 'Neighborhood Stories', 'Community documentary storytelling', ['Community', 'Film']),
      project('p-learning', 'Open Studio', 'Creative education for young artists', ['Education']),
    ],
    funds: [
      fund('f-climate', 'Climate Culture Fund', 'Stories that move climate action', ['Climate'], true, 2_000),
      fund('f-film', 'Documentary Fund', 'Independent documentary films', ['Film'], false, 0),
      fund('f-learning', 'Learning Fund', 'Creative education and schools', ['Education'], true, 100_000),
    ],
    relationships: [
      { projectId: 'p-climate-film', fundId: 'f-climate', kind: 'curated', seasonNumber: 5 },
      { projectId: 'p-community-film', fundId: 'f-climate', kind: 'funded', seasonNumber: 4 },
      { projectId: 'p-community-film', fundId: 'f-film', kind: 'curated', seasonNumber: 5 },
      { projectId: 'p-learning', fundId: 'f-learning', kind: 'funded', seasonNumber: 5 },
    ],
  };
}

describe('matching engine', () => {
  it('normalizes case, punctuation, plurals, and stop words', () => {
    expect(normalizeTerms("The Artists' stories, creating FILMS")).toEqual(['artist', 'story', 'creat', 'film']);
    expect(normalizeTerms('Shared infrastructure')).toEqual(['infrastructure']);
  });

  it('ranks direct and semantically related funds with readable reasons', () => {
    const index = fixture();
    const result = matchFunds(prepareMatchIndex(index), {
      projectId: 'p-climate-film',
      title: 'Climate Frames',
      description: 'Documentary films about climate action',
      tags: ['Climate', 'Film'],
    });
    expect(result.sufficient).toBe(true);
    expect(result.recommendations[0].fundId).toBe('f-climate');
    expect(result.recommendations[0].knownRelationship).toBe('curated');
    expect(result.recommendations[0].reasons.some((reason) => reason.kind === 'relationship')).toBe(true);
    expect(result.recommendations.some((recommendation) => recommendation.fundId === 'f-film')).toBe(true);
  });

  it('keeps explanation labels distinct and human-readable', () => {
    const result = matchFunds(prepareMatchIndex(fixture()), {
      projectId: 'p-learning',
      title: 'Open Studio',
      description: 'Free creative education and mentorship for young artists',
      tags: ['Education', 'Art'],
    });
    const reasons = result.recommendations[0].reasons.map((reason) => reason.label).join(' ');
    const contentReasons = result.recommendations[0].reasons
      .filter((reason) => reason.kind === 'content')
      .map((reason) => reason.label)
      .map((label) => label.replace('Shared focus: ', ''))
      .join(' ');
    expect(reasons).not.toContain('Art, Art');
    expect(contentReasons).not.toContain('Shar');
  });

  it('does not use activity or available money to determine alignment order', () => {
    const index = fixture();
    index.relationships = [];
    index.projects = [];
    index.funds = [
      fund('inactive', 'Amber Documentary Fund', 'independent documentary film', ['Film'], false, 0),
      fund('active', 'Zebra Documentary Fund', 'independent documentary film', ['Film'], true, 1_000_000),
    ];
    const result = matchFunds(prepareMatchIndex(index), {
      description: 'An independent documentary film and community story',
      tags: ['Film'],
    });
    expect(result.recommendations.map((row) => row.fundId)).toEqual(['inactive', 'active']);
    expect(result.recommendations[0].active).toBe(false);
  });

  it('returns an insufficient result instead of popularity guesses', () => {
    const result = matchFunds(prepareMatchIndex(fixture()), { description: 'art', tags: [] });
    expect(result).toEqual({ sufficient: false, recommendations: [] });
  });

  it('renormalizes to an available tag signal', () => {
    const index = fixture();
    index.projects = [];
    index.relationships = [];
    const result = matchFunds(prepareMatchIndex(index), {
      description: 'unmatched vocabulary',
      tags: ['Climate'],
    });
    expect(result.recommendations[0].fundId).toBe('f-climate');
    expect(result.recommendations[0].score).toBe(1);
    expect(result.recommendations[0].reasons[0]).toEqual({ kind: 'tag', label: 'Shared impact tag: Climate' });
  });

  it('uses direct history when graph affinity is the only evidence', () => {
    const result = matchFunds(prepareMatchIndex(fixture()), {
      projectId: 'p-climate-film',
      description: 'unmatched vocabulary',
      tags: [],
    });
    expect(result.recommendations[0].fundId).toBe('f-climate');
    expect(result.recommendations[0].knownRelationship).toBe('curated');
  });

  it('uses fund names as a stable tie breaker', () => {
    const index = fixture();
    index.projects = [];
    index.relationships = [];
    index.funds = [
      fund('z', 'Zebra Fund', 'community art'),
      fund('a', 'Amber Fund', 'community art'),
    ];
    const result = matchFunds(prepareMatchIndex(index), { description: 'community art project', tags: [] });
    expect(result.recommendations.map((row) => row.fundId)).toEqual(['a', 'z']);
  });

  it('keeps the complete fund catalog after evidence-backed matches', () => {
    const index = fixture();
    index.projects = [];
    index.relationships = [];
    index.funds = [
      fund('climate', 'Climate Fund', 'climate action', ['Climate']),
      fund('unrelated', 'Zebra Space Fund', 'spaceflight and orbital research', ['Space']),
    ];
    const result = matchFunds(prepareMatchIndex(index), {
      description: 'Community climate action and environmental storytelling',
      tags: ['Climate'],
    });
    expect(result.recommendations.map((row) => row.fundId)).toEqual(['climate', 'unrelated']);
    expect(result.recommendations[1]).toMatchObject({ score: 0, fit: 'exploratory' });
    expect(result.recommendations[1].reasons).toEqual([
      { kind: 'limited-evidence', label: 'No strong alignment evidence found for this fund' },
    ]);
  });

  it('rejects a corrupt index before matching', () => {
    expect(() => prepareMatchIndex({ ...fixture(), schemaVersion: 2 } as unknown as MatchIndexV1)).toThrow(
      'Unsupported matching index',
    );
  });

  it('detects stale indexes without making them unreadable', () => {
    const index = fixture();
    expect(isMatchIndexStale(index, Date.parse('2026-08-22T12:00:00.000Z'))).toBe(false);
    expect(isMatchIndexStale(index, Date.parse('2026-08-24T00:00:01.000Z'))).toBe(true);
    expect(prepareMatchIndex(index).funds).toHaveLength(3);
  });

  it('produces leakage-free holdout and ablation metrics', () => {
    const evaluation = evaluateMatchIndex(fixture());
    expect(evaluation.hybrid.cases).toBe(3);
    expect(evaluation.hybrid.recallAt7).toBeGreaterThanOrEqual(0);
    expect(evaluation.hybrid.recallAt7).toBeLessThanOrEqual(1);
    expect(evaluation.contentOnly.cases).toBe(3);
    expect(evaluation.graphOnly.cases).toBe(3);
  });
});
