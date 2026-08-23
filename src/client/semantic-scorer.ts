/// <reference lib="webworker" />

import type { MatchIndexV2, ProjectMatchInput, SemanticScorer } from '../artizen/types';

type EmbeddingTensor = { data: ArrayLike<number>; dims: number[] };
type FeatureExtractor = {
  (texts: string | string[], options: { pooling: 'mean'; normalize: boolean }): Promise<EmbeddingTensor>;
  dispose(): Promise<void>;
};
type VectorRecord = { fundId: string; profileHash: string };
type VectorHeader = { vectorVersion: string; dimensions: number; records: VectorRecord[] };

function projectText(input: ProjectMatchInput): string {
  return [input.title, input.description, ...input.tags].filter(Boolean).join('. ');
}

function truncateAndNormalize(values: ArrayLike<number>, offset: number, dimensions: number): Float32Array {
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

function cosine(left: Float32Array, right: Float32Array): number {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return Math.max(0, Math.min(1, score));
}

function parseVectorCatalog(buffer: ArrayBuffer, index: MatchIndexV2): Map<string, Float32Array> {
  const bytes = new Uint8Array(buffer);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== 'AMV2') throw new Error('Invalid semantic vector catalog');
  const view = new DataView(buffer);
  const jsonLength = view.getUint32(4, true);
  const dataOffset = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + jsonLength))) as VectorHeader;
  if (header.vectorVersion !== index.semantic?.vectorVersion || header.dimensions !== index.semantic.dimensions) {
    throw new Error('Stale semantic vector catalog');
  }
  const expectedHashes = new Map(index.funds.map((fund) => [fund.id, fund.profileHash]));
  const values = new Float32Array(buffer, dataOffset);
  const vectors = new Map<string, Float32Array>();
  header.records.forEach((record, recordIndex) => {
    if (expectedHashes.get(record.fundId) !== record.profileHash) return;
    const start = recordIndex * header.dimensions;
    vectors.set(record.fundId, values.slice(start, start + header.dimensions));
  });
  return vectors;
}

function serializeVectorCatalog(index: MatchIndexV2, vectors: Map<string, Float32Array>): ArrayBuffer {
  const manifest = index.semantic;
  if (!manifest) throw new Error('Semantic matching is not configured');
  const records = index.funds
    .filter((fund) => vectors.has(fund.id))
    .map((fund) => ({ fundId: fund.id, profileHash: fund.profileHash }));
  const header: VectorHeader = { vectorVersion: manifest.vectorVersion, dimensions: manifest.dimensions, records };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const dataOffset = 12 + Math.ceil(json.byteLength / 4) * 4;
  const buffer = new ArrayBuffer(dataOffset + records.length * manifest.dimensions * 4);
  const bytes = new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode('AMV2'), 0);
  const view = new DataView(buffer);
  view.setUint32(4, json.byteLength, true);
  view.setUint32(8, dataOffset, true);
  bytes.set(json, 12);
  const values = new Float32Array(buffer, dataOffset);
  records.forEach((record, recordIndex) => values.set(vectors.get(record.fundId)!, recordIndex * manifest.dimensions));
  return buffer;
}

