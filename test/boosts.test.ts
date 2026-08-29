import { describe, expect, it } from 'vitest';
import type { Bubble } from '../src/artizen/bubble';
import { Artizen, BOOST_REGISTRY_MAX_BYTES, BOOST_REGISTRY_TTL_SECONDS, validateBoostPublish } from '../src/artizen/client';
import { buildBoosts, queryBoostRegistry } from '../src/artizen/leaderboard';
import type { BoostsSummary, Row } from '../src/artizen/types';

class FakeBubble {
  constructor(private readonly rows: Row[]) {}

  async listEach(type: string, visit: (row: Row) => void): Promise<void> {
    expect(type).toBe('useraccount');
    this.rows.forEach(visit);
  }
}

class MemoryKV {
  readonly values = new Map<string, string>();
  readonly puts: Array<{ key: string; options?: KVNamespacePutOptions }> = [];

  async get<T = string>(key: string, options?: string | KVNamespaceGetOptions<unknown>): Promise<T | string | null> {
    const value = this.values.get(key) ?? null;
    const type = typeof options === 'string' ? options : options?.type;
    return value != null && type === 'json' ? (JSON.parse(value) as T) : value;
  }

  async put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void> {
    this.puts.push({ key, options });
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(): Promise<KVNamespaceListResult<unknown>> {
    return { keys: [], list_complete: true, cacheStatus: null };
  }
}

function rows(): Row[] {
  const holders = Array.from({ length: 205 }, (_, index) => ({
    _id: `holder-${String(index).padStart(3, '0')}`,
    name: `Holder ${String(index).padStart(3, '0')}`,
    'points - current': 10_000 - index,
    'profile image': index % 2 === 0 ? `//media.example/${index}.jpg` : undefined,
    Role: index === 3 ? 'Admin' : 'Member',
    wallet: `0x${String(index).padStart(40, '0')}`,
  }));
  holders[20].name = 'René Pinnell';
  holders[40].name = 'person@example.com';
  holders[60].name = '';
  holders[60].wallet = '0x1234567890abcdef';
  holders[80].name = 'Zulu Tie';
  holders[80]['points - current'] = 9_500;
  holders[81].name = 'Alpha Tie';
  holders[81]['points - current'] = 9_500;
  const empty = Array.from({ length: 5 }, (_, index) => ({
    _id: `empty-${index}`,
    name: `Empty ${index}`,
    'points - current': 0,
  }));
  return [...holders, ...empty];
}

async function fixture() {
  return buildBoosts(new FakeBubble(rows()) as unknown as Bubble, new Date('2026-08-29T12:00:00.000Z'));
}

describe('boost holder registry', () => {
  it('builds a deterministic positive-holder registry and a small top-100 summary', async () => {
    const built = await fixture();
    expect(built.summary).toMatchObject({ accounts: 210, holders: 205, zero: 5, snapshot: '1788004800000' });
    expect(built.summary.top).toHaveLength(100);
    expect(built.registry.holders).toHaveLength(205);
    expect(built.registry.holders.some((holder) => holder.points === 0)).toBe(false);
    expect(built.registry.holders.find((holder) => holder.name === 'person@example.com')).toBeTruthy();
    expect(built.registry.holders.find((holder) => holder.id === 'holder-060')?.name).toBe('0x1234…cdef');

    const alpha = built.registry.holders.find((holder) => holder.name === 'Alpha Tie')!;
    const zulu = built.registry.holders.find((holder) => holder.name === 'Zulu Tie')!;
    expect(alpha.rank).toBeLessThan(zulu.rank);
    expect(built.registry.holders.map((holder) => holder.cumulative)).toEqual(
      [...built.registry.holders.map((holder) => holder.cumulative)].sort((a, b) => a - b),
    );
  });

  it('searches names across the registry with folded accents and unordered terms', async () => {
    const built = await fixture();
    const result = queryBoostRegistry(built.registry, { q: 'pinnell rene' });
    expect(result.holders.map((holder) => holder.name)).toEqual(['René Pinnell']);
    expect(result.holders[0]).not.toHaveProperty('id');
    expect(result.holders[0]).not.toHaveProperty('search_name');
  });

  it('returns bounded, non-overlapping batches and sorts the whole result set', async () => {
    const built = await fixture();
    const first = queryBoostRegistry(built.registry, { offset: 0, limit: 100 });
    const second = queryBoostRegistry(built.registry, { offset: 100, limit: 500 });
    const third = queryBoostRegistry(built.registry, { offset: 200, limit: 100 });
    expect(first.holders).toHaveLength(100);
    expect(second.holders).toHaveLength(100);
    expect(third.holders).toHaveLength(5);
    expect(second.limit).toBe(100);
    expect(first.holders.at(-1)?.rank).toBeLessThan(second.holders[0].rank);
    expect(new Set([...first.holders, ...second.holders].map((holder) => holder.rank))).toHaveLength(200);

    const names = queryBoostRegistry(built.registry, { sort: 'name', dir: 'asc', limit: 100 });
    expect(names.holders.map((holder) => holder.name)).toEqual(
      [...names.holders.map((holder) => holder.name)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('publishes the immutable registry before its summary and can query the published snapshot', async () => {
    const kv = new MemoryKV();
    const artizen = new Artizen(kv as unknown as KVNamespace, true, new FakeBubble(rows()) as unknown as Bubble);
    const summary = await artizen.boosts();
    expect(summary.snapshot).toMatch(/^\d{13}$/);
    expect(kv.puts.map((put) => put.key)).toEqual([
      `artizen/boosts/v3/registry/${summary.snapshot}`,
      'artizen/boosts/v3/summary',
    ]);
    expect(kv.puts[0].options?.expirationTtl).toBe(BOOST_REGISTRY_TTL_SECONDS);
    const page = await artizen.boostHolders({ snapshot: summary.snapshot, offset: 100, limit: 100 });
    expect(page?.holders).toHaveLength(100);
  });

  it('keeps the v2 top-100 fallback read-only until a v3 snapshot is published', async () => {
    const built = await fixture();
    const legacy: BoostsSummary = { ...built.summary, snapshot: undefined };
    const kv = new MemoryKV();
    kv.values.set('artizen/boosts/v2', JSON.stringify(legacy));
    const artizen = new Artizen(kv as unknown as KVNamespace);
    expect((await artizen.boosts()).top).toHaveLength(100);
    expect(await artizen.boostHolders()).toBeNull();
    expect(kv.puts).toEqual([]);
  });

  it('rejects truncated crawls and oversized registries before publication', async () => {
    const built = await fixture();
    const previous = { ...built.summary, accounts: 1_000 };
    expect(() => validateBoostPublish(previous, { ...built.summary, accounts: 799 }, 1_000)).toThrow(
      'boost account count dropped',
    );
    expect(() => validateBoostPublish(previous, { ...built.summary, accounts: 800 }, BOOST_REGISTRY_MAX_BYTES)).not.toThrow();
    expect(() => validateBoostPublish(previous, { ...built.summary, accounts: 800 }, BOOST_REGISTRY_MAX_BYTES + 1)).toThrow(
      'boost registry is',
    );
  });
});
