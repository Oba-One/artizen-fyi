import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env, pipeline } from '@huggingface/transformers';

const inputPath = process.argv[2];
const outputPath = process.argv[3] || 'public/assets/match-fund-vectors-v1.bin';
if (!inputPath) {
  console.error('Usage: npm run build:semantic-vectors -- <match-index-v2.json> [output.bin]');
  process.exitCode = 1;
} else {
  const index = JSON.parse(await readFile(inputPath, 'utf8'));
  if (index.schemaVersion !== 2 || !index.semantic || !Array.isArray(index.funds)) {
    throw new Error('A MatchIndexV2 with a semantic manifest is required');
  }
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = `${resolve('public/assets/models')}/`;
  env.useFSCache = false;
  const extractor = await pipeline('feature-extraction', index.semantic.modelId, {
    dtype: index.semantic.dtype,
    revision: index.semantic.modelRevision,
    local_files_only: true,
    device: 'cpu',
  });
  const dimensions = index.semantic.dimensions;
  const vectors = [];
  for (let start = 0; start < index.funds.length; start += 16) {
    const batch = index.funds.slice(start, start + 16);
    const output = await extractor(batch.map((fund) => fund.profileText), { pooling: 'mean', normalize: true });
    const fullDimensions = output.dims.at(-1);
    if (!fullDimensions || fullDimensions < dimensions) throw new Error('Model returned an invalid embedding shape');
    batch.forEach((_fund, batchIndex) => {
      const vector = new Float32Array(dimensions);
      let norm = 0;
      for (let index = 0; index < dimensions; index += 1) {
        const value = Number(output.data[batchIndex * fullDimensions + index] || 0);
        vector[index] = value;
        norm += value * value;
      }
      const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
      for (let index = 0; index < vector.length; index += 1) vector[index] *= scale;
      vectors.push(vector);
    });
    console.log(`Embedded ${Math.min(start + batch.length, index.funds.length)}/${index.funds.length} funds`);
  }
  await extractor.dispose();
  const header = {
    vectorVersion: index.semantic.vectorVersion,
    dimensions,
    records: index.funds.map((fund) => ({ fundId: fund.id, profileHash: fund.profileHash })),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const dataOffset = 12 + Math.ceil(json.byteLength / 4) * 4;
  const buffer = new ArrayBuffer(dataOffset + vectors.length * dimensions * 4);
  const bytes = new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode('AMV2'), 0);
  const view = new DataView(buffer);
  view.setUint32(4, json.byteLength, true);
  view.setUint32(8, dataOffset, true);
  bytes.set(json, 12);
  const values = new Float32Array(buffer, dataOffset);
  vectors.forEach((vector, vectorIndex) => values.set(vector, vectorIndex * dimensions));
  await writeFile(outputPath, bytes);
  console.log(`Semantic fund vectors: ${bytes.byteLength} bytes at ${outputPath}`);
}
