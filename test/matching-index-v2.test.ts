import { describe, expect, it } from 'vitest';
import type { Bubble } from '../src/artizen/bubble';
import type { MatchIndexV2, Row } from '../src/artizen/types';
import { DEFAULT_SCORING_V2, buildMatchIndexV2, validateMatchIndexV2 } from '../src/matching/index-v2';

class FakeBubble {
  constructor(private readonly rows: Record<string, Row[]>) {}
  async list(type: string): Promise<Row[]> {
    return this.rows[type] || [];
  }
}

function source(): Record<string, Row[]> {
  return {
    impacttag: [
      { _id: 'tag-science', name: 'Science' },
      { _id: 'tag-ocean', name: 'Ocean' },
    ],
    project: [
      {
        _id: 'project-science',
        Slug: 'project-science',
        Name: 'Open Biology Lab',
        Logline: 'A decentralized laboratory for open scientific research',
        'impact tags (impact tag)': ['tag-science', 'tag-ocean'],
        '(old) Artifact Image -crop': '//media.example/project-science.jpg',
      },
    ],
    fundextendedinfo: [
      {
        _id: 'extended-science',
        'full title': 'DeSci Fund for Open Biology Research',
        subtitle: 'Supporting decentralized laboratories and scientific researchers without truncation',
        'for title': 'For biology, laboratory research, and citizen science',
      },
      {
        _id: 'extended-film',
        'full title': 'Documentary Film Fund',
        subtitle: 'Independent cinematic storytelling',
        'for title': 'For documentary filmmakers',
      },
    ],
    fund: [
      {
        _id: 'fund-science',
        Slug: 'fund-science',
        name: 'Science',
        active: true,
        'Extended info': 'extended-science',
        'cover image': '//media.example/fund-science.jpg',
      },
      { _id: 'fund-film', Slug: 'fund-film', name: 'Film', active: false, 'Extended info': 'extended-film' },
    ],
    projectsubmission: [
      { Project: 'project-science', Fund: 'fund-science', Status: 'Curated', Submitted: true },
    ],
  };
}

describe('matching index v2', () => {
  it('builds official-content profiles without history-derived ranking text', async () => {
    const index = await buildMatchIndexV2(new FakeBubble(source()) as unknown as Bubble);
    expect(index.schemaVersion).toBe(2);
    expect(index.source).toEqual({ kind: 'artizen-api', projects: 1, funds: 2, relationships: 1 });
    expect(index.semantic?.modelRevision).toMatch(/^[a-f0-9]{40}$/);
    const fund = index.funds.find((candidate) => candidate.id === 'fund-science')!;
    expect(fund.profileText).toContain('Supporting decentralized laboratories and scientific researchers without truncation');
    expect(fund).not.toHaveProperty('derivedThemes');
    expect(fund.focusFacets).toContain('domain:science-research');
    expect(fund.profileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(index.projects[0].tags).toEqual(['Ocean', 'Science']);
    expect(index.projects[0].facets).toContain('domain:science-research');
  });

  it('folds the relationship table into each project so the split payloads can carry it', async () => {
    const index = await buildMatchIndexV2(new FakeBubble(source()) as unknown as Bubble);
    expect(index.projects[0].history).toEqual([['fund-science', 'curated']]);
    // The table stays for the combined document; the per-project pairs are what the browser reads.
    expect(index.relationships).toHaveLength(1);
  });

  it('rejects a project history that points at a fund the catalog does not have', async () => {
    const index = await buildMatchIndexV2(new FakeBubble(source()) as unknown as Bubble);
    const broken: MatchIndexV2 = {
      ...index,
      projects: index.projects.map((project) => ({ ...project, history: [['missing-fund', 'curated'] as const] })),
    };
    expect(() => validateMatchIndexV2(broken)).toThrow(/project history references a missing fund/);
  });

  it('rejects unexplained catalog drops greater than twenty percent', async () => {
    const first = await buildMatchIndexV2(new FakeBubble(source()) as unknown as Bubble);
    const reduced = source();
    reduced.fund = reduced.fund.slice(0, 1);
    reduced.fundextendedinfo = reduced.fundextendedinfo.slice(0, 1);
    await expect(
      buildMatchIndexV2(new FakeBubble(reduced) as unknown as Bubble, { previous: first }),
    ).rejects.toThrow('funds count dropped');
  });

  it('rejects invalid hashes, empty catalogs, and relationship references', async () => {
    const index = await buildMatchIndexV2(new FakeBubble(source()) as unknown as Bubble);
    expect(() => validateMatchIndexV2({ ...index, funds: [] } as MatchIndexV2)).toThrow('source counts');
    const invalidHash = structuredClone(index);
    invalidHash.funds[0].profileHash = 'bad';
    expect(() => validateMatchIndexV2(invalidHash)).toThrow('profile is invalid');
    const invalidRelationship = structuredClone(index);
    invalidRelationship.relationships[0].projectId = 'missing';
    expect(() => validateMatchIndexV2(invalidRelationship)).toThrow('missing record');
  });

  it('keeps the fit bands ordered and inside the range real scores reach', () => {
    const { strongThreshold, goodThreshold, exploratoryThreshold } = DEFAULT_SCORING_V2;
    expect(exploratoryThreshold).toBeLessThan(goodThreshold);
    expect(goodThreshold).toBeLessThan(strongThreshold);
    // Measured over the full catalog with scripts/calibrate-match-v2.mjs: rank-1 scores reach
    // p75 0.48 and p90 0.54. A strong threshold above that band is unreachable, which is how
    // "Strong fit" became a label no fund could ever earn.
    expect(strongThreshold).toBeLessThanOrEqual(0.5);
  });

  it('carries project and fund images without letting them reach the profile hash', async () => {
    const index = await buildMatchIndexV2(new FakeBubble(source()) as unknown as Bubble);
    expect(index.projects[0].image).toBe('https://media.example/project-science.jpg');
    expect(index.funds.find((fund) => fund.id === 'fund-science')?.image).toBe(
      'https://media.example/fund-science.jpg',
    );
    // Funds without a cover image stay undefined rather than carrying an empty string.
    expect(index.funds.find((fund) => fund.id === 'fund-film')?.image).toBeUndefined();

    // Images are display data. Keeping them out of profileText and profileHash is what lets a
    // precomputed semantic vector catalog survive an artwork change.
    const withoutImages = await buildMatchIndexV2(
      new FakeBubble(
        JSON.parse(
          JSON.stringify(source(), (key, value) =>
            key === 'cover image' || key === '(old) Artifact Image -crop' ? undefined : value,
          ),
        ),
      ) as unknown as Bubble,
    );
    for (const fund of index.funds) {
      const plain = withoutImages.funds.find((candidate) => candidate.id === fund.id);
      expect(plain?.profileHash).toBe(fund.profileHash);
      expect(plain?.profileText).toBe(fund.profileText);
    }
  });
});
