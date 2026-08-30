import { describe, expect, it } from 'vitest';
import type { FundProfile, MatchIndex, ProjectHistory, ProjectMatchInput } from '../src/artizen/types';
import {
  adjustMatchScore,
  isMatchIndexStale,
  MATCH_INDEX_STALE_MS,
  matchFunds,
  prepareMatchIndex,
} from '../src/matching/engine';
import { DEFAULT_SCORING } from '../src/matching/index';
import {
  MATCH_FACETS,
  MATCH_TAXONOMY_VERSION,
  extractFacetIds,
  extractFundFocusFacetIds,
} from '../src/matching/taxonomy';

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
  it('does not treat generic care language as a narrow health focus', () => {
    expect(extractFacetIds('Care for plants, grow creatures, and restore worlds')).not.toContain(
      'domain:health-wellness',
    );
    expect(extractFacetIds('Community health, healing, and wellness support')).toContain(
      'domain:health-wellness',
    );
  });

  it('keeps unreviewed systems approaches as ordinary facets rather than hard focus guards', () => {
    const systemsFund = fund(
      'systems',
      'Systems Change Fund',
      'For positive-sum systems change and circular economy experiments.',
    );
    expect(systemsFund.facets).toEqual(
      expect.arrayContaining(['approach:circular-economy', 'approach:systems-change']),
    );
    expect(extractFundFocusFacetIds(systemsFund.name, systemsFund.subtitle)).toEqual([]);
  });

  it('awards the distinctive-approach bonus without turning those facets into focus guards', () => {
    const index = fixture();
    const profile = 'For regenerative community experiments and shared economic infrastructure';
    index.funds = [
      fund('ordinary', 'Ordinary Fund', profile, [], ['approach:regenerative']),
      fund('systems', 'Systems Fund', profile, [], ['approach:systems-change']),
    ];
    index.source.funds = 2;

    const result = matchFunds(prepareMatchIndex(index), {
      description: 'A regenerative systems change experiment for community economics',
      tags: [],
    });
    const ordinary = result.recommendations.find((row) => row.fundId === 'ordinary')!;
    const systems = result.recommendations.find((row) => row.fundId === 'systems')!;

    expect(systems.breakdown.facets).toBe(ordinary.breakdown.facets);
    expect(systems.breakdown.distinctiveApproach).toBe(1);
    expect(systems.score).toBeGreaterThan(ordinary.score);
    expect(systems.supportedFocus).toBe(true);
  });

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

  it('does not mint project facets from team biographies or progress reports', () => {
    const index = fixture();
    index.funds = [
      fund(
        'ai',
        'AI Fund',
        'For artificial intelligence, machine learning, and software projects.',
        ['domain:ai-technology'],
      ),
    ];
    index.source.funds = 1;
    const result = matchFunds(prepareMatchIndex(index), {
      description: 'A community mural and local arts program',
      tags: ['Art'],
      context: {
        progress: 'Women in Kenya tested the first prototype.',
        team: 'An AI engineer and machine learning researcher advises the artists.',
      },
    });

    expect(result.recommendations[0].supportedFocus).toBe(false);
    expect(result.recommendations[0].fit).not.toMatch(/strong|good/);
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

  it('requires two specific eligibility terms before applying a boost', () => {
    const index = fixture();
    const candidate = fund('candidate', 'Community Fund', 'For public community projects');
    candidate.eligibilityCriteria = ['Applicants should use cooperative governance tools.'];
    index.funds = [candidate];
    index.source.funds = 1;

    const oneTerm = matchFunds(prepareMatchIndex(index), {
      description: 'A cooperative public community project',
      tags: [],
    }).recommendations[0];
    const twoTerms = matchFunds(prepareMatchIndex(index), {
      description: 'Cooperative governance for a public community project',
      tags: [],
    }).recommendations[0];

    expect(oneTerm.breakdown.eligibility).toBe(0);
    expect(twoTerms.breakdown.eligibility).toBeGreaterThan(0);
    expect(twoTerms.score).toBeGreaterThan(oneTerm.score);
  });

  it('computes eligibility IDF over funds that publish criteria, not empty documents', () => {
    const index = fixture();
    index.funds = [
      fund('empty-a', 'Empty A', 'For public art'),
      fund('empty-b', 'Empty B', 'For public music'),
      fund('eligible', 'Eligible', 'For public tools'),
    ];
    index.funds[2].eligibilityCriteria = ['Cooperative governance'];
    index.source.funds = 3;

    const prepared = prepareMatchIndex(index);
    expect(prepared.eligibilityIdf.get('cooperative')).toBeCloseTo(Math.log(2));
  });

  it('keeps eligibility boosts inside the score band earned by topical evidence', () => {
    const score = adjustMatchScore(
      DEFAULT_SCORING.goodThreshold,
      { eligibility: 1, exclusionRisk: 0 },
      true,
      DEFAULT_SCORING,
    );

    expect(score).toBeGreaterThan(DEFAULT_SCORING.goodThreshold);
    expect(score).toBeLessThan(DEFAULT_SCORING.strongThreshold);

    const nearBoundary = DEFAULT_SCORING.strongThreshold - 5e-10;
    expect(
      adjustMatchScore(nearBoundary, { eligibility: 1, exclusionRisk: 0 }, true, DEFAULT_SCORING),
    ).toBeGreaterThanOrEqual(nearBoundary);
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

  it('requires the directional condition before applying an exclusion penalty', () => {
    const index = fixture();
    const candidate = fund('candidate', 'Community Fund', 'For public community projects in Kenya');
    candidate.eligibilityExclusions = ['Teams based outside Kenya are not eligible.'];
    index.funds = [candidate];
    index.source.funds = 1;
    const prepared = prepareMatchIndex(index);

    const kenya = matchFunds(prepared, {
      description: 'A Kenya-based team building public community tools',
      tags: ['Community'],
    }).recommendations[0];
    const basedInKenya = matchFunds(prepared, {
      description: 'A team based in Kenya building public community tools',
      tags: ['Community'],
    }).recommendations[0];
    const outsideKenya = matchFunds(prepared, {
      description: 'A team based outside Kenya building public community tools',
      tags: ['Community'],
    }).recommendations[0];

    expect(kenya.breakdown.exclusionRisk).toBe(0);
    expect(kenya.warnings).toBeUndefined();
    expect(basedInKenya.breakdown.exclusionRisk).toBe(0);
    expect(basedInKenya.warnings).toBeUndefined();
    expect(outsideKenya.breakdown.exclusionRisk).toBeGreaterThan(0);
    expect(outsideKenya.warnings?.[0].kind).toBe('eligibility-exclusion');
  });

  it('distinguishes having a requirement from being without it', () => {
    const index = fixture();
    const candidate = fund('candidate', 'Community Fund', 'For public community projects');
    candidate.eligibilityExclusions = ['Projects without a fiscal sponsor are ineligible.'];
    index.funds = [candidate];
    index.source.funds = 1;
    const prepared = prepareMatchIndex(index);

    const sponsored = matchFunds(prepared, {
      description: 'A public community project with an established fiscal sponsor',
      tags: ['Community'],
    }).recommendations[0];
    const unsponsored = matchFunds(prepared, {
      description: 'A public community project without a fiscal sponsor',
      tags: ['Community'],
    }).recommendations[0];
    const differentCondition = matchFunds(prepared, {
      description: 'A public community project without fiscal restrictions',
      tags: ['Community'],
    }).recommendations[0];

    expect(sponsored.breakdown.exclusionRisk).toBe(0);
    expect(sponsored.warnings).toBeUndefined();
    expect(unsponsored.breakdown.exclusionRisk).toBeGreaterThan(0);
    expect(unsponsored.warnings?.[0].kind).toBe('eligibility-exclusion');
    expect(differentCondition.breakdown.exclusionRisk).toBe(0);
    expect(differentCondition.warnings).toBeUndefined();
  });

  it('scores the prohibited side of an unless condition, not its exception', () => {
    const index = fixture();
    const candidate = fund('candidate', 'Community Fund', 'For physical community projects');
    candidate.eligibilityExclusions = [
      'Purely digital projects do not qualify unless they are rooted in a physical community.',
    ];
    index.funds = [candidate];
    index.source.funds = 1;
    const prepared = prepareMatchIndex(index);

    const exception = matchFunds(prepared, {
      description: 'A digital project rooted in a physical community',
      tags: ['Community'],
    }).recommendations[0];
    const prohibited = matchFunds(prepared, {
      description: 'A purely digital project for online speculation',
      tags: ['Community'],
    }).recommendations[0];

    expect(exception.breakdown.exclusionRisk).toBe(0);
    expect(exception.warnings).toBeUndefined();
    expect(prohibited.breakdown.exclusionRisk).toBeGreaterThan(0);
  });

  it('does not score explanatory text after a short exclusion label', () => {
    const index = fixture();
    const candidate = fund('candidate', 'Community Fund', 'For real human communities');
    candidate.eligibilityExclusions = [
      'No AI: We believe technology can make change, but this fund supports real humans and communities.',
    ];
    index.funds = [candidate];
    index.source.funds = 1;
    const prepared = prepareMatchIndex(index);

    const human = matchFunds(prepared, {
      description: 'Real humans making change in local communities',
      tags: ['Community'],
    }).recommendations[0];
    const ai = matchFunds(prepared, {
      description: 'An AI system for local communities',
      tags: ['AI'],
    }).recommendations[0];

    expect(human.breakdown.exclusionRisk).toBe(0);
    expect(human.warnings).toBeUndefined();
    expect(ai.breakdown.exclusionRisk).toBeGreaterThan(0);
  });

  it('requires the prohibited anchor in a qualified no rule', () => {
    const index = fixture();
    const candidate = fund('candidate', 'Creative Fund', 'For independent creative projects');
    candidate.eligibilityExclusions = ["No AI in the project's conceptual development."];
    index.funds = [candidate];
    index.source.funds = 1;
    const prepared = prepareMatchIndex(index);

    const human = matchFunds(prepared, {
      description: 'A human-led process with extensive conceptual development',
      tags: ['Creative'],
    }).recommendations[0];
    const ai = matchFunds(prepared, {
      description: 'AI was used throughout the conceptual development process',
      tags: ['Creative'],
    }).recommendations[0];

    expect(human.breakdown.exclusionRisk).toBe(0);
    expect(human.warnings).toBeUndefined();
    expect(ai.breakdown.exclusionRisk).toBeGreaterThan(0);
  });

  it('requires the complete excluded subject instead of a partial compound phrase', () => {
    const index = fixture();
    const candidate = fund('candidate', 'Systems Fund', 'For positive-sum systems work');
    candidate.eligibilityExclusions = [
      'Single-issue advocacy that treats one crisis in isolation from the others is not eligible.',
    ];
    index.funds = [candidate];
    index.source.funds = 1;
    const prepared = prepareMatchIndex(index);

    const publication = matchFunds(prepared, {
      description: 'A digital magazine publishing one single issue about systems change',
      tags: ['Media'],
    }).recommendations[0];
    const advocacy = matchFunds(prepared, {
      description: 'A single-issue advocacy campaign focused on one isolated crisis',
      tags: ['Advocacy'],
    }).recommendations[0];

    expect(publication.breakdown.exclusionRisk).toBe(0);
    expect(publication.warnings).toBeUndefined();
    expect(advocacy.breakdown.exclusionRisk).toBeGreaterThan(0);
  });

  it('does not guess whether a project crosses a numeric exclusion threshold', () => {
    const index = fixture();
    const candidate = fund('candidate', 'Research Fund', 'For early-stage research projects');
    candidate.eligibilityExclusions = ['Applicants must not have received more than $50k to date.'];
    index.funds = [candidate];
    index.source.funds = 1;

    const result = matchFunds(prepareMatchIndex(index), {
      description: 'An early-stage team that has received more support than expected',
      tags: ['Research'],
    }).recommendations[0];

    expect(result.breakdown.exclusionRisk).toBe(0);
    expect(result.warnings).toBeUndefined();
  });

  it('requires role or organization evidence for time-bounded affiliation exclusions', () => {
    const index = fixture();
    const candidate = fund('candidate', 'Open Infrastructure Fund', 'For open public infrastructure');
    candidate.eligibilityExclusions = [
      'Current and former (within the past four years) staff of Filecoin Foundation are not eligible.',
    ];
    index.funds = [candidate];
    index.source.funds = 1;
    const prepared = prepareMatchIndex(index);

    const unrelatedHistory = matchFunds(prepared, {
      description: 'Four years of research into public infrastructure',
      tags: ['Open Source'],
    }).recommendations[0];
    const actualAffiliation = matchFunds(prepared, {
      description: 'Former staff of Filecoin Foundation building public infrastructure',
      tags: ['Open Source'],
    }).recommendations[0];

    expect(unrelatedHistory.breakdown.exclusionRisk).toBe(0);
    expect(unrelatedHistory.warnings).toBeUndefined();
    expect(actualAffiliation.breakdown.exclusionRisk).toBeGreaterThan(0);
  });

  it('does not use team biographies or progress reports for core-concept coverage', () => {
    const index = fixture();
    const candidate = fund('ai', 'AI Fund', 'For public-interest technology');
    candidate.coreConcepts = ['machine learn'];
    index.funds = [candidate];
    index.source.funds = 1;

    const result = matchFunds(prepareMatchIndex(index), {
      description: 'A community mural and local arts program',
      tags: ['Art'],
      context: {
        progress: 'The first machine learning prototype is complete.',
        team: 'A machine learning researcher advises the artists.',
      },
    });

    expect(result.recommendations[0].breakdown.coreCoverage).toBe(0);
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
