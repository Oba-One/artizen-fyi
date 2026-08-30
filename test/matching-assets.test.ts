import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serializeVectorCatalog } from '../src/client/vector-catalog';
import { vectorBucket, vectorFingerprint } from '../src/matching/semantic-text';
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
        { id: fund.id, fingerprint: vectorFingerprint(fund.profileText), vector: vector(0) },
      ]),
    ),
  );
  const projectBucket = vectorBucket(project.id, semantic.projectVectorBuckets);
  for (let bucket = 0; bucket < semantic.projectVectorBuckets; bucket += 1) {
    writeFileSync(
      join(root, `assets/match-project-vectors-${bucket}.bin`),
      Buffer.from(
        serializeVectorCatalog(
          vectorVersion,
          dimensions,
          bucket === projectBucket
            ? [{ id: project.id, fingerprint: project.semanticFingerprint, vector: vector(1) }]
            : [],
        ),
      ),
    );
  }
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

  it('rejects fund vectors with stale ids or profileText fingerprints', async () => {
    const root = mkdtempSync(join(tmpdir(), 'artizen-assets-test-'));
    try {
      fixture(root);
      writeFileSync(
        join(root, 'assets/match-fund-vectors.bin'),
        Buffer.from(
          serializeVectorCatalog(vectorVersion, dimensions, [
            { id: 'stale-fund', fingerprint: vectorFingerprint('Old profile'), vector: vector(0) },
          ]),
        ),
      );
      await expect(verifyMatchingReleaseAssets(root, { vectorVersion })).rejects.toThrow(
        /unexpected record stale-fund/,
      );

      fixture(root);
      writeFileSync(
        join(root, 'assets/match-fund-vectors.bin'),
        Buffer.from(
          serializeVectorCatalog(vectorVersion, dimensions, [
            { id: 'fund', fingerprint: vectorFingerprint('Old profile'), vector: vector(0) },
          ]),
        ),
      );
      await expect(verifyMatchingReleaseAssets(root, { vectorVersion })).rejects.toThrow(
        /fund was built from different text/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a truncated vector payload even when its header is intact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'artizen-assets-test-'));
    try {
      fixture(root);
      const path = join(root, 'assets/match-fund-vectors.bin');
      const bytes = readFileSync(path);
      writeFileSync(path, bytes.subarray(0, bytes.byteLength - 4));

      await expect(verifyMatchingReleaseAssets(root, { vectorVersion })).rejects.toThrow(
        /payload is .* expected/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a project vector stored in the wrong shard', async () => {
    const root = mkdtempSync(join(tmpdir(), 'artizen-assets-test-'));
    try {
      fixture(root);
      const index = JSON.parse(readFileSync(join(root, 'match/index.json'), 'utf8'));
      const project = index.projects[0];
      const correct = vectorBucket(project.id, index.semantic.projectVectorBuckets);
      const wrong = (correct + 1) % index.semantic.projectVectorBuckets;
      writeFileSync(
        join(root, `assets/match-project-vectors-${correct}.bin`),
        Buffer.from(serializeVectorCatalog(vectorVersion, dimensions, [])),
      );
      writeFileSync(
        join(root, `assets/match-project-vectors-${wrong}.bin`),
        Buffer.from(
          serializeVectorCatalog(vectorVersion, dimensions, [
            { id: project.id, fingerprint: project.semanticFingerprint, vector: vector(1) },
          ]),
        ),
      );

      await expect(verifyMatchingReleaseAssets(root, { vectorVersion })).rejects.toThrow(
        /match-project-vectors-\d+\.bin contains (?:0 of 1|1 of 0) expected records/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
