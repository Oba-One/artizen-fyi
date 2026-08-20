import { Bubble } from './bubble';
import { buildBoosts, buildLeaderboard } from './leaderboard';
import { buildFund } from './fund';
import { buildProject } from './project';
import type { BoostsPage, DetailPreview, FundPage, Leaderboard, ProjectPage } from './types';
import { failed } from './util';

const LEADERBOARD_CACHE = 'artizen/leaderboard/v29';
const PROJECT_CACHE = 'artizen/project/v29';
const FUND_CACHE = 'artizen/fund/v10';
const BOOSTS_CACHE = 'artizen/boosts/v2';

export class Artizen {
  private readonly bubble = new Bubble();

  constructor(
    private readonly kv: KVNamespace,
    private readonly fillOnMiss = false,
  ) {}

  async leaderboard(seasonNumber?: string | number | null): Promise<Leaderboard> {
    const fallback: Leaderboard = { seasons: [], season: null, drives: [], projects: [], funds: [], error: true };
    return this.withArtizenErrors(fallback, () =>
      this.fromCache(`${LEADERBOARD_CACHE}/${seasonNumber ?? 'current'}`, fallback, () =>
        buildLeaderboard(this.bubble, seasonNumber),
      ),
    );
  }

  async project(slug: string): Promise<ProjectPage | null> {
    return this.withArtizenErrors(null, () =>
      this.cacheGetOrBuild(`${PROJECT_CACHE}/${slug}`, () => buildProject(this.bubble, slug)),
    );
  }

  async fund(slug: string): Promise<FundPage | null> {
    return this.withArtizenErrors(null, () =>
      this.cacheGetOrBuild(`${FUND_CACHE}/${slug}`, () => buildFund(this.bubble, slug)),
    );
  }

  async peekProject(slug: string): Promise<ProjectPage | null> {
    const cached = await this.cacheGet<ProjectPage>(`${PROJECT_CACHE}/${slug}`);
    return cached?.name ? cached : null;
  }

  async peekFund(slug: string): Promise<FundPage | null> {
    const cached = await this.cacheGet<FundPage>(`${FUND_CACHE}/${slug}`);
    return cached?.name ? cached : null;
  }

  async listedPreview(kind: 'project' | 'fund', slug: string): Promise<DetailPreview | undefined> {
    const path = kind === 'fund' ? `/funds/${slug}` : `/projects/${slug}`;
    const current = await this.cacheGet<Leaderboard>(`${LEADERBOARD_CACHE}/current`);
    if (kind === 'project') {
      const row = current?.projects?.find((item) => item.url === path);
      if (row?.name) return { name: row.name, lead: row.logline };
    } else {
      const row = current?.funds?.find((item) => item.url === path);
      if (row?.name) return { name: row.name, lead: row.subtitle };
    }
  }

  async boosts(): Promise<BoostsPage> {
    const fallback: BoostsPage = {
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
    return this.withArtizenErrors(fallback, () => this.fromCache(BOOSTS_CACHE, fallback, () => buildBoosts(this.bubble)));
  }

  async refreshCache(): Promise<string> {
    const started = Date.now();
    const seasons = await this.bubble.fetchSeasons();

    for (const season of seasons) {
      console.log(`[Artizen] leaderboard season ${season.number}`);
      const data = await this.rebuild(`${LEADERBOARD_CACHE}/${season.number}`, () =>
        buildLeaderboard(this.bubble, season.number),
      );
      if (data == null || data.error) continue;
      if (season.current) await this.rebuild(`${LEADERBOARD_CACHE}/current`, async () => data);
    }

    console.log('[Artizen] boosts');
    const boosts = await this.rebuild(BOOSTS_CACHE, () => buildBoosts(this.bubble));

    let dropped = await this.deleteByPrefix(`${PROJECT_CACHE}/`);
    dropped += await this.deleteByPrefix(`${FUND_CACHE}/`);

    const summary = `[Artizen] refreshed ${seasons.length} seasons, boosts ${boosts && !boosts.error ? 'ok' : 'failed'}, dropped ${dropped} project/fund stashes in ${Math.round((Date.now() - started) / 1000)}s`;
    console.log(summary);
    return summary;
  }

  private async cacheGet<T>(key: string): Promise<T | null> {
    const cached = await this.kv.get(key);
    return cached != null ? (JSON.parse(cached) as T) : null;
  }

  private async cacheGetOrBuild<T>(key: string, build: () => Promise<T>, opts?: { refresh?: boolean }): Promise<T> {
    if (!opts?.refresh) {
      const cached = await this.cacheGet<T>(key);
      if (cached != null && !failed(cached)) return cached;
    }
    const value = await build();
    if (value && !failed(value)) await this.kv.put(key, JSON.stringify(value));
    return value;
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

  private async withArtizenErrors<T>(fallback: T, fn: () => Promise<T>, context?: string): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const prefix = context ? `${context} failed: ` : '';
      const err = e instanceof Error ? e : new Error(String(e));
      console.warn(`[Artizen] ${prefix}${err.constructor.name}: ${err.message}`);
      return fallback;
    }
  }

  private async fromCache<T>(key: string, fallback: T, build: () => Promise<T>): Promise<T> {
    if (this.fillOnMiss) return this.cacheGetOrBuild(key, build);
    const data = await this.cacheGet<T>(key);
    return data != null && !failed(data) ? data : fallback;
  }

  private async rebuild<T>(key: string, build: () => Promise<T>): Promise<T | null> {
    return this.withArtizenErrors(null, () => this.cacheGetOrBuild(key, build, { refresh: true }), key);
  }
}
