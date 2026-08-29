import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { BoostHolder, BoostRegistry, BoostRegistryHolder, BoostsSummary } from '../src/artizen/types';

const SNAPSHOT = '1788004800000';

function holder(index: number): BoostRegistryHolder {
  const points = 100_000 - index;
  return {
    id: `holder-${index}`,
    rank: index + 1,
    name: index === 149 ? 'Target Beyond One Hundred' : `Holder ${String(index).padStart(3, '0')}`,
    search_name: index === 149 ? 'target beyond one hundred' : `holder ${String(index).padStart(3, '0')}`,
    image: index % 2 ? undefined : `https://media.example/${index}.jpg`,
    points,
    share: points / 20_000_000,
    cumulative: (index + 1) / 205,
    admin: index === 2,
  };
}

function data(): { summary: BoostsSummary; registry: BoostRegistry } {
  const holders = Array.from({ length: 205 }, (_, index) => holder(index));
  const top = holders.slice(0, 100).map(({ id: _id, search_name: _search, ...row }) => row satisfies BoostHolder);
  return {
    summary: {
      remaining: 20_000_000,
      accounts: 210,
      holders: 205,
      zero: 5,
      mean: 97_560,
      median: 99_895,
      admin: 99_998,
      community: 19_900_002,
      top_points: top.reduce((total, row) => total + row.points, 0),
      top_share: top.reduce((total, row) => total + row.points, 0) / 20_000_000,
      updated_at: '2026-08-29T12:00:00.000Z',
      buckets: [{ label: '100k–999k', users: 205, points: 20_000_000 }],
      top,
      snapshot: SNAPSHOT,
      error: false,
    },
    registry: { snapshot: SNAPSHOT, updated_at: '2026-08-29T12:00:00.000Z', holders },
  };
}

function environment(options: { legacy?: boolean; omitRegistry?: boolean } = {}): { env: Env; reads: string[] } {
  const fixture = data();
  const reads: string[] = [];
  const legacy = options.legacy ? { ...fixture.summary, snapshot: undefined } : null;
  const values = new Map<string, string>([
    ...(legacy
      ? [['artizen/boosts/v2', JSON.stringify(legacy)] as const]
      : [['artizen/boosts/v3/summary', JSON.stringify(fixture.summary)] as const]),
    ...(!options.omitRegistry && !legacy
      ? [[`artizen/boosts/v3/registry/${SNAPSHOT}`, JSON.stringify(fixture.registry)] as const]
      : []),
  ]);
  const env = {
    CACHE: {
      async get(key: string, getOptions?: string | KVNamespaceGetOptions<unknown>) {
        reads.push(key);
        const value = values.get(key) ?? null;
        const type = typeof getOptions === 'string' ? getOptions : getOptions?.type;
        return value != null && type === 'json' ? JSON.parse(value) : value;
      },
      async put() {},
      async delete() {},
      async list() {
        return { keys: [], list_complete: true, cacheStatus: null };
      },
    } as unknown as KVNamespace,
  } as Env;
  return { env, reads };
}

describe('boost registry routes', () => {
  it('keeps the default page on the small summary and renders only the first 100 holders', async () => {
    const { env, reads } = environment();
    const response = await worker.fetch(new Request('https://artizen.fyi/boosts'), env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body.length).toBeLessThan(150_000);
    expect(body.match(/class="artizen-holder-rank"/g)).toHaveLength(100);
    expect(body).toContain('Showing 1–100 of 205 holders');
    expect(body).toContain('Show 100 more');
    expect(body).toContain('placeholder="Search holders"');
    expect(reads).toEqual(['artizen/boosts/v3/summary']);
  });

  it('searches below the top 100 and marks searched and later pages noindex', async () => {
    const { env } = environment();
    const searched = await worker.fetch(new Request('https://artizen.fyi/boosts?q=target'), env);
    const searchedBody = await searched.text();
    expect(searchedBody).toContain('Target Beyond One Hundred');
    expect(searchedBody).toContain('Showing 1–1 of 1 matching holders');
    expect(searchedBody).toContain('<meta name="robots" content="noindex,follow">');

    const second = await worker.fetch(new Request('https://artizen.fyi/boosts?page=2'), env);
    const secondBody = await second.text();
    expect(secondBody.match(/class="artizen-holder-rank"/g)).toHaveLength(100);
    expect(secondBody).toContain('Showing 101–200 of 205 holders');
    expect(secondBody).toContain('<meta name="robots" content="noindex,follow">');
  });

  it('serves bounded public JSON without internal registry fields', async () => {
    const { env } = environment();
    const response = await worker.fetch(
      new Request(`https://artizen.fyi/boosts/holders.json?snapshot=${SNAPSHOT}&offset=100&limit=500`),
      env,
    );
    const body = (await response.json()) as { holders: Array<Record<string, unknown>>; limit: number; hasMore: boolean };
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('max-age=300');
    expect(body.holders).toHaveLength(100);
    expect(body.limit).toBe(100);
    expect(body.hasMore).toBe(true);
    expect(body.holders[0]).not.toHaveProperty('id');
    expect(body.holders[0]).not.toHaveProperty('search_name');
  });

  it('validates snapshots and reports an expired retained snapshot explicitly', async () => {
    const available = environment();
    expect(
      (await worker.fetch(new Request('https://artizen.fyi/boosts/holders.json?snapshot=../../summary'), available.env)).status,
    ).toBe(400);

    const expired = environment({ omitRegistry: true });
    const response = await worker.fetch(
      new Request(`https://artizen.fyi/boosts/holders.json?snapshot=${SNAPSHOT}`),
      expired.env,
    );
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: 'boost_snapshot_expired' });
  });

  it('serves the legacy top 100 without exposing expansion controls before v3 is ready', async () => {
    const { env } = environment({ legacy: true });
    const response = await worker.fetch(new Request('https://artizen.fyi/boosts'), env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body.match(/class="artizen-holder-rank"/g)).toHaveLength(100);
    expect(body).not.toContain('id="artizen-boost-search"');
    expect(body).toContain('id="artizen-boost-more" class="btn btn-outline-dark" href="/boosts" hidden');
  });
});
