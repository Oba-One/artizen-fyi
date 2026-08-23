import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { MatchIndexV2 } from '../src/artizen/types';

function index(kind: 'artizen-api' | 'fixture'): MatchIndexV2 {
  return {
    schemaVersion: 2,
    indexVersion: `${kind}-index`,
    generatedAt: '2026-08-23T00:00:00.000Z',
    source: { kind, projects: 1, funds: 1, relationships: 0 },
    taxonomyVersion: 'test',
    facets: [],
    projects: [{ id: 'project', slug: 'project', name: 'Project', description: 'Project description', tags: [], facets: [] }],
    funds: [
      {
        id: 'fund',
        slug: 'fund',
        name: 'Fund',
        active: true,
        themes: [],
        aliases: [],
        preferredTerms: [],
        excludedTerms: [],
        profileText: 'Fund profile',
        profileHash: 'a'.repeat(64),
        facets: [],
        focusFacets: [],
        coreConcepts: [],
      },
    ],
    relationships: [],
    scoring: {
      version: 'test',
      lexicalWeight: 0.4,
      facetWeight: 0.4,
      coreCoverageWeight: 0.2,
      semanticWeight: 0.55,
      semanticFacetWeight: 0.25,
      semanticCoreCoverageWeight: 0.15,
      semanticLexicalWeight: 0.05,
      strongThreshold: 0.55,
      goodThreshold: 0.34,
      exploratoryThreshold: 0.1,
      unsupportedFocusPenalty: 0.35,
    },
  };
}

function environment(value: MatchIndexV2): Env {
  return {
    CACHE: {
      async get(key: string) {
        return key === 'artizen/matching/v2' ? JSON.stringify(value) : null;
      },
      async put() {},
      async delete() {},
      async list() {
        return { keys: [], list_complete: true };
      },
    } as unknown as KVNamespace,
  } as Env;
}

describe('matching v2 routes', () => {
  it('rejects fixture indexes outside local QA', async () => {
    const response = await worker.fetch(
      new Request('https://artizen.fyi/match/index.v2.json'),
      environment(index('fixture')),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'matching_v2_index_unavailable' });
  });

  it('serves fixture indexes and blind review only on localhost', async () => {
    const env = environment(index('fixture'));
    expect((await worker.fetch(new Request('http://localhost/match/index.v2.json'), env)).status).toBe(200);
    expect((await worker.fetch(new Request('http://localhost/match/review'), env)).status).toBe(200);
    expect((await worker.fetch(new Request('https://artizen.fyi/match/review'), env)).status).toBe(404);
  });

  it('serves real indexes with a stable ETag', async () => {
    const env = environment(index('artizen-api'));
    const response = await worker.fetch(new Request('https://artizen.fyi/match/index.v2.json'), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"artizen-api-index"');
    const cached = await worker.fetch(
      new Request('https://artizen.fyi/match/index.v2.json', { headers: { 'if-none-match': '"artizen-api-index"' } }),
      env,
    );
    expect(cached.status).toBe(304);
  });
});
