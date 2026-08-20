import { buildBoosts, buildLeaderboard } from './leaderboard';
import { buildFund } from './fund';
import { buildProject } from './project';
import type {
  BoostsPage,
  BubbleResponse,
  Constraint,
  DetailPreview,
  Drive,
  FundPage,
  Leaderboard,
  ProjectPage,
  Row,
  Season,
} from './types';
import {
  SITE_URL,
  batches,
  byId,
  failed,
  hidden,
  ids,
  int,
  mapSome,
  maybeNum,
  mediaUrl,
  sortByDesc,
  text,
} from './util';

const BASE_URL = 'https://artizen.fund/api/1.1/obj';
const PAGE_SIZE = 100;
const IN_BATCH = 50;
const BOOST_LIST_CONCURRENCY = 16;
const LEADERBOARD_CACHE = 'artizen/leaderboard/v29';
const PROJECT_CACHE = 'artizen/project/v29';
const FUND_CACHE = 'artizen/fund/v10';
const BOOSTS_CACHE = 'artizen/boosts/v2';

export class Artizen {
  private venusId: string | undefined;
  private seasonsMemo: Promise<Season[]> | undefined;

  constructor(
    readonly kv: KVNamespace,
    readonly fillOnMiss = false,
  ) {}

  async list(
    type: string,
    opts: { constraints?: Constraint[]; sortField?: string; descending?: boolean } = {},
  ): Promise<Row[]> {
    const params: Record<string, unknown> = { limit: PAGE_SIZE };
    if (opts.constraints) params.constraints = opts.constraints;
    if (opts.sortField) params.sort_field = opts.sortField;
    if (opts.descending) params.descending = true;

    const first = await this.get(type, { ...params, cursor: 0 });
    const results = first.results || [];
    const remaining = int(first.remaining);
    if (remaining <= 0) return results;

    const pageCount = Math.ceil(remaining / PAGE_SIZE);
    const cursors = Array.from({ length: pageCount }, (_, i) => (i + 1) * PAGE_SIZE);
    const extra = await Promise.all(cursors.map((cursor) => this.getResults(type, { ...params, cursor })));
    return results.concat(extra.flat());
  }

  async listEach(
    type: string,
    fn: (row: Row) => void,
    opts: { constraints?: Constraint[]; sortField?: string; descending?: boolean; concurrency?: number } = {},
  ): Promise<void> {
    const params: Record<string, unknown> = { limit: PAGE_SIZE };
    if (opts.constraints) params.constraints = opts.constraints;
    if (opts.sortField) params.sort_field = opts.sortField;
    if (opts.descending) params.descending = true;

    const first = await this.get(type, { ...params, cursor: 0 });
    for (const row of first.results || []) fn(row);
    const remaining = int(first.remaining);
    if (remaining <= 0) return;

    const cursors = Array.from({ length: Math.ceil(remaining / PAGE_SIZE) }, (_, i) => (i + 1) * PAGE_SIZE);
    const conc = opts.concurrency ?? BOOST_LIST_CONCURRENCY;
    for (const batch of batches(cursors, conc)) {
      const pages = await Promise.all(batch.map((cursor) => this.getResultsRetry(type, { ...params, cursor })));
      for (const page of pages) for (const row of page) fn(row);
    }
  }

  async getResults(type: string, params: Record<string, unknown>): Promise<Row[]> {
    return (await this.get(type, params)).results || [];
  }

  async findBy(type: string, key: string, value: unknown, limit = 1): Promise<Row[]> {
    return this.getResults(type, {
      limit,
      constraints: [{ key, constraint_type: 'equals', value }],
    });
  }

  async findOne(type: string, slug: string, slugField = 'Slug'): Promise<Row | undefined> {
    const rows = await this.findBy(type, slugField, slug, 5);
    const row = rows.find((r) => !hidden(r)) || rows[0];
    if (row) return row;

    return (await this.findBy(type, '_id', slug))[0];
  }

  async fetchByIds(type: string, idList: unknown[]): Promise<Row[]> {
    return this.inBatches(idList, (batch) =>
      this.getResults(type, {
        limit: PAGE_SIZE,
        constraints: [{ key: '_id', constraint_type: 'in', value: batch }],
      }),
    );
  }

  async listWhereIn(type: string, field: string, idList: unknown[], extra: Constraint[] = []): Promise<Row[]> {
    return this.inBatches(idList, (batch) =>
      this.list(type, { constraints: [{ key: field, constraint_type: 'in', value: batch }, ...extra] }),
    );
  }

  async indexed(type: string, idList: unknown[]): Promise<Record<string, Row>> {
    const rows = await this.fetchByIds(type, idList);
    return Object.fromEntries(rows.filter((row) => row['_id'] != null).map((row) => [String(row['_id']), row]));
  }

