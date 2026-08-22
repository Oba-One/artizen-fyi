import { Bubble } from './bubble';
import { buildBoosts, buildLeaderboard } from './leaderboard';
import { buildFund } from './fund';
import { buildProject } from './project';
import type { BoostsPage, DetailPreview, FundPage, Leaderboard, ProjectPage } from './types';
import { failed } from './util';

const keys = {
  leaderboard: (season: string | number) => `artizen/leaderboard/v32/${season}`,
  project: (slug: string) => `artizen/project/v42/${slug}`,
  fund: (slug: string) => `artizen/fund/v10/${slug}`,
  boosts: 'artizen/boosts/v2',
  projects: 'artizen/project/v42/',
  funds: 'artizen/fund/v10/',
};

export class Artizen {
  private readonly bubble = new Bubble();

  constructor(
    private readonly kv: KVNamespace,
    private readonly fillOnMiss = false,
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
    return this.cached(keys.boosts, () => buildBoosts(this.bubble), 'require', fallback);
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
    const boosts = await this.cached(keys.boosts, () => buildBoosts(this.bubble), 'refresh', null);

    let dropped = await this.deleteByPrefix(keys.projects);
    dropped += await this.deleteByPrefix(keys.funds);

    const summary = `[Artizen] refreshed ${seasons.length} seasons, boosts ${boosts && !boosts.error ? 'ok' : 'failed'}, dropped ${dropped} project/fund stashes in ${Math.round((Date.now() - started) / 1000)}s`;
    console.log(summary);
    return summary;
  }

  private async get<T>(key: string): Promise<T | null> {
    const cached = await this.kv.get(key);
    return cached != null ? (JSON.parse(cached) as T) : null;
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