async function webGpuAvailable(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

export class LocalSemanticScorer implements SemanticScorer {
  private extractor: FeatureExtractor | undefined;
  private vectors = new Map<string, Float32Array>();

  constructor(private readonly index: MatchIndexV2) {}

  async load(onProgress: (progress: number) => void): Promise<void> {
    const manifest = this.index.semantic;
    if (!manifest) throw new Error('Semantic matching is not configured');
    const transformers = await import('@huggingface/transformers');
    transformers.env.allowRemoteModels = false;
    transformers.env.allowLocalModels = true;
    transformers.env.localModelPath = manifest.modelPath;
    transformers.env.useBrowserCache = true;
    transformers.env.useWasmCache = true;
    const onnx = transformers.env.backends.onnx as { wasm?: { wasmPaths?: string; numThreads?: number } };
    onnx.wasm ||= {};
    onnx.wasm.wasmPaths = manifest.wasmPath;
    onnx.wasm.numThreads = Math.max(1, Math.min(2, navigator.hardwareConcurrency || 1));

    const progressCallback = (event: unknown) => {
      const row = event as { progress?: number };
      if (typeof row.progress === 'number') onProgress(Math.min(0.75, Math.max(0, row.progress / 100) * 0.75));
    };
    const options = {
      dtype: manifest.dtype,
      revision: manifest.modelRevision,
      local_files_only: true,
      progress_callback: progressCallback,
    } as const;
    if (await webGpuAvailable()) {
      try {
        this.extractor = (await transformers.pipeline('feature-extraction', manifest.modelId, {
          ...options,
          device: 'webgpu',
        })) as unknown as FeatureExtractor;
      } catch {
        this.extractor = undefined;
      }
    }
    this.extractor ||= (await transformers.pipeline('feature-extraction', manifest.modelId, {
      ...options,
      device: 'wasm',
    })) as unknown as FeatureExtractor;
    this.vectors = await this.loadFundVectors(onProgress);
    onProgress(1);
  }

  async score(input: ProjectMatchInput, fundIds: string[]): Promise<Map<string, number>> {
    if (!this.extractor || !this.index.semantic) throw new Error('Local semantic model is not loaded');
    const output = await this.extractor(projectText(input), { pooling: 'mean', normalize: true });
    const query = truncateAndNormalize(output.data, 0, this.index.semantic.dimensions);
    const scores = new Map<string, number>();
    for (const fundId of fundIds) {
      const vector = this.vectors.get(fundId);
      if (vector) scores.set(fundId, cosine(query, vector));
    }
    query.fill(0);
    return scores;
  }

  dispose(): void {
    void this.extractor?.dispose();
    this.extractor = undefined;
    this.vectors.clear();
  }

  private async loadFundVectors(onProgress: (progress: number) => void): Promise<Map<string, Float32Array>> {
    const manifest = this.index.semantic!;
    const cacheRequest = new Request(`/assets/.computed-${manifest.vectorVersion}.bin`);
    let vectors = new Map<string, Float32Array>();
    try {
      const cache = await caches.open('artizen-semantic-fund-vectors-v1');
      const cached = await cache.match(cacheRequest);
      if (cached) vectors = parseVectorCatalog(await cached.arrayBuffer(), this.index);
    } catch {
      // Cache access is optional. The public vector catalog remains the next source.
    }
    if (vectors.size === 0) {
      try {
        const response = await fetch(manifest.vectorsUrl, { cache: 'force-cache' });
        if (response.ok) vectors = parseVectorCatalog(await response.arrayBuffer(), this.index);
      } catch {
        // Missing precomputed vectors are calculated locally below.
      }
    }
    const missing = this.index.funds.filter((fund) => !vectors.has(fund.id));
    for (let start = 0; start < missing.length; start += 12) {
      const batch = missing.slice(start, start + 12);
      const output = await this.extractor!(batch.map((fund) => fund.profileText), {
        pooling: 'mean',
        normalize: true,
      });
      const fullDimensions = output.dims.at(-1) || manifest.dimensions;
      batch.forEach((fund, index) => {
        vectors.set(fund.id, truncateAndNormalize(output.data, index * fullDimensions, manifest.dimensions));
      });
      onProgress(0.75 + 0.25 * Math.min(1, (start + batch.length) / Math.max(1, missing.length)));
    }
    if (missing.length) {
      try {
        const cache = await caches.open('artizen-semantic-fund-vectors-v1');
        await cache.put(cacheRequest, new Response(serializeVectorCatalog(this.index, vectors)));
      } catch {
        // Storage failure must not prevent this in-memory scoring session.
      }
    }
    return vectors;
  }
}
