import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bubble } from '../src/artizen/bubble';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function json(body: unknown): Response {
  return new Response(JSON.stringify({ response: body }), {
    headers: { 'content-type': 'application/json' },
  });
}

describe('venusTransactions', () => {
  it('includes the Artizen admin account and skips other Artizen users', async () => {
    const seenBuyers: unknown[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const type = url.pathname.split('/').pop();
      const constraints = JSON.parse(url.searchParams.get('constraints') || '[]') as Array<{
        key: string;
        value: unknown;
      }>;
      if (type === 'useraccount') {
        const name = constraints.find((c) => c.key === 'name')?.value;
        if (name === 'Venus') {
          return json({ results: [{ _id: 'venus-id', name: 'Venus', Role: 'Artizen admin' }], remaining: 0 });
        }
        return json({
          results: [
            { _id: 'artizen-user', name: 'Artizen', Role: 'Normal user' },
            { _id: 'artizen-fund', name: 'Artizen', Role: 'Match fund admin' },
            { _id: 'artizen-admin', name: 'Artizen', Role: 'Artizen admin' },
          ],
          remaining: 0,
        });
      }
      if (type === 'transaction') {
        const buyer = constraints.find((c) => c.key === 'Buyer (User account)');
        seenBuyers.push(buyer?.value);
        return json({
          results: [{ _id: 'tx-1', 'Buyer (User account)': 'artizen-admin', 'amount spent $USD': 100 }],
          remaining: 0,
        });
      }
      return json({ results: [], remaining: 0 });
    }) as typeof fetch;

    const rows = await new Bubble().venusTransactions({ seasonId: 's6' });
    expect(rows).toHaveLength(1);
    expect(seenBuyers).toEqual([['venus-id', 'artizen-admin']]);
  });
});
