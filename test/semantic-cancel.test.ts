import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchIndex } from '../src/artizen/types';
import { LocalSemanticScorer } from '../src/client/semantic-scorer';

const transformers = vi.hoisted(() => {
  const env = {
    fetch: globalThis.fetch,
    allowRemoteModels: true,
    allowLocalModels: false,
    localModelPath: '',
    useBrowserCache: false,
    useWasmCache: false,
    backends: { onnx: { wasm: {} } },
  };
  return {
    env,
    pipeline: vi.fn(async () => {
      await env.fetch('/assets/models/weights.onnx');
      return Object.assign(async () => ({ data: [], dims: [] }), { dispose: async () => undefined });
    }),
  };
});

vi.mock('@huggingface/transformers', () => transformers);

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  transformers.env.fetch = originalFetch;
  vi.clearAllMocks();
});

describe('local semantic cancellation', () => {
  it('stays cancelled while the transformers chunk is importing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const index = JSON.parse(readFileSync('test/fixtures/match-index.json', 'utf8')) as MatchIndex;
    const scorer = new LocalSemanticScorer(index);
    const loading = scorer.load(() => undefined);

    scorer.dispose();

    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(transformers.pipeline).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('aborts the active model request instead of only dropping references', async () => {
    globalThis.fetch = vi.fn((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }),
    ) as typeof fetch;
    const index = JSON.parse(readFileSync('test/fixtures/match-index.json', 'utf8')) as MatchIndex;
    const scorer = new LocalSemanticScorer(index);
    const loading = scorer.load(() => undefined);

    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    scorer.dispose();

    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
  });
});