  async listFundAwards(fundIds: unknown[]): Promise<Row[]> {
    return this.listWhereIn('projectsubmission', 'Fund', fundIds, [
      { key: 'Status', constraint_type: 'equals', value: 'Curated' },
      { key: '$ amount raised', constraint_type: 'greater than', value: 0 },
    ]);
  }

  async fetchSeasons(): Promise<Season[]> {
    if (!this.seasonsMemo) {
      this.seasonsMemo = this.loadSeasons().catch((err) => {
        this.seasonsMemo = undefined;
        throw err;
      });
    }
    return this.seasonsMemo;
  }

  private async loadSeasons(): Promise<Season[]> {
    const seasons = sortByDesc(
      mapSome(await this.list('season'), (row) => {
        if (row['season number'] == null) return undefined;
        const number = int(row['season number']);

        const tag = row['Season tag'];
        return {
          id: String(row['_id'] ?? ''),
          number,
          title: text(row['title']) ?? `Season ${number}`,
          tag,
          current: text(tag) != null && tag !== 'Ended',
          total_raised: maybeNum(row['total raised usd']),
          competition_start: row['competition start date'],
          competition_end: row['competition end date'],
        } satisfies Season;
      }),
      (s) => s.number,
    );
    const currentId = (seasons.find((s) => s.current) || seasons[0])?.id;
    for (const s of seasons) s.current = s.id === currentId;
    return seasons;
  }

  pickSeason(seasons: Season[], seasonNumber?: string | number | null): Season | undefined {
    const found =
      seasonNumber != null && String(seasonNumber).trim() !== ''
        ? seasons.find((s) => s.number === int(seasonNumber))
        : undefined;
    return found || seasons.find((s) => s.current) || seasons[0];
  }

  async seasonsById(): Promise<Record<string, Season>> {
    const seasons = await this.fetchSeasons();
    return Object.fromEntries(seasons.map((s) => [s.id, s]));
  }

  async fetchNormalizedDrives(boostIds: unknown[], seasonsMeta: Record<string, Season>): Promise<Drive[]> {
    const drives = (await this.fetchByIds('boost', boostIds)).map((r) => this.normalizeDrive(r));
    this.applySeasonNames(drives, seasonsMeta);
    return drives;
  }

  normalizeDrive(row: Row): Drive {
    const slug = row['slugg'];
    return {
      id: String(row['_id'] ?? ''),
      name: text(row['Name']) ?? '',
      url: `${SITE_URL}/index/boost/${text(slug) ?? row['_id']}`,
      season_id: row['season'],
      season_number: row['season number'] == null ? undefined : int(row['season number']),
      image: mediaUrl(row['image']),
      description: text(row['Description']),
      status: row['status'],
      active: row['status'] == 'Active',
      number: row['fund drive number'] == null ? undefined : int(row['fund drive number']),
      start: row['start date'],
      end: row['end date'],
      multiple: maybeNum(row['boost multiple']),
      match_pot: maybeNum(row['total match pot funds']),
      prize_projects: maybeNum(row['prize pot projects']),
      prize_funds: maybeNum(row['prize pot funds']),
      match_per_project: maybeNum(row['Artizen match per project']),
      ...this.drivePlacePrizes(row),
    };
  }

  applySeasonNames(drives: Drive[], seasonsMeta: Record<string, Season>): void {
    for (const drive of drives) {
      const meta = byId(seasonsMeta, drive.season_id);
      if (drive.season_number == null) {
        drive.season_number = meta?.number;
      }
      drive.season = meta?.title ?? (drive.season_number != null ? `Season ${drive.season_number}` : undefined);
    }
  }

  async venusTransactions(opts: { seasonId?: string | null; projectId?: string | null } = {}): Promise<Row[]> {
    const id = await this.venusAccountId();
    if (!id) return [];

    const constraints: Constraint[] = [
      { key: 'Buyer (User account)', constraint_type: 'equals', value: id },
      { key: 'confirmed', constraint_type: 'equals', value: true },
    ];
    if (opts.seasonId) constraints.push({ key: 'Season', constraint_type: 'equals', value: opts.seasonId });
    if (opts.projectId) constraints.push({ key: 'project', constraint_type: 'equals', value: opts.projectId });
    return this.list('transaction', { constraints });
  }

  async cacheGet<T>(key: string): Promise<T | null> {
    const cached = await this.kv.get(key);
    return cached != null ? (JSON.parse(cached) as T) : null;
  }

  async cacheGetOrBuild<T>(key: string, build: () => Promise<T>, opts?: { refresh?: boolean }): Promise<T> {
    if (!opts?.refresh) {
      const cached = await this.cacheGet<T>(key);
      if (cached != null && !failed(cached)) return cached;
    }
    const value = await build();
    if (value && !failed(value)) await this.kv.put(key, JSON.stringify(value));
    return value;
  }

