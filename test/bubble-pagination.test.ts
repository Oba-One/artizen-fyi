import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bubble } from '../src/artizen/bubble';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('Bubble pagination', () => {
  it('keeps rows and warns when the live table changes during pagination', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const cursor = Number(url.searchParams.get('cursor'));
      const response =
        cursor === 0
          ? { results: [{ _id: 'first' }], remaining: 101 }
          : cursor === 100
            ? { results: [{ _id: 'second' }] }
            : { results: [] };
      return new Response(JSON.stringify({ response }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await expect(new Bubble().list('changing-table')).resolves.toEqual([{ _id: 'first' }, { _id: 'second' }]);
    expect(warn).toHaveBeenCalledWith(
      '[Artizen] changing-table pagination shifted: expected 101 more records, received 1',
    );
  });
});
