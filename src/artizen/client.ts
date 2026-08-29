import { Bubble } from './bubble';
import { buildBoosts, buildLeaderboard, queryBoostRegistry } from './leaderboard';
import { buildFund } from './fund';
import { buildProject } from './project';
import { buildMatchIndex, MATCH_INDEX_KEY } from '../matching/index';
import type {
  BoostHolderPage,
  BoostHolderQuery,
  BoostRegistry,
  BoostsSummary,
  DetailPreview,
  FundPage,
  Leaderboard,
  MatchIndex,
  ProjectPage,
} from './types';
import { failed } from './util';

const keys = {
  leaderboard: (season: string | number) => `artizen/leaderboard/v36/${season}`,
  project: (slug: string) => `artizen/project/v46/${slug}`,
  fund: (slug: string) => `artizen/fund/v10/${slug}`,
  boostsV2: 'artizen/boosts/v2',
  boostsSummary: 'artizen/boosts/v3/summary',
  boostRegistry: (snapshot: string) => `artizen/boosts/v3/registry/${snapshot}`,
  projects: 'artizen/project/v46/',
  funds: 'artizen/fund/v10/',
  matching: MATCH_INDEX_KEY,
};

export const BOOST_REGISTRY_MAX_BYTES = 24 * 1024 * 1024;
export const BOOST_REGISTRY_TTL_SECONDS = 24 * 60 * 60;

const boostRegistryMemo = new WeakMap<KVNamespace, { key: string; value: Promise<BoostRegistry | null> }>();

function emptyBoosts(): BoostsSummary {
  return {
    remaining: 0,
    accounts: 0,
    holders: 0,
    zero: 0,
    mean: 0,
    median: 0,
    admin: 0,
    community: 0,
    top_points: 0,
    top_share: 0,
    updated_at: '',
    buckets: [],
    top: [],
    error: true,
  };
}

export function validateBoostPublish(
  previous: BoostsSummary | null,
  next: BoostsSummary,
  registryBytes: number,
): void {
  if (previous && !previous.error && previous.accounts > 0 && next.accounts < previous.accounts * 0.8) {
    throw new Error(`boost account count dropped from ${previous.accounts} to ${next.accounts}`);
  }
  if (registryBytes > BOOST_REGISTRY_MAX_BYTES) {
    throw new Error(`boost registry is ${registryBytes} bytes; maximum is ${BOOST_REGISTRY_MAX_BYTES}`);
  }
}

export class Artizen {
  constructor(
    private readonly kv: KVNamespace,
    private readonly fillOnMiss = false,
    private readonly bubble = new Bubble(),
  ) {}

  async leaderboard(seasonNumber?: string | number | null): Promise<Leaderboard> {
    const fallback: Leaderboard = { seasons: [], season: null, drives: [], projects: [], funds: [], error: true };
    return this.cached(keys.leaderboard(seasonNumber ?? 'current'), () => buildLeaderboard(this.bubble, seasonNumber), 'require', fallback);
  }

  async peek(kind: 'project' | 'fund', slug: string): Promise<ProjectPage | FundPage | null> {
    const hit = await this.get<ProjectPage | FundPage>(keys[kind](slug));
    return hit?.name ? hit : null;
  }

  async load(kind: 'project' | 'fund', slug: string, refresh = false): Promise<ProjectPage | FundPage | null> {
    const mode = refresh ? 'refresh' : 'miss';
    return kind === 'fund'
      ? this.cached(keys.fund(slug), () => buildFund(this.bubble, slug), mode, null)
      : this.cached(keys.project(slug), () => buildProject(this.bubble, slug), mode, null);
  }

  async listedPreview(kind: 'project' | 'fund', slug: string): Promise<DetailPreview | undefined> {
    const path = `/${kind === 'fund' ? 'funds' : 'projects'}/${slug}`;
    const current = await this.get<Leaderboard>(keys.leaderboard('current'));
    if (kind === 'fund') {
      const row = current?.funds?.find((item) => item.url === path);
      if (row?.name) return { name: row.name, lead: row.subtitle, created_at: row.created_at };
    } else {
      const row = current?.projects?.find((item) => item.url === path);
      if (row?.name) return { name: row.name, lead: row.logline };
    }
  }

  async boosts(): Promise<BoostsSummary> {
    const current = await this.get<BoostsSummary>(keys.boostsSummary);
    if (current != null && !failed(current)) return current;
    const legacy = await this.get<BoostsSummary>(keys.boostsV2);
    if (!this.fillOnMiss) return legacy != null && !failed(legacy) ? legacy : emptyBoosts();
    return (await this.refreshBoosts(legacy)).summary;
  }

  async boostHolders(query: BoostHolderQuery = {}): Promise<BoostHolderPage | null> {
    const snapshot = query.snapshot ?? (await this.boosts()).snapshot;
    if (!snapshot || !/^\d{13}$/.test(snapshot)) return null;
    const registry = await this.getBoostRegistry(snapshot);
    return registry ? queryBoostRegistry(registry, { ...query, snapshot }) : null;
  }

