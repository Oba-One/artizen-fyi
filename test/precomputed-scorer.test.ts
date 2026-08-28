import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchIndex } from '../src/artizen/types';
import { PrecomputedSemanticScorer } from '../src/client/precomputed-scorer';
import { serializeVectorCatalog } from '../src/client/vector-catalog';
import { semanticManifest } from '../src/matching/semantic-config';
import { projectVectorText, vectorBucket, vectorFingerprint } from '../src/matching/semantic-text';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function vector(dimensions: number, position: number): Float32Array {
  const result = new Float32Array(dimensions);
  result[position % dimensions] = 1;
  return result;
}

describe('precomputed semantic vectors', () => {
  it('retries transient fund-catalog and project-shard failures', async () => {
    const index = JSON.parse(readFileSync('test/fixtures/match-index.json', 'utf8')) as MatchIndex;
    const manifest = semanticManifest(index)!;
    const fullProject = index.projects.find((project) => project.context)!;
    const project = {
      ...fullProject,
      context: undefined,
      semanticFingerprint: vectorFingerprint(projectVectorText(fullProject)),
    };
    const compactIndex = {
      ...index,
      projects: index.projects.map((candidate) => (candidate.id === project.id ? project : candidate)),
    };
    const shardUrl = `${manifest.projectVectorPrefix}${vectorBucket(project.id, manifest.projectVectorBuckets)}.bin`;
    const fundCatalog = serializeVectorCatalog(
      manifest.vectorVersion,
      manifest.dimensions,
      index.funds.map((fund, position) => ({
        id: fund.id,
        fingerprint: vectorFingerprint(fund.profileText),
        vector: vector(manifest.dimensions, position),
      })),
    );
    const projectCatalog = serializeVectorCatalog(manifest.vectorVersion, manifest.dimensions, [
      {
        id: project.id,
        fingerprint: vectorFingerprint(projectVectorText(fullProject)),
        vector: vector(manifest.dimensions, 0),
      },
    ]);
    let fundAttempts = 0;
    let shardAttempts = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === manifest.vectorsUrl) {
        fundAttempts += 1;
        return fundAttempts === 1 ? new Response(null, { status: 503 }) : new Response(fundCatalog);
      }
      if (url === shardUrl) {
        shardAttempts += 1;
        return shardAttempts === 1 ? new Response(null, { status: 503 }) : new Response(projectCatalog);
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const scorer = new PrecomputedSemanticScorer(compactIndex);

    expect(await scorer.load()).toBe(false);
    expect(scorer.loadFallback).toBe('assets-unavailable');
    expect(await scorer.load()).toBe(true);

    const input = {
      projectId: project.id,
      title: project.name,
      description: project.description,
      tags: project.tags,
    };
    expect(await scorer.score(input)).toEqual({ fallback: 'assets-unavailable' });
    const recovered = await scorer.score(input);

    expect(recovered.scores?.size).toBe(index.funds.length);
    scorer.updateProjects(index.projects);
    expect((await scorer.score(input)).scores?.size).toBe(index.funds.length);
    expect(await scorer.score({ ...input, description: 'An edited description' })).toEqual({ downgrade: 'edited' });
    expect(fundAttempts).toBe(2);
    expect(shardAttempts).toBe(2);
  });

  it('reports stale prepared assets instead of silently looking like a baseline success', async () => {
    const index = JSON.parse(readFileSync('test/fixtures/match-index.json', 'utf8')) as MatchIndex;
    const manifest = semanticManifest(index)!;
    const staleCatalog = serializeVectorCatalog(
      'an-older-vector-version',
      manifest.dimensions,
      index.funds.map((fund, position) => ({
        id: fund.id,
        fingerprint: vectorFingerprint(fund.profileText),
        vector: vector(manifest.dimensions, position),
      })),
    );
    globalThis.fetch = vi.fn(async () => new Response(staleCatalog)) as typeof fetch;
    const scorer = new PrecomputedSemanticScorer(index);

    expect(await scorer.load()).toBe(false);
    expect(scorer.loadFallback).toBe('assets-stale');
  });
});
