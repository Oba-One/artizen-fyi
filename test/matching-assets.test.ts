import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serializeVectorCatalog } from '../src/client/vector-catalog';
import { verifyMatchingReleaseAssets } from '../scripts/matching-assets.mjs';

const vectorVersion = 'model-taxonomy-256';
const dimensions = 256;

function vector(position: number): Float32Array {
  const values = new Float32Array(dimensions);
  values[position] = 1;
  return values;
}

function fixture(root: string): void {
  mkdirSync(join(root, 'match'), { recursive: true });
  mkdirSync(join(root, 'assets'), { recursive: true });
  const semantic = {
    vectorVersion,
    dimensions,
    projectVectorBuckets: 2,
  };
  const project = {
    id: 'green-goods',
    name: 'Green Goods',
    description: 'Regenerative public goods',
    tags: ['Climate'],
    context: { impact: 'Funds local environmental and social impact.' },
    semanticFingerprint: '0123456789abcdef',
  };
  const fund = { id: 'fund', profileText: 'Regenerative community funding' };
  const index = { indexVersion: 'release', semantic, projects: [project], funds: [fund] };
  writeFileSync(join(root, 'match/index.json'), JSON.stringify(index));
  writeFileSync(join(root, 'match/core.json'), JSON.stringify({ ...index, projects: [] }));
  writeFileSync(
    join(root, 'match/projects.json'),
    JSON.stringify({ indexVersion: index.indexVersion, projects: [{ ...project, context: undefined }] }),
  );
  writeFileSync(
    join(root, 'assets/match-fund-vectors.bin'),
    Buffer.from(
      serializeVectorCatalog(vectorVersion, dimensions, [
        { id: fund.id, fingerprint: 'fund-fingerprint', vector: vector(0) },
      ]),
    ),
  );
  writeFileSync(
    join(root, 'assets/match-project-vectors-0.bin'),
    Buffer.from(serializeVectorCatalog(vectorVersion, dimensions, [])),
  );
  writeFileSync(
    join(root, 'assets/match-project-vectors-1.bin'),
    Buffer.from(
      serializeVectorCatalog(vectorVersion, dimensions, [
        { id: project.id, fingerprint: project.semanticFingerprint, vector: vector(1) },
      ]),
    ),
  );
}

describe('matching release asset guard', () => {
  it('accepts one versioned release with full narratives and matching fingerprints', async () => {
    const root = mkdtempSync(join(tmpdir(), 'artizen-assets-test-'));
    try {
      fixture(root);
      await expect(verifyMatchingReleaseAssets(root, { vectorVersion })).resolves.toMatchObject({
        indexVersion: 'release',
        projects: 1,
        funds: 1,
        vectorVersion,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects the mixed build that caused catalog projects to fall back to baseline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'artizen-assets-test-'));
    try {
      fixture(root);
      await expect(verifyMatchingReleaseAssets(root, { vectorVersion: 'newer-taxonomy-version' })).rejects.toThrow(
        'the browser expects newer-taxonomy-version',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a compact project or vector built from different narrative text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'artizen-assets-test-'));
    try {
      fixture(root);
      const compact = {
        indexVersion: 'release',
        projects: [{ id: 'green-goods', semanticFingerprint: 'fedcba9876543210' }],
      };
      writeFileSync(join(root, 'match/projects.json'), JSON.stringify(compact));
      await expect(verifyMatchingReleaseAssets(root, { vectorVersion })).rejects.toThrow(
        'does not carry its full-text fingerprint',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
