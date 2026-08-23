import { describe, expect, it } from 'vitest';
import type { Bubble } from '../src/artizen/bubble';
import type { MatchIndexV1, Row } from '../src/artizen/types';
import { buildMatchIndex, validateMatchIndex } from '../src/matching/index';

class FakeBubble {
  constructor(private readonly rows: Record<string, Row[]>) {}

  async list(type: string): Promise<Row[]> {
    return this.rows[type] || [];
  }
}

function source(): Record<string, Row[]> {
  return {
    impacttag: [{ _id: 'tag-climate', name: 'Climate' }],
    project: [
      {
        _id: 'project-one',
        Slug: 'project-one',
        Name: 'Project One',
        Logline: 'A climate documentary',
        'impact tags (impact tag)': ['tag-climate'],
      },
      { _id: 'project-hidden', Name: 'Hidden Project', Hide: true },
    ],
    fundextendedinfo: [{ _id: 'extended-one', 'full title': 'Climate Story Fund', subtitle: 'Climate stories', 'for title': 'For filmmakers' }],
    fund: [
      {
        _id: 'fund-one',
        Slug: 'fund-one',
        name: 'Fund One',
        active: true,
        'Funding - current': 5000,
        'Extended info': 'extended-one',
      },
      { _id: 'fund-old', Slug: 'fund-old', name: 'Old Fund', active: false },
    ],
    projectsubmission: [
      { Project: 'project-one', Fund: 'fund-one', Status: 'Submitted', Submitted: true, 'season number': 4 },
      { Project: 'project-one', Fund: 'fund-one', Status: 'Curated', Submitted: true, 'season number': 5 },
      { Project: 'project-one', Fund: 'fund-old', Status: 'Curated', Submitted: true, '$ amount raised': 100, 'season number': 3 },
      { Project: 'project-hidden', Fund: 'fund-one', Status: 'Curated', Submitted: true },
    ],
  };
}

describe('matching index', () => {
  it('builds all historical funds and collapses relationship history', async () => {
    const index = await buildMatchIndex(new FakeBubble(source()) as unknown as Bubble);
    expect(index.schemaVersion).toBe(1);
    expect(index.indexVersion).toMatch(/^[a-f0-9]{20}$/);
    expect(index.projects.map((project) => project.id)).toEqual(['project-one']);
    expect(index.funds.map((fund) => fund.id)).toEqual(['fund-one', 'fund-old']);
    expect(index.relationships).toHaveLength(2);
    expect(index.relationships.find((row) => row.fundId === 'fund-one')?.kind).toBe('curated');
    expect(index.relationships.find((row) => row.fundId === 'fund-old')?.kind).toBe('funded');
    expect(index.funds.find((fund) => fund.id === 'fund-one')?.derivedThemes).toContain('Climate');
    expect(index.funds.find((fund) => fund.id === 'fund-old')?.active).toBe(false);
  });

  it('refuses to replace the index with an empty catalog', async () => {
    await expect(buildMatchIndex(new FakeBubble({}) as unknown as Bubble)).rejects.toThrow('catalog is empty');
  });

  it('validates relationship references and normalized weights', () => {
    const invalid = {
      schemaVersion: 1,
      indexVersion: 'bad',
      generatedAt: '2026-08-22T00:00:00.000Z',
      projects: [{ id: 'p', slug: 'p', name: 'P', description: 'Project', tags: [] }],
      funds: [
        {
          id: 'f',
          slug: 'f',
          name: 'F',
          active: true,
          themes: [],
          derivedThemes: [],
          aliases: [],
          preferredTerms: [],
          excludedTerms: [],
        },
      ],
      relationships: [{ projectId: 'missing', fundId: 'f', kind: 'curated' }],
      scoring: {
        contentWeight: 0.45,
        tagWeight: 0.25,
        graphWeight: 0.3,
        directRelationshipShare: 0.6,
        similarProjectLimit: 20,
        fundHistoryLimit: 24,
      },
    } satisfies MatchIndexV1;
    expect(() => validateMatchIndex(invalid)).toThrow('missing record');
  });
});
