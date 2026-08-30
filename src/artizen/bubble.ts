import type { BubbleResponse, Constraint, Drive, Row, Season } from './types';
import {
  SITE_URL,
  batches,
  bonusWeightSum,
  byId,
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

type ListOpts = {
  constraints?: Constraint[];
  sortField?: string;
  descending?: boolean;
  concurrency?: number;
};

export class Bubble {
  private venusIds: string[] | undefined;
  private seasonsMemo: Promise<Season[]> | undefined;

  async list(type: string, opts: ListOpts = {}): Promise<Row[]> {
    const results: Row[] = [];
    await this.listEach(type, (row) => results.push(row), opts);
    return results;
  }

  async listEach(type: string, fn: (row: Row) => void, opts: ListOpts = {}): Promise<void> {
    const params: Record<string, unknown> = { limit: PAGE_SIZE };
    if (opts.constraints) params.constraints = opts.constraints;
    if (opts.sortField) params.sort_field = opts.sortField;
    if (opts.descending) params.descending = true;

    const first = await this.get(type, { ...params, cursor: 0 });
    const firstResults = first.results || [];
    for (const row of firstResults) fn(row);
    const remaining = int(first.remaining);
    if (remaining <= 0) return;

    const cursors = Array.from({ length: Math.ceil(remaining / PAGE_SIZE) }, (_, i) => (i + 1) * PAGE_SIZE);
    const conc = opts.concurrency ?? BOOST_LIST_CONCURRENCY;
    let received = 0;
    for (const batch of batches(cursors, conc)) {
      const pages = await Promise.all(batch.map((cursor) => this.getResultsRetry(type, { ...params, cursor })));
      for (const page of pages) {
        received += page.length;
        for (const row of page) fn(row);
      }
    }
    // Bubble's `remaining` value is a snapshot from page zero. Rows can be inserted or deleted
    // while the concurrent pages are in flight, so a mismatch is useful telemetry but not proof
    // that the crawl failed. The matching index has its own previous-catalog drop guard for the
    // cases where a short crawl would be unsafe to publish.
    if (received !== remaining) {
      console.warn(`[Artizen] ${type} pagination shifted: expected ${remaining} more records, received ${received}`);
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
      bonus_projects: maybeNum(row['Project bonus pot']),
      bonus_funds: maybeNum(row['Fund bonus pot']),
      goal: maybeNum(row['goal']),
      match_per_project: maybeNum(row['Artizen match per project']),
      ...this.drivePlacePrizes(row),
    };
  }

  async driveBonusParticipants(boostId: string, kind: 'project' | 'fund'): Promise<Row[]> {
    const rows = await this.list('boostparticipant', {
      constraints: [
        { key: 'boost', constraint_type: 'equals', value: boostId },
        { key: kind, constraint_type: 'is_not_empty' },
        { key: 'boost points received', constraint_type: 'greater than', value: 0 },
      ],
    });
    return kind === 'fund' ? rows.filter((row) => !row['project']) : rows;
  }

  async driveBonusWeightSum(boostId: string, kind: 'project' | 'fund'): Promise<number> {
    return bonusWeightSum(await this.driveBonusParticipants(boostId, kind));
  }

  async venusTransactions(opts: { seasonId?: string | null; projectId?: string | null } = {}): Promise<Row[]> {
    const buyers = await this.venusAccountIds();
    if (buyers.length === 0) return [];

    const extra: Constraint[] = [{ key: 'confirmed', constraint_type: 'equals', value: true }];
    if (opts.seasonId) extra.push({ key: 'Season', constraint_type: 'equals', value: opts.seasonId });
    if (opts.projectId) extra.push({ key: 'project', constraint_type: 'equals', value: opts.projectId });
    return this.listWhereIn('transaction', 'Buyer (User account)', buyers, extra);
  }

  private applySeasonNames(drives: Drive[], seasonsMeta: Record<string, Season>): void {
    for (const drive of drives) {
      const meta = byId(seasonsMeta, drive.season_id);
      if (drive.season_number == null) {
        drive.season_number = meta?.number;
      }
      drive.season = meta?.title ?? (drive.season_number != null ? `Season ${drive.season_number}` : undefined);
    }
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

  // Venus is the S7 house buyer. S6 house artifact buys were booked on the
  // Artizen admin account before that user existed. Other "Artizen" accounts
  // are people / fund admins, not house.
  private async venusAccountIds(): Promise<string[]> {
    if (this.venusIds !== undefined) return this.venusIds;

    const [venus, artizen] = await Promise.all([
      this.findBy('useraccount', 'name', 'Venus', 5),
      this.findBy('useraccount', 'name', 'Artizen', 5),
    ]);
    this.venusIds = ids([
      ...venus.map((row) => row['_id']),
      ...artizen.filter((row) => text(row['Role']) === 'Artizen admin').map((row) => row['_id']),
    ]);
    return this.venusIds;
  }
}
