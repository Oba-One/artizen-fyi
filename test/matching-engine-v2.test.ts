import { describe, expect, it } from 'vitest';
import type { FundProfileV2, MatchIndexV2, ProjectMatchInput } from '../src/artizen/types';
import { matchFundsV2, prepareMatchIndexV2 } from '../src/matching/engine-v2';
import { DEFAULT_SCORING_V2 } from '../src/matching/index-v2';
import { MATCH_FACETS, MATCH_TAXONOMY_VERSION, extractFacetIds } from '../src/matching/taxonomy';

const hash = 'a'.repeat(64);

function fund(
  id: string,
  name: string,
  profileText: string,
  focusFacets: string[] = [],
  facets = extractFacetIds(profileText),
): FundProfileV2 {
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

function fixture(): MatchIndexV2 {
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
    scoring: { ...DEFAULT_SCORING_V2 },
  };
}

function scores(index: MatchIndexV2, input: ProjectMatchInput): Array<[string, number, string]> {
  return matchFundsV2(prepareMatchIndexV2(index), input).recommendations.map((row) => [row.fundId, row.score, row.fit]);
}

describe('matching engine v2', () => {
  it('keeps scores and order invariant when projectId changes', () => {
    const index = fixture();
    const input = {
      title: 'Green Goods',
      description: index.projects[0].description,
      tags: index.projects[0].tags,
    };
    const anonymous = scores(index, input);
    const known = matchFundsV2(prepareMatchIndexV2(index), { ...input, projectId: 'green-goods' });
    expect(known.recommendations.map((row) => [row.fundId, row.score, row.fit])).toEqual(anonymous);
    expect(known.recommendations.find((row) => row.fundId === 'desci')?.knownRelationship).toBe('curated');
    expect(known.recommendations.find((row) => row.fundId === 'desci')?.reasons.some((reason) => reason.kind === 'relationship')).toBe(false);
  });

  it('does not call DeSci or Ocean a good Green Goods fit without focus evidence', () => {
    const index = fixture();
    const result = matchFundsV2(prepareMatchIndexV2(index), {
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
    const result = matchFundsV2(prepareMatchIndexV2(fixture()), { description, tags });
    expect(result.recommendations[0].fundId).toBe(expected);
    expect(result.recommendations[0].supportedFocus).toBe(true);
    expect(['strong', 'good']).toContain(result.recommendations[0].fit);
  });

  it('keeps narrow funds exploratory when only generic language overlaps', () => {
    const result = matchFundsV2(prepareMatchIndexV2(fixture()), {
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
    const result = matchFundsV2(
      prepareMatchIndexV2(index),
      { description: 'Regenerative community public goods coordination', tags: ['Community'] },
      semantic,
    );
    expect(result.mode).toBe('semantic');
    expect(result.recommendations.find((row) => row.fundId === 'desci')?.fit).toBe('exploratory');
    expect(result.recommendations.find((row) => row.fundId === 'ocean')?.fit).toBe('exploratory');
  });

  it('returns insufficient evidence instead of catalog-relative guesses', () => {
    expect(matchFundsV2(prepareMatchIndexV2(fixture()), { description: 'art', tags: [] })).toEqual({
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
    const result = matchFundsV2(prepareMatchIndexV2(index), {
      description: 'Scientific research in an open biology laboratory',
      tags: ['Science'],
    });
    expect(result.recommendations.map((row) => row.fundId)).toEqual(['inactive', 'active']);
    expect(result.recommendations[0].score).toBe(result.recommendations[1].score);
  });

  it('rejects corrupt schema versions before scoring', () => {
    expect(() => prepareMatchIndexV2({ ...fixture(), schemaVersion: 1 } as unknown as MatchIndexV2)).toThrow(
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
    const result = matchFundsV2(prepareMatchIndexV2(index), {
      description: 'A community mural and local storytelling project',
      tags: [],
    });
    expect(result.recommendations.map((row) => row.fundId)).toEqual(['amber', 'zebra']);
  });
});
