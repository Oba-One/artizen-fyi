import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { MatchIndex } from '../src/artizen/types';

function index(kind: 'artizen-api' | 'fixture'): MatchIndex {
  return {
    schemaVersion: 2,
    indexVersion: `${kind}-index`,
    generatedAt: '2026-08-23T00:00:00.000Z',
    source: { kind, projects: 1, funds: 1, relationships: 0 },
    taxonomyVersion: 'test',
    facets: [],
    projects: [
      {
        id: 'project',
        slug: 'project',
        name: 'Project',
        description: 'Project description',
        tags: [],
        context: { impact: 'A detailed project impact narrative.' },
        facets: [],
        history: [['fund', 'curated']],
      },
    ],
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

function environment(value: MatchIndex): Env {
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

describe('matching routes', () => {
  it('serves deployed split assets without reading or parsing the combined KV index', async () => {
    let cacheReads = 0;
    const env = {
      CACHE: {
        async get() {
          cacheReads += 1;
          throw new Error('production matching routes must not read KV');
        },
      },
      ASSETS: {
        async fetch(request: Request) {
          const url = new URL(request.url);
          return Response.json({ assetPath: url.pathname });
        },
      },
    } as unknown as Env;

    const core = await worker.fetch(new Request('https://artizen.fyi/match/core.json'), env);
    expect(await core.json()).toEqual({ assetPath: '/match/core.json' });

    const project = await worker.fetch(new Request('https://artizen.fyi/match/project/project-id.json'), env);
    const body = (await project.json()) as { assetPath: string };
    expect(body.assetPath).toMatch(/^\/match\/project\/[a-f0-9]{64}\.json$/);
    expect(cacheReads).toBe(0);
  });

  it('uses the release-scoped static catalog locally when assets are available', async () => {
    let cacheReads = 0;
    const env = {
      CACHE: {
        async get() {
          cacheReads += 1;
          throw new Error('local matching must not mix KV catalog JSON with static vector assets');
        },
      },
      ASSETS: {
        async fetch(request: Request) {
          return Response.json({ assetPath: new URL(request.url).pathname });
        },
      },
    } as unknown as Env;

    const core = await worker.fetch(new Request('http://localhost/match/core.json'), env);
    expect(await core.json()).toEqual({ assetPath: '/match/core.json' });
    const project = await worker.fetch(new Request('http://localhost/match/project/project-id.json'), env);
    expect(((await project.json()) as { assetPath: string }).assetPath).toMatch(
      /^\/match\/project\/[a-f0-9]{64}\.json$/,
    );
    expect(cacheReads).toBe(0);
  });

  it('rejects fixture indexes outside local QA', async () => {
    const response = await worker.fetch(
      new Request('https://artizen.fyi/match/index.json'),
      environment(index('fixture')),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'matching_index_unavailable' });
  });

  it('serves fixture indexes and blind review only on localhost', async () => {
    const env = environment(index('fixture'));
    expect((await worker.fetch(new Request('http://localhost/match/index.json'), env)).status).toBe(200);
    expect((await worker.fetch(new Request('http://localhost/match/review'), env)).status).toBe(200);
    expect((await worker.fetch(new Request('https://artizen.fyi/match/review'), env)).status).toBe(404);
  });

  it('keeps the split payloads to what each page needs', async () => {
    const env = environment(index('artizen-api'));
    const core = await worker.fetch(new Request('https://artizen.fyi/match/core.json'), env);
    expect(core.status).toBe(200);
    const coreBody = (await core.json()) as MatchIndex;
    expect(coreBody.funds).toHaveLength(1);
    expect(coreBody.projects).toEqual([]);
    expect(coreBody.relationships).toEqual([]);

    const projects = await worker.fetch(new Request('https://artizen.fyi/match/projects.json'), env);
    const projectsBody = (await projects.json()) as { projects: MatchIndex['projects'] };
    expect(projectsBody.projects).toHaveLength(1);
    expect(projectsBody.projects[0].history).toEqual([['fund', 'curated']]);
    expect(projectsBody.projects[0]).not.toHaveProperty('context');

    const one = await worker.fetch(new Request('https://artizen.fyi/match/project/project.json'), env);
    const oneBody = (await one.json()) as { projects: MatchIndex['projects'] };
    expect(oneBody.projects.map((project) => project.id)).toEqual(['project']);
    expect(oneBody.projects[0].context?.impact).toBe('A detailed project impact narrative.');

    const missing = await worker.fetch(new Request('https://artizen.fyi/match/project/nope.json'), env);
    expect(missing.status).toBe(404);
  });

  it('gives each split payload its own validator so one cannot satisfy another', async () => {
    const env = environment(index('artizen-api'));
    const core = await worker.fetch(new Request('https://artizen.fyi/match/core.json'), env);
    const etag = core.headers.get('etag');
    expect(etag).toBe('"artizen-api-index-core"');
    const projects = await worker.fetch(new Request('https://artizen.fyi/match/projects.json'), env);
    expect(projects.headers.get('etag')).toBe('"artizen-api-index-projects"');
    const revalidated = await worker.fetch(
      new Request('https://artizen.fyi/match/core.json', { headers: { 'if-none-match': etag as string } }),
      env,
    );
    expect(revalidated.status).toBe(304);
  });

  it('keeps catalog text out of the response headers', async () => {
    // Slugs come from Bubble, so one can hold anything. A percent-encoded newline reaching the
    // ETag makes the Headers constructor throw and the route 500s.
    const hostile = index('artizen-api');
    hostile.projects[0].slug = 'a"b\r\nX-Injected: 1';
    const env = environment(hostile);
    const response = await worker.fetch(
      new Request(`https://artizen.fyi/match/project/${encodeURIComponent(hostile.projects[0].slug)}.json`),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"artizen-api-index-project"');
    expect(response.headers.get('x-injected')).toBeNull();
  });

  it('withholds fixture catalogs from the split payloads too', async () => {
    const env = environment(index('fixture'));
    for (const path of ['/match/core.json', '/match/projects.json', '/match/project/project.json']) {
      expect((await worker.fetch(new Request(`https://artizen.fyi${path}`), env)).status).toBe(503);
      expect((await worker.fetch(new Request(`http://localhost${path}`), env)).status).toBe(200);
    }
  });

  it('serves real indexes with a stable ETag', async () => {
    const env = environment(index('artizen-api'));
    const response = await worker.fetch(new Request('https://artizen.fyi/match/index.json'), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"artizen-api-index"');
    const cached = await worker.fetch(
      new Request('https://artizen.fyi/match/index.json', { headers: { 'if-none-match': '"artizen-api-index"' } }),
      env,
    );
    expect(cached.status).toBe(304);
  });
});
