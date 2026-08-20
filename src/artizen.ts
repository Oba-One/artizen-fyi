import { ArtizenClient } from './artizen/client';
import { buildBoosts, buildLeaderboard } from './artizen/leaderboard';
import { buildFund } from './artizen/fund';
import { buildProject } from './artizen/project';
import type { BoostsPage, DetailPreview, FundPage, Leaderboard, ProjectPage } from './artizen/types';

export type {
  BoostBucket,
  BoostHolder,
  BoostsPage,
  DetailPreview,
  Drive,
  DriveStat,
  FundDriveNest,
  FundFundingSeason,
  FundMatchedProject,
  FundPage,
  FundRow,
  Leaderboard,
  MatchingFund,
  PodiumRow,
  ProjectDriveDetail,
  ProjectFundingSeason,
  ProjectPage,
  ProjectRow,
  ProjectSubmission,
  Row,
  Season,
} from './artizen/types';

const LEADERBOARD_CACHE = 'artizen/leaderboard/v29';
const PROJECT_CACHE = 'artizen/project/v29';
const FUND_CACHE = 'artizen/fund/v10';
const BOOSTS_CACHE = 'artizen/boosts/v2';

export class Artizen extends ArtizenClient {
  async leaderboard(seasonNumber?: string | number | null): Promise<Leaderboard> {
    const fallback: Leaderboard = { seasons: [], season: null, drives: [], projects: [], funds: [], error: true };
    return this.withArtizenErrors(fallback, () =>
      this.cached(`${LEADERBOARD_CACHE}/${seasonNumber ?? 'current'}`, fallback, () => buildLeaderboard(this, seasonNumber)),
    );
  }

  async project(slug: string): Promise<ProjectPage | null> {
    return this.withArtizenErrors(null, () => this.cacheFetch(`${PROJECT_CACHE}/${slug}`, () => buildProject(this, slug)));
  }

  async fund(slug: string): Promise<FundPage | null> {
    return this.withArtizenErrors(null, () => this.cacheFetch(`${FUND_CACHE}/${slug}`, () => buildFund(this, slug)));
  }

  async peekProject(slug: string): Promise<ProjectPage | null> {
    const cached = await this.cacheRead<ProjectPage>(`${PROJECT_CACHE}/${slug}`);
    return cached?.name ? cached : null;
  }

  async peekFund(slug: string): Promise<FundPage | null> {
    const cached = await this.cacheRead<FundPage>(`${FUND_CACHE}/${slug}`);
    return cached?.name ? cached : null;
  }

  async listedPreview(kind: 'project' | 'fund', slug: string): Promise<DetailPreview | undefined> {
    const path = kind === 'fund' ? `/funds/${slug}` : `/projects/${slug}`;
    const current = await this.cacheRead<Leaderboard>(`${LEADERBOARD_CACHE}/current`);
    const boards = await Promise.all(
      (current?.seasons || []).map((season) =>
        season.current ? current : this.cacheRead<Leaderboard>(`${LEADERBOARD_CACHE}/${season.number}`),
      ),
    );
    for (const board of [current, ...boards]) {
      if (kind === 'project') {
        const row = board?.projects?.find((item) => item.url === path);
        if (row?.name) return { name: row.name, lead: row.logline };
      } else {
        const row = board?.funds?.find((item) => item.url === path);
        if (row?.name) return { name: row.name, lead: row.subtitle };
      }
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
    return this.withArtizenErrors(fallback, () => this.cached(BOOSTS_CACHE, fallback, () => buildBoosts(this)));
  }

  async refreshCache(): Promise<string> {
    const started = Date.now();
    const seasons = await this.fetchSeasons();

    for (const season of seasons) {
      console.log(`[Artizen] leaderboard season ${season.number}`);
      const data = await this.rebuild(`${LEADERBOARD_CACHE}/${season.number}`, () => buildLeaderboard(this, season.number));
      if (data == null || data.error) continue;
      if (season.current) await this.cacheWrite(`${LEADERBOARD_CACHE}/current`, data);
    }

    console.log('[Artizen] boosts');
    const boosts = await this.rebuild(BOOSTS_CACHE, () => buildBoosts(this));

    let dropped = await this.deleteByPrefix(`${PROJECT_CACHE}/`);
    dropped += await this.deleteByPrefix(`${FUND_CACHE}/`);

    const summary = `[Artizen] refreshed ${seasons.length} seasons, boosts ${boosts && !boosts.error ? 'ok' : 'failed'}, dropped ${dropped} project/fund stashes in ${Math.round((Date.now() - started) / 1000)}s`;
    console.log(summary);
    return summary;
  }
}