  async refreshBoosts(previous?: BoostsSummary | null): Promise<{ summary: BoostsSummary; published: boolean }> {
    const prior = previous === undefined ? await this.readBoostsSummary() : previous;
    try {
      const built = await buildBoosts(this.bubble);
      const registryJson = JSON.stringify(built.registry);
      const registryBytes = new TextEncoder().encode(registryJson).byteLength;
      validateBoostPublish(prior, built.summary, registryBytes);
      const registryKey = keys.boostRegistry(built.registry.snapshot);
      await this.kv.put(registryKey, registryJson, { expirationTtl: BOOST_REGISTRY_TTL_SECONDS });
      await this.kv.put(keys.boostsSummary, JSON.stringify(built.summary));
      boostRegistryMemo.set(this.kv, { key: registryKey, value: Promise.resolve(built.registry) });
      console.log(
        `[Artizen] boost registry ${built.registry.snapshot}: ${built.summary.accounts} accounts, ${built.summary.holders} holders, ${registryBytes} bytes`,
      );
      return { summary: built.summary, published: true };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.warn(`[Artizen] ${keys.boostsSummary} failed: ${err.constructor.name}: ${err.message}`);
      return { summary: prior && !failed(prior) ? prior : emptyBoosts(), published: false };
    }
  }

  async matchIndex(): Promise<MatchIndex | null> {
    return this.cached(
      keys.matching,
      async () => buildMatchIndex(this.bubble, { previous: await this.get<MatchIndex>(keys.matching) }),
      'require',
      null,
    );
  }

  async refreshCache(): Promise<string> {
    const started = Date.now();
    const seasons = await this.bubble.fetchSeasons();

    for (const season of seasons) {
      console.log(`[Artizen] leaderboard season ${season.number}`);
      const data = await this.cached(keys.leaderboard(season.number), () => buildLeaderboard(this.bubble, season.number), 'refresh', null);
      if (data == null || data.error) continue;
      if (season.current) await this.cached(keys.leaderboard('current'), async () => data, 'refresh', null);
    }

    console.log('[Artizen] boosts');
    const boosts = await this.refreshBoosts();

    let dropped = await this.deleteByPrefix(keys.projects);
    dropped += await this.deleteByPrefix(keys.funds);

    const summary = `[Artizen] refreshed ${seasons.length} seasons, boosts ${boosts.published ? 'ok' : 'failed'}, dropped ${dropped} project/fund stashes in ${Math.round((Date.now() - started) / 1000)}s`;
    console.log(summary);
    return summary;
  }

  private async get<T>(key: string): Promise<T | null> {
    const cached = await this.kv.get(key);
    return cached != null ? (JSON.parse(cached) as T) : null;
  }

  private async readBoostsSummary(): Promise<BoostsSummary | null> {
    const current = await this.get<BoostsSummary>(keys.boostsSummary);
    if (current != null && !failed(current)) return current;
    const legacy = await this.get<BoostsSummary>(keys.boostsV2);
    return legacy != null && !failed(legacy) ? legacy : null;
  }

  private async getBoostRegistry(snapshot: string): Promise<BoostRegistry | null> {
    const key = keys.boostRegistry(snapshot);
    const memo = boostRegistryMemo.get(this.kv);
    if (memo?.key === key) return memo.value;
    const value = this.kv
      .get<BoostRegistry>(key, { type: 'json', cacheTtl: 60 })
      .then((registry) => {
        if (registry == null) boostRegistryMemo.delete(this.kv);
        return registry;
      })
      .catch((error) => {
        boostRegistryMemo.delete(this.kv);
        throw error;
      });
    boostRegistryMemo.set(this.kv, { key, value });
    return value;
  }

  private async cached<T>(
    key: string,
    build: () => Promise<T>,
    mode: 'miss' | 'require' | 'refresh',
    fallback: T,
  ): Promise<T> {
    try {
      const read = mode === 'require' && this.fillOnMiss ? 'miss' : mode;
      if (read !== 'refresh') {
        const hit = await this.get<T>(key);
        if (hit != null && !failed(hit)) return hit;
        if (read === 'require') return fallback;
      }
      const value = await build();
      if (value && !failed(value)) await this.kv.put(key, JSON.stringify(value));
      return value;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.warn(`[Artizen] ${key} failed: ${err.constructor.name}: ${err.message}`);
      return fallback;
    }
  }

  private async deleteByPrefix(prefix: string): Promise<number> {
    let cursor: string | undefined;
    let dropped = 0;
    for (;;) {
      const page = await this.kv.list({ prefix, cursor });
      await Promise.all(page.keys.map((key) => this.kv.delete(key.name)));
      dropped += page.keys.length;
      if (page.list_complete) break;
      cursor = page.cursor;
    }
    return dropped;
  }
}
