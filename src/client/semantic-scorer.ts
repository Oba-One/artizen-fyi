import type { MatchIndex, ProjectMatchInput, SemanticScorer } from '../artizen/types';
import { semanticManifest } from '../matching/semantic-config';
import { matchInputVectorText, vectorFingerprint } from '../matching/semantic-text';
import { cosine, parseVectorCatalog, scoreAgainstFunds, serializeVectorCatalog, truncateAndNormalize } from './vector-catalog';

type EmbeddingTensor = { data: ArrayLike<number>; dims: number[] };
type FeatureExtractor = {
  (texts: string | string[], options: { pooling: 'mean'; normalize: boolean }): Promise<EmbeddingTensor>;
  dispose(): Promise<void>;
};

function projectText(input: ProjectMatchInput): string {
  return matchInputVectorText(input);
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
  // Created with the scorer, not after the transformers chunk resolves. A cancel message can
  // arrive while either dynamic import is still pending; keeping the signal alive from
  // construction makes that cancellation visible before any model request can start.
  private readonly abortController = new AbortController();
  private restoreFetch: (() => void) | undefined;

  constructor(private readonly index: MatchIndex) {}

  async load(onProgress: (progress: number) => void): Promise<void> {
    const manifest = semanticManifest(this.index);
    if (!manifest) throw new Error('Semantic matching is not configured');
    this.throwIfCancelled();
    const transformers = await import('@huggingface/transformers');
    this.throwIfCancelled();
    const controller = this.abortController;
    const previousFetch = transformers.env.fetch;
    const abortableFetch: typeof fetch = (input, init = {}) =>
      globalThis.fetch(input, { ...init, signal: controller.signal });
    transformers.env.fetch = abortableFetch;
    this.restoreFetch = () => {
      if (transformers.env.fetch === abortableFetch) transformers.env.fetch = previousFetch;
      this.restoreFetch = undefined;
    };
    transformers.env.allowRemoteModels = false;
    transformers.env.allowLocalModels = true;
    transformers.env.localModelPath = manifest.modelPath;
    transformers.env.useBrowserCache = true;
    transformers.env.useWasmCache = true;
    const onnx = transformers.env.backends.onnx as { wasm?: { wasmPaths?: string; numThreads?: number } };
    onnx.wasm ||= {};
    onnx.wasm.wasmPaths = manifest.wasmPath;
    // Threaded ORT needs SharedArrayBuffer, which needs cross-origin isolation. This site loads
    // Bootstrap, Bootstrap Icons, DataTables, and its fonts from third-party CDNs, so COOP/COEP is
    // not on the table. Asking for threads here only produced a silent, slower fallback.
    onnx.wasm.numThreads = 1;

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
    try {
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
      this.throwIfCancelled();
      this.vectors = await this.loadFundVectors(onProgress);
      this.throwIfCancelled();
      onProgress(1);
    } finally {
      this.restoreFetch?.();
    }
  }

  async score(input: ProjectMatchInput, fundIds: string[]): Promise<Map<string, number>> {
    const manifest = semanticManifest(this.index);
    if (!this.extractor || !manifest) throw new Error('Local semantic model is not loaded');
    const output = await this.extractor(projectText(input), { pooling: 'mean', normalize: true });
    const query = truncateAndNormalize(output.data, 0, manifest.dimensions);
    const scores = scoreAgainstFunds(query, this.vectors, fundIds);
    query.fill(0);
    return scores;
  }

  dispose(): void {
    this.abortController.abort();
    this.restoreFetch?.();
    void this.extractor?.dispose();
    this.extractor = undefined;
    this.vectors.clear();
  }

  private fundFingerprints(): Map<string, string> {
    return new Map(this.index.funds.map((fund) => [fund.id, vectorFingerprint(fund.profileText)]));
  }

  private throwIfCancelled(): void {
    if (this.abortController.signal.aborted) {
      throw new DOMException('Local AI loading was cancelled', 'AbortError');
    }
  }

  private serializeFunds(vectors: Map<string, Float32Array>): ArrayBuffer {
    const manifest = semanticManifest(this.index)!;
    return serializeVectorCatalog(
      manifest.vectorVersion,
      manifest.dimensions,
      this.index.funds
        .filter((fund) => vectors.has(fund.id))
        .map((fund) => ({ id: fund.id, fingerprint: vectorFingerprint(fund.profileText), vector: vectors.get(fund.id)! })),
    );
  }

  private async loadFundVectors(onProgress: (progress: number) => void): Promise<Map<string, Float32Array>> {
    const manifest = semanticManifest(this.index)!;
    const cacheRequest = new Request(`/assets/.computed-${manifest.vectorVersion}.bin`);
    let vectors = new Map<string, Float32Array>();
    this.throwIfCancelled();
    try {
      const cache = await caches.open('artizen-semantic-fund-vectors');
      const cached = await cache.match(cacheRequest);
      if (cached) vectors = parseVectorCatalog(await cached.arrayBuffer(), manifest, this.fundFingerprints());
    } catch {
      // Cache access is optional. The public vector catalog remains the next source.
    }
    this.throwIfCancelled();
    if (vectors.size < this.index.funds.length) {
      try {
        const response = await fetch(manifest.vectorsUrl, { cache: 'no-cache', signal: this.abortController.signal });
        if (response.ok) {
          const published = parseVectorCatalog(await response.arrayBuffer(), manifest, this.fundFingerprints());
          for (const [fundId, vector] of published) {
            if (!vectors.has(fundId)) vectors.set(fundId, vector);
          }
        }
      } catch {
        // Missing precomputed vectors are calculated locally below.
      }
      this.throwIfCancelled();
    }
    const missing = this.index.funds.filter((fund) => !vectors.has(fund.id));
    for (let start = 0; start < missing.length; start += 12) {
      this.throwIfCancelled();
      const batch = missing.slice(start, start + 12);
      const output = await this.extractor!(batch.map((fund) => fund.profileText), {
        pooling: 'mean',
        normalize: true,
      });
      this.throwIfCancelled();
      const fullDimensions = output.dims.at(-1) || manifest.dimensions;
      batch.forEach((fund, index) => {
        vectors.set(fund.id, truncateAndNormalize(output.data, index * fullDimensions, manifest.dimensions));
      });
      onProgress(0.75 + 0.25 * Math.min(1, (start + batch.length) / Math.max(1, missing.length)));
    }
    if (missing.length) {
      this.throwIfCancelled();
      try {
        const cache = await caches.open('artizen-semantic-fund-vectors');
        await cache.put(cacheRequest, new Response(this.serializeFunds(vectors)));
      } catch {
        // Storage failure must not prevent this in-memory scoring session.
      }
    }
    return vectors;
  }
}