  async deleteByPrefix(prefix: string): Promise<number> {
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

  async withArtizenErrors<T>(fallback: T, fn: () => Promise<T>, context?: string): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const prefix = context ? `${context} failed: ` : '';
      const err = e instanceof Error ? e : new Error(String(e));
      console.warn(`[Artizen] ${prefix}${err.constructor.name}: ${err.message}`);
      return fallback;
    }
  }

  async leaderboard(seasonNumber?: string | number | null): Promise<Leaderboard> {
    const fallback: Leaderboard = { seasons: [], season: null, drives: [], projects: [], funds: [], error: true };
    return this.withArtizenErrors(fallback, () =>
      this.fromCache(`${LEADERBOARD_CACHE}/${seasonNumber ?? 'current'}`, fallback, () => buildLeaderboard(this, seasonNumber)),
    );
  }

  async project(slug: string): Promise<ProjectPage | null> {
    return this.withArtizenErrors(null, () => this.cacheGetOrBuild(`${PROJECT_CACHE}/${slug}`, () => buildProject(this, slug)));
  }

  async fund(slug: string): Promise<FundPage | null> {
    return this.withArtizenErrors(null, () => this.cacheGetOrBuild(`${FUND_CACHE}/${slug}`, () => buildFund(this, slug)));
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
    return this.withArtizenErrors(fallback, () => this.fromCache(BOOSTS_CACHE, fallback, () => buildBoosts(this)));
  }

  async refreshCache(): Promise<string> {
    const started = Date.now();
    const seasons = await this.fetchSeasons();

    for (const season of seasons) {
      console.log(`[Artizen] leaderboard season ${season.number}`);
      const data = await this.rebuild(`${LEADERBOARD_CACHE}/${season.number}`, () => buildLeaderboard(this, season.number));
      if (data == null || data.error) continue;
      if (season.current) await this.rebuild(`${LEADERBOARD_CACHE}/current`, async () => data);
    }

    console.log('[Artizen] boosts');
    const boosts = await this.rebuild(BOOSTS_CACHE, () => buildBoosts(this));

    let dropped = await this.deleteByPrefix(`${PROJECT_CACHE}/`);
    dropped += await this.deleteByPrefix(`${FUND_CACHE}/`);

    const summary = `[Artizen] refreshed ${seasons.length} seasons, boosts ${boosts && !boosts.error ? 'ok' : 'failed'}, dropped ${dropped} project/fund stashes in ${Math.round((Date.now() - started) / 1000)}s`;
    console.log(summary);
    return summary;
  }

  private async fromCache<T>(key: string, fallback: T, build: () => Promise<T>): Promise<T> {
    if (this.fillOnMiss) return this.cacheGetOrBuild(key, build);
    const data = await this.cacheGet<T>(key);
    return data != null && !failed(data) ? data : fallback;
  }

  private async rebuild<T>(key: string, build: () => Promise<T>): Promise<T | null> {
    return this.withArtizenErrors(null, () => this.cacheGetOrBuild(key, build, { refresh: true }), key);
  }

  private async get(type: string, params: Record<string, unknown>): Promise<BubbleResponse> {
    const url = new URL(`${BASE_URL}/${type}`);
    for (const [key, value] of Object.entries(params)) {
      if (value == null) continue;
      const encoded =
        key === 'constraints' && Array.isArray(value) ? JSON.stringify(value) : typeof value === 'string' ? value : String(value);
      url.searchParams.set(key, encoded);
    }
    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Artizen API ${response.status} for ${type}`);

    const body = (await response.json()) as { response?: BubbleResponse };
    const result = body.response;
    if (result == null) throw new Error(`missing response`);
    return result;
  }

  private async getResultsRetry(type: string, params: Record<string, unknown>, attempts = 4): Promise<Row[]> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.getResults(type, params);
      } catch (e) {
        last = e;
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** i));
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  private async inBatches(values: unknown[], fn: (batch: unknown[]) => Promise<Row[]>): Promise<Row[]> {
    const unique = ids(values);
    if (unique.length === 0) return [];
    return (await Promise.all(batches(unique, IN_BATCH).map(fn))).flat();
  }

  private drivePlacePrizes(row: Row): Pick<Drive, 'project_first' | 'project_second' | 'project_third' | 'fund_first' | 'fund_second' | 'fund_third'> {
    const out: Record<string, number | undefined> = {};
    for (const kind of ['project', 'fund'] as const) {
      for (const [ord, nth] of [['first', '1st'], ['second', '2nd'], ['third', '3rd']] as const) {
        out[`${kind}_${ord}`] = maybeNum(row[`${kind} ${nth} prize `]);
      }
    }
    return out;
  }

  private async venusAccountId(): Promise<string> {
    if (this.venusId !== undefined) return this.venusId;

    const rows = await this.findBy('useraccount', 'name', 'Venus');
    this.venusId = String(rows[0]?.['_id'] ?? '');
    return this.venusId;
  }
}
