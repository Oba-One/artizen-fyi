import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { env, pipeline } from '@huggingface/transformers';

// Emits the precomputed embedding catalogs:
//   match-fund-vectors-v2.bin       - so on-device scoring only has to embed the project text
//   match-project-vectors-v2-N.bin  - so an existing catalog project needs no model at all
// The project vectors are sharded because a page scores one project: a single file meant a project
// page downloaded 3 MB to read one kilobyte of it.
const inputPath = process.argv[2];
const outputDir = process.argv[3] || 'public/assets';
if (!inputPath) {
  console.error('Usage: npm run build:semantic-vectors -- <match-index-v2.json | url> [output-dir]');
  process.exitCode = 1;
} else {
  // A URL is accepted so the vectors can be built straight from a deployed catalog, which is the
  // only place the current index lives once the cron has written it to KV.
  let index;
  if (/^https?:\/\//.test(inputPath)) {
    const response = await fetch(inputPath, { headers: { Accept: 'application/json' } });
    // Without this the Worker's 503 body parses as JSON and fails later with a misleading
    // "not a MatchIndexV2", or as HTML with a bare SyntaxError naming no URL.
    if (!response.ok) throw new Error(`Could not fetch the matching index (${response.status}): ${inputPath}`);
    index = await response.json();
  } else {
    index = JSON.parse(await readFile(inputPath, 'utf8'));
  }
  if (index.schemaVersion !== 2 || !index.semantic || !Array.isArray(index.funds) || !Array.isArray(index.projects)) {
    throw new Error('A MatchIndexV2 with a semantic manifest, funds, and projects is required');
  }
  await mkdir(outputDir, { recursive: true });

  // The text and fingerprint rules are shared with the browser so a vector is never matched
  // against text the record no longer has.
  const temp = await mkdtemp(join(tmpdir(), 'artizen-vectors-'));
  const shim = join(temp, 'shared.mjs');
  try {
  await build({
    stdin: {
      contents: `export { projectVectorText, vectorFingerprint } from ${JSON.stringify(join(process.cwd(), 'src/matching/semantic-text.ts'))};
                 export { SEMANTIC_CATALOG } from ${JSON.stringify(join(process.cwd(), 'src/matching/semantic-config.ts'))};
                 export { vectorBucket } from ${JSON.stringify(join(process.cwd(), 'src/matching/semantic-text.ts'))};
                 export { serializeVectorCatalog } from ${JSON.stringify(join(process.cwd(), 'src/client/vector-catalog.ts'))};`,
      resolveDir: process.cwd(),
      sourcefile: 'vectors-entry.ts',
    },
    outfile: shim,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  });
  const { projectVectorText, vectorFingerprint, vectorBucket, serializeVectorCatalog, SEMANTIC_CATALOG } =
    await import(pathToFileURL(shim).href);
  // Version and dimensions come from the same constant the browser reads, never from the index -
  // otherwise a config change here and a catalog rebuild have to land in lockstep.
  const manifest = SEMANTIC_CATALOG;

  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = `${resolve('public/assets/models')}/`;
  env.useFSCache = false;
  const extractor = await pipeline('feature-extraction', manifest.modelId, {
    dtype: manifest.dtype,
    revision: manifest.modelRevision,
    local_files_only: true,
    device: 'cpu',
  });

  const dimensions = manifest.dimensions;
  async function embedAll(label, items, textOf) {
    const vectors = [];
    for (let start = 0; start < items.length; start += 16) {
      const batch = items.slice(start, start + 16);
      const output = await extractor(batch.map(textOf), { pooling: 'mean', normalize: true });
      const full = output.dims.at(-1);
      if (!full || full < dimensions) throw new Error('Model returned an invalid embedding shape');
      batch.forEach((_item, batchIndex) => {
        const vector = new Float32Array(dimensions);
        let norm = 0;
        for (let i = 0; i < dimensions; i += 1) {
          const value = Number(output.data[batchIndex * full + i] || 0);
          vector[i] = value;
          norm += value * value;
        }
        const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
        for (let i = 0; i < vector.length; i += 1) vector[i] *= scale;
        vectors.push(vector);
      });
      if ((start / 16) % 10 === 0 || start + 16 >= items.length) {
        console.log(`Embedded ${Math.min(start + batch.length, items.length)}/${items.length} ${label}`);
      }
    }
    return vectors;
  }

  async function writeCatalog(filename, items, textOf, vectors, quiet = false) {
    const entries = items.map((item, itemIndex) => ({
      id: item.id,
      fingerprint: vectorFingerprint(textOf(item)),
      vector: vectors[itemIndex],
    }));
    const buffer = serializeVectorCatalog(manifest.vectorVersion, dimensions, entries);
    const path = join(outputDir, filename);
    await writeFile(path, Buffer.from(buffer));
    if (!quiet) console.log(`${filename}: ${entries.length} vectors, ${buffer.byteLength} bytes`);
    return buffer.byteLength;
  }

  const fundText = (fund) => fund.profileText;
  const projectText = (project) => projectVectorText(project);
  const fundVectors = await embedAll('funds', index.funds, fundText);
  const projectVectors = await embedAll('projects', index.projects, projectText);
  await extractor.dispose();

  await writeCatalog('match-fund-vectors-v2.bin', index.funds, fundText, fundVectors);

  const buckets = SEMANTIC_CATALOG.projectVectorBuckets;
  const sharded = Array.from({ length: buckets }, () => []);
  index.projects.forEach((project, position) => {
    sharded[vectorBucket(project.id, buckets)].push({ project, vector: projectVectors[position] });
  });
  let shardBytes = 0;
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    // Empty shards are written too: a project id that hashes into one should read an empty catalog
    // and fall back, not take a 404 as a broken deployment.
    const rows = sharded[bucket];
    shardBytes += await writeCatalog(
      `match-project-vectors-v2-${bucket}.bin`,
      rows.map((row) => row.project),
      projectText,
      rows.map((row) => row.vector),
      true,
    );
  }
  console.log(
    `match-project-vectors-v2-*.bin: ${index.projects.length} vectors across ${buckets} shards, ` +
      `${shardBytes} bytes total, ${Math.round(shardBytes / buckets)} bytes median fetch`,
  );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
