import { describe, expect, it } from 'vitest';
import type { FundProfile, MatchIndex, ProjectHistory, ProjectMatchInput } from '../src/artizen/types';
import { isMatchIndexStale, MATCH_INDEX_STALE_MS, matchFunds, prepareMatchIndex } from '../src/matching/engine';
import { DEFAULT_SCORING } from '../src/matching/index';
import { MATCH_FACETS, MATCH_TAXONOMY_VERSION, extractFacetIds } from '../src/matching/taxonomy';

const hash = 'a'.repeat(64);

function fund(
  id: string,
  name: string,
  profileText: string,
  focusFacets: string[] = [],
  facets = extractFacetIds(profileText),
): FundProfile {
  return {
    id,
    slug: id,
    name,
    subtitle: profileText,
    active: true,
    available: 0,
    themes: [],
    aliases: [],
    preferredTerms: [],
    excludedTerms: [],
    profileText,
    profileHash: hash,
    facets,
    focusFacets,
    coreConcepts: name
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => !['fund', 'the'].includes(term)),
  };
}

function fixture(): MatchIndex {
  const projects = [
    {
      id: 'green-goods',
      slug: 'green-goods',
      name: 'Green Goods',
      description: 'Tools and community programs that help people fund local regenerative public goods.',
      tags: ['Public Goods', 'Regenerative', 'Community', 'Climate', 'Education', 'Open Source', 'Local Action', 'Web3', 'Coordination', 'Commons'],
      facets: extractFacetIds(
        'Tools and community programs that help people fund local regenerative public goods.',
        'Public Goods Regenerative Community Climate Education Open Source Local Action Web3 Coordination Commons',
      ),
    },
  ];
  const funds = [
    fund(
      'public-goods',
      'Public Goods Fund',
      'For open-source public goods, community infrastructure, and regenerative coordination.',
      ['domain:open-infrastructure'],
    ),
    fund(
      'desci',
      'DeSci Fund',
      'For scientific research, decentralized science, laboratories, biology, and researchers.',
      ['domain:science-research'],
    ),
    fund(
      'ocean',
      'Ocean Fund',
      'For marine conservation, coral reefs, ocean research, and coastal restoration.',
      ['domain:marine-ocean'],
    ),
    fund(
      'film',
      'Documentary Film Fund',
      'For independent documentary films and cinematic storytellers.',
      ['medium:film-storytelling'],
    ),
    fund(
      'music',
      'Music Fund',
      'For musicians, sound art, performance, and live music.',
      ['medium:music-performance'],
    ),
    fund(
      'agriculture',
      'Regenerative Agriculture Fund',
      'For agroforestry, soil health, farming, seeds, and land stewardship.',
      ['domain:agriculture-land'],
    ),
  ];
  return {
    schemaVersion: 2,
    indexVersion: 'fixture-v2',
    generatedAt: '2026-08-22T00:00:00.000Z',
    source: { kind: 'fixture', projects: projects.length, funds: funds.length, relationships: 2 },
    taxonomyVersion: MATCH_TAXONOMY_VERSION,
    facets: MATCH_FACETS,
    projects,
    funds,
    relationships: [
      { projectId: 'green-goods', fundId: 'desci', kind: 'curated' },
      { projectId: 'green-goods', fundId: 'ocean', kind: 'submitted' },
    ],
    scoring: { ...DEFAULT_SCORING },
  };
}

function scores(index: MatchIndex, input: ProjectMatchInput): Array<[string, number, string]> {
  return matchFunds(prepareMatchIndex(index), input).recommendations.map((row) => [row.fundId, row.score, row.fit]);
}

