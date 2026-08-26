/// <reference lib="webworker" />

type VectorRecord = { id: string; fingerprint: string };
type VectorHeader = { vectorVersion: string; dimensions: number; records: VectorRecord[] };

/**
 * Binary catalogs of precomputed embeddings. Deliberately free of any transformers.js import so
 * that scoring an existing catalog project never pulls the model bundle into the worker.
 *
 * Layout: "AMV3" | uint32 json length | uint32 data offset | JSON header | float32 vectors.
 */
const MAGIC = 'AMV3';

export function parseVectorCatalog(
  buffer: ArrayBuffer,
  manifest: { vectorVersion: string; dimensions: number },
  expected: Map<string, string>,
): Map<string, Float32Array> {
  const bytes = new Uint8Array(buffer);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) throw new Error('Invalid semantic vector catalog');
  const view = new DataView(buffer);
  const jsonLength = view.getUint32(4, true);
  const dataOffset = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + jsonLength))) as VectorHeader;
  if (header.vectorVersion !== manifest.vectorVersion || header.dimensions !== manifest.dimensions) {
    throw new Error('Stale semantic vector catalog');
  }
  const values = new Float32Array(buffer, dataOffset);
  const vectors = new Map<string, Float32Array>();
  header.records.forEach((record, recordIndex) => {
    // A record whose source text has changed since the catalog was built is skipped, not trusted.
    if (expected.get(record.id) !== record.fingerprint) return;
    const start = recordIndex * header.dimensions;
    vectors.set(record.id, values.slice(start, start + header.dimensions));
  });
  return vectors;
}

export function serializeVectorCatalog(
  vectorVersion: string,
  dimensions: number,
  entries: Array<{ id: string; fingerprint: string; vector: Float32Array }>,
): ArrayBuffer {
  const header: VectorHeader = {
    vectorVersion,
    dimensions,
    records: entries.map(({ id, fingerprint }) => ({ id, fingerprint })),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const dataOffset = 12 + Math.ceil(json.byteLength / 4) * 4;
  const buffer = new ArrayBuffer(dataOffset + entries.length * dimensions * 4);
  const bytes = new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode(MAGIC), 0);
  const view = new DataView(buffer);
  view.setUint32(4, json.byteLength, true);
  view.setUint32(8, dataOffset, true);
  bytes.set(json, 12);
  const values = new Float32Array(buffer, dataOffset);
  entries.forEach((entry, entryIndex) => values.set(entry.vector, entryIndex * dimensions));
  return buffer;
}

export function truncateAndNormalize(values: ArrayLike<number>, offset: number, dimensions: number): Float32Array {
  const result = new Float32Array(dimensions);
  let norm = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const value = Number(values[offset + index] || 0);
    result[index] = value;
    norm += value * value;
  }
  if (norm > 0) {
    const scale = 1 / Math.sqrt(norm);
    for (let index = 0; index < result.length; index += 1) result[index] *= scale;
  }
  return result;
}

export function cosine(left: Float32Array, right: Float32Array): number {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return Math.max(0, Math.min(1, score));
}

export function scoreAgainstFunds(
  query: Float32Array,
  fundVectors: Map<string, Float32Array>,
  fundIds: string[],
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const fundId of fundIds) {
    const vector = fundVectors.get(fundId);
    if (vector) scores.set(fundId, cosine(query, vector));
  }
  return scores;
}