describe('matching engine v2', () => {
  it('uses a monthly freshness guard for deploy-scoped catalogs', () => {
    const generatedAt = '2026-08-01T00:00:00.000Z';
    const generated = Date.parse(generatedAt);
    expect(MATCH_INDEX_STALE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(isMatchIndexStale({ generatedAt }, generated + MATCH_INDEX_STALE_MS)).toBe(false);
    expect(isMatchIndexStale({ generatedAt }, generated + MATCH_INDEX_STALE_MS + 1)).toBe(true);
    expect(isMatchIndexStale({ generatedAt: 'not-a-date' }, generated)).toBe(true);
  });

  it('keeps scores and order invariant when projectId changes', () => {
    const index = fixture();
    const input = {
      title: 'Green Goods',
      description: index.projects[0].description,
      tags: index.projects[0].tags,
    };
    const anonymous = scores(index, input);
    const known = matchFunds(prepareMatchIndex(index), { ...input, projectId: 'green-goods' });
    expect(known.recommendations.map((row) => [row.fundId, row.score, row.fit])).toEqual(anonymous);
    expect(known.recommendations.find((row) => row.fundId === 'desci')?.knownRelationship).toBe('curated');
    expect(known.recommendations.find((row) => row.fundId === 'desci')?.reasons.some((reason) => reason.kind === 'relationship')).toBe(false);
  });

  it('reads relationships from per-project history, which is all the split payloads carry', () => {
    const index = fixture();
    const split: MatchIndex = {
      ...index,
      projects: index.projects.map((project) =>
        project.id === 'green-goods'
          ? { ...project, history: [['desci', 'curated'], ['ocean', 'submitted']] as ProjectHistory }
          : project,
      ),
      relationships: [],
    };
    const input = { projectId: 'green-goods', title: 'Green Goods', description: index.projects[0].description, tags: index.projects[0].tags };
    const result = matchFunds(prepareMatchIndex(split), input);
    expect(result.recommendations.find((row) => row.fundId === 'desci')?.knownRelationship).toBe('curated');
    expect(result.recommendations.find((row) => row.fundId === 'ocean')?.knownRelationship).toBe('submitted');
    // Identical scores either way: history is display context, never an input to the ranking.
    expect(result.recommendations.map((row) => [row.fundId, row.score])).toEqual(
      matchFunds(prepareMatchIndex(index), input).recommendations.map((row) => [row.fundId, row.score]),
    );
  });

  it('falls back to the relationship table per project, not for the index as a whole', () => {
    const index = fixture();
    // One project migrated to a history, the rest still only in the table. Deciding the source
    // globally would strip every badge from the projects that had not migrated.
    const migrated = { ...index.projects[0], history: [['desci', 'curated']] as ProjectHistory };
    const legacy = { ...index.projects[0], id: 'legacy', slug: 'legacy', name: 'Legacy Project' };
    const mixed: MatchIndex = {
      ...index,
      projects: [migrated, legacy],
      relationships: [{ projectId: 'legacy', fundId: 'ocean', kind: 'funded' }],
    };
    const prepared = prepareMatchIndex(mixed);
    expect(prepared.relationshipsByProject.get(migrated.id)?.map((row) => row.fundId)).toEqual(['desci']);
    expect(prepared.relationshipsByProject.get('legacy')?.map((row) => row.kind)).toEqual(['funded']);
  });

  it('does not call DeSci or Ocean a good Green Goods fit without focus evidence', () => {
    const index = fixture();
    const result = matchFunds(prepareMatchIndex(index), {
      projectId: 'green-goods',
      title: 'Green Goods',
      description: index.projects[0].description,
      tags: index.projects[0].tags,
    });
    expect(result.recommendations[0].fundId).toBe('public-goods');
    expect(result.recommendations.find((row) => row.fundId === 'desci')?.fit).not.toMatch(/strong|good/);
    expect(result.recommendations.find((row) => row.fundId === 'ocean')?.fit).not.toMatch(/strong|good/);
  });

  it.each([
    ['desci', 'A decentralized science laboratory coordinating open biology research', ['Science', 'Research']],
    ['ocean', 'A marine conservation program restoring coral reefs with coastal communities', ['Ocean', 'Climate']],
    ['film', 'An independent documentary film telling stories through cinema', ['Film']],
    ['music', 'A live music and performance program for emerging musicians', ['Music']],
    ['agriculture', 'Regenerative farming and agroforestry for soil health and seed stewardship', ['Agriculture']],
  ])('lets a genuine focused project rank %s highly', (expected, description, tags) => {
    const result = matchFunds(prepareMatchIndex(fixture()), { description, tags });
    expect(result.recommendations[0].fundId).toBe(expected);
    expect(result.recommendations[0].supportedFocus).toBe(true);
    expect(['strong', 'good']).toContain(result.recommendations[0].fit);
  });

  it('keeps narrow funds exploratory when only generic language overlaps', () => {
    const result = matchFunds(prepareMatchIndex(fixture()), {
      description: 'An open creative community initiative with positive environmental impact',
      tags: ['Community'],
    });
    for (const id of ['desci', 'ocean', 'film', 'music', 'agriculture']) {
      expect(result.recommendations.find((row) => row.fundId === id)?.fit).not.toMatch(/strong|good/);
    }
  });

  it('keeps the focus guard when semantic similarity is high', () => {
    const index = fixture();
    const semantic = new Map(index.funds.map((candidate) => [candidate.id, 1]));
    const result = matchFunds(
      prepareMatchIndex(index),
      { description: 'Regenerative community public goods coordination', tags: ['Community'] },
      semantic,
    );
    expect(result.mode).toBe('semantic');
    expect(result.recommendations.find((row) => row.fundId === 'desci')?.fit).toBe('exploratory');
    expect(result.recommendations.find((row) => row.fundId === 'ocean')?.fit).toBe('exploratory');
  });

  it('uses positive eligibility as a cautious boost and keeps explicit exclusions separate', () => {
    const index = fixture();
    const eligible = fund('eligible', 'Community Tool Fund', 'For open community coordination tools');
    eligible.eligibilityCriteria = ['Applicants may build cooperative governance tools for public communities.'];
    const review = { ...structuredClone(eligible), id: 'review', slug: 'review', name: 'Review Fund' };
    review.eligibilityExclusions = ['We do not fund private surveillance tools or weapons research.'];
    index.funds = [eligible, review];
    index.source.funds = 2;

    const result = matchFunds(prepareMatchIndex(index), {
      description: 'Cooperative governance tools for public communities, alongside private surveillance tools research',
      tags: ['Community'],
    });
    const plain = result.recommendations.find((row) => row.fundId === 'eligible')!;
    const warned = result.recommendations.find((row) => row.fundId === 'review')!;

    expect(plain.breakdown.eligibility).toBeGreaterThan(0);
    expect(plain.reasons.some((reason) => reason.kind === 'eligibility')).toBe(true);
    expect(warned.breakdown.exclusionRisk).toBeGreaterThan(0);
    expect(warned.warnings?.[0].kind).toBe('eligibility-exclusion');
    expect(warned.score).toBeLessThan(plain.score);
  });

  it('does not penalize a project for one incidental word from an exclusion', () => {
    const index = fixture();
    const candidate = fund('candidate', 'Community Research Fund', 'For community research and public tools');
    candidate.eligibilityExclusions = ['We do not fund private weapons manufacturing.'];
    index.funds = [candidate];
    index.source.funds = 1;
    const result = matchFunds(prepareMatchIndex(index), {
      description: 'Public community research into private space governance',
      tags: ['Community'],
    });
    expect(result.recommendations[0].breakdown.exclusionRisk).toBe(0);
    expect(result.recommendations[0].warnings).toBeUndefined();
  });

  it('puts the Metacrisis-style systems fund in Green Goods’ first page using general concepts', () => {
    const index = fixture();
    const target = fund(
      'metacrisis',
      'Metacrisis Fund for Positive-Sum Interventions',
      'Supports upstream interventions that change generator functions and enable positive-sum systems change.',
    );
    target.description =
      'For collective sensemaking, systemic change, and economic interventions that internalize externalities.';
    target.eligibilityCriteria = [
      'Projects may develop circular economy and regenerative economics tools for positive-sum coordination.',
    ];
    target.profileText = [target.name, target.subtitle, target.description, ...target.eligibilityCriteria].join('. ');
    target.facets = extractFacetIds(target.profileText);
    target.focusFacets = ['approach:circular-economy', 'approach:systems-change'];
    const decoys = Array.from({ length: 16 }, (_, position) =>
      fund(
        `decoy-${position}`,
        `Creative Community Fund ${position}`,
        'For local artists, community storytelling, education, and cultural events.',
      ),
    );
    index.funds = [...decoys, target];
    index.source.funds = index.funds.length;

    const semanticScores = new Map(
      index.funds.map((candidate) => [candidate.id, candidate.id === target.id ? 0.58 : 0.65]),
    );
    const result = matchFunds(
      prepareMatchIndex(index),
      {
        projectId: 'green-goods',
        title: 'Green Goods',
        description: 'Tools that fund local regenerative public goods.',
        tags: ['Circular Economy', 'Regenerative Economics', 'Coordination', 'Commons'],
        context: {
          impact:
            'Builds a circular economy and positive-sum coordination system by internalizing externalities and supporting systems change.',
          progress: 'Working tools support collective sensemaking and upstream intervention.',
        },
      },
      semanticScores,
    );
    const rank = result.recommendations.findIndex((row) => row.fundId === target.id);
    const recommendation = result.recommendations[rank];

    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(12);
    expect(recommendation.reasons.some((reason) => reason.kind === 'eligibility')).toBe(true);
    expect(extractFacetIds('Green Goods')).toEqual([]);
    expect(extractFacetIds('circular economy and positive-sum systems change')).toEqual([
      'approach:circular-economy',
      'approach:systems-change',
    ]);
  });

  it('returns insufficient evidence instead of catalog-relative guesses', () => {
    expect(matchFunds(prepareMatchIndex(fixture()), { description: 'art', tags: [] })).toEqual({
      sufficient: false,
      recommendations: [],
      mode: 'baseline',
    });
  });

  it('does not use activity or availability in score or ordering', () => {
    const index = fixture();
    index.funds = [
      { ...fund('inactive', 'Amber Science Fund', 'For scientific research', ['domain:science-research']), active: false, available: 0 },
      { ...fund('active', 'Zebra Science Fund', 'For scientific research', ['domain:science-research']), active: true, available: 1_000_000 },
    ];
    index.source.funds = 2;
    const result = matchFunds(prepareMatchIndex(index), {
      description: 'Scientific research in an open biology laboratory',
      tags: ['Science'],
    });
    expect(result.recommendations.map((row) => row.fundId)).toEqual(['inactive', 'active']);
    expect(result.recommendations[0].score).toBe(result.recommendations[1].score);
  });

  it('rejects corrupt schema versions before scoring', () => {
    expect(() => prepareMatchIndex({ ...fixture(), schemaVersion: 1 } as unknown as MatchIndex)).toThrow(
      'Unsupported matching v2 index',
    );
  });

  it('uses stable alphabetical ordering for exact ties', () => {
    const index = fixture();
    index.funds = [
      fund('zebra', 'Zebra Fund', 'For orbital spacecraft'),
      fund('amber', 'Amber Fund', 'For orbital spacecraft'),
    ];
    index.source.funds = 2;
    const result = matchFunds(prepareMatchIndex(index), {
      description: 'A community mural and local storytelling project',
      tags: [],
    });
    expect(result.recommendations.map((row) => row.fundId)).toEqual(['amber', 'zebra']);
  });
});
