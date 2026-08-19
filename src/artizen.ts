const BASE_URL = 'https://artizen.fund/api/1.1/obj';
const SITE_URL = 'https://artizen.fund';
const PAGE_SIZE = 100;
const IN_BATCH = 50;
const PARALLEL = 6;
const LEADERBOARD_CACHE = 'artizen/leaderboard/v25';
const PROJECT_CACHE = 'artizen/project/v19';
const FUND_CACHE = 'artizen/fund/v10';
const VENUS_ACCOUNT_ID = '1774215063859x668765896046542800';
const LEAD_CREATOR = 'Lead Creator\t(text)';

export type Row = Record<string, unknown>;

type Constraint = { key: string; constraint_type: string; value: unknown };

type BubbleResponse = {
  results?: Row[];
  remaining?: number;
};

type DriveStat = {
  sales: number;
  venus: number;
  match: number;
  prize?: number;
  raised: number;
  available?: number;
};

export type Season = {
  id: string;
  number: number;
  title: string;
  tag: unknown;
  current: boolean;
  total_raised?: number;
  competition_start: unknown;
  competition_end: unknown;
};

export type PodiumRow = {
  name: string;
  url: string;
  sales_match: number;
  points: number;
  score: number;
};

export type Drive = {
  id: string;
  name: string;
  slug: unknown;
  url: string;
  season_id: unknown;
  season_number?: number | null;
  season?: string | null;
  image?: string | null;
  description?: string | null;
  status: unknown;
  active: boolean;
  number?: number | null;
  start: unknown;
  end: unknown;
  multiple?: number | null;
  match_pot?: number | null;
  prize_projects?: number | null;
  prize_funds?: number | null;
  goal?: number | null;
  match_per_project?: number | null;
  project_first?: number | null;
  project_second?: number | null;
  project_third?: number | null;
  fund_first?: number | null;
  fund_second?: number | null;
  fund_third?: number | null;
  podium?: PodiumRow[];
  fund_podium?: PodiumRow[];
};

export type ProjectRow = {
  name: string;
  url: string;
  creator?: string;
  logline?: string;
  sales: number;
  venus: number;
  match: number;
  prize: number;
  raised: number;
};

export type FundRow = {
  name: string;
  subtitle?: string;
  url: string;
  season_total: number;
  last_contribution: unknown;
  active: unknown;
  unlocked?: number;
  available?: number;
  raised?: number;
};

export type Leaderboard = {
  seasons: Season[];
  season: Season | null;
  drives: Drive[];
  projects: ProjectRow[];
  funds: FundRow[];
  error: boolean;
};

export type MatchingFund = {
  name: string;
  url: string;
  drive?: string | null;
  drive_active?: boolean | null;
  drive_number?: number | null;
  drive_multiple?: number | null;
  season?: string | null;
  season_number?: number | null;
  available: number;
  unlocked: number;
  cap: number;
};

export type ProjectDriveDetail = DriveStat & {
  name: string;
  status: unknown;
  active?: boolean | null;
  number?: number | null;
  url?: string | null;
  multiple?: number | null;
  season?: string | null;
  season_id: unknown;
  season_number?: number | null;
  funds?: MatchingFund[];
};

export type ProjectFundingSeason = {
  number?: number | null;
  title: string;
  sales: number;
  venus: number;
  match: number;
  prize: number;
  raised: number;
  available?: number;
  drives?: ProjectDriveDetail[];
};

export type ProjectSubmission = {
  name: string;
  url: string;
  status?: string;
  season?: string | null;
  season_number?: number | null;
  created_at: unknown;
};

export type ProjectPage = {
  name: string;
  artizen_url: string;
  creator?: string;
  logline?: string;
  description?: string;
  impact?: string;
  progress?: string;
  team?: string;
  image?: string | null;
  video?: string;
  tags: string[];
  seasons: ProjectFundingSeason[];
  submissions: ProjectSubmission[];
};

export type FundMatchedProject = {
  name: string;
  url: string;
  creator?: string | null;
  hidden?: unknown;
  drive?: string | null;
  drive_url?: string | null;
  drive_active?: boolean | null;
  drive_number?: number | null;
  drive_multiple?: number | null;
  season?: string | null;
  season_number?: number | null;
  available: number;
  unlocked: number;
};

export type FundDriveNest = {
  name: string;
  url?: string | null;
  active?: boolean | null;
  adjustment?: boolean;
  number?: number | null;
  multiple?: number | null;
  unlocked: number;
  available: number;
  projects: FundMatchedProject[];
};

export type FundFundingSeason = {
  number?: number | null;
  title: string;
  total: number;
  count: number;
  unlocked?: number;
  available?: number;
  drives?: FundDriveNest[];
};

export type FundPage = {
  name: string;
  artizen_url: string;
  image?: string | null;
  subtitle?: string;
  for_title?: string;
  description?: string;
  eligibility?: string;
  sponsor?: string;
  video?: string;
  available: number;
  unlocked: number;
  prize_art?: number;
  prize_usd?: number;
  active: unknown;
  contrib_total: number;
  seasons: FundFundingSeason[];
};

function num(value: unknown): number {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const n = parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

function optNum(value: unknown): number | undefined {
  if (value == null) return undefined;
  return num(value);
}

function str(value: unknown): string {
  return value == null ? '' : String(value);
}

function blank(value: unknown): boolean {
  if (value == null || value === false) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function presence(value: unknown): string | undefined {
  if (blank(value)) return undefined;
  return String(value);
}

function uniq<T>(items: T[]): T[] {
  const seen = new Set<unknown>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function sum<T>(items: T[], fn?: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += fn ? fn(item) : Number(item);
  return total;
}

function groupKey(key: unknown): string {
  if (key == null) return '\0null\0';
  if (typeof key === 'object') return JSON.stringify(key);
  return `${typeof key}:${String(key)}`;
}

function groupBy<T>(items: T[], keyFn: (item: T) => unknown): Array<[unknown, T[]]> {
  const order: string[] = [];
  const orig = new Map<string, unknown>();
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const sk = groupKey(key);
    let bucket = buckets.get(sk);
    if (!bucket) {
      bucket = [];
      buckets.set(sk, bucket);
      orig.set(sk, key);
      order.push(sk);
    }
    bucket.push(item);
  }
  return order.map((sk) => [orig.get(sk), buckets.get(sk)!]);
}

function rubyOr<T>(value: unknown, fallback: T): T {
  if (value == null || value === false) return fallback;
  return value as T;
}

function rubyTruthy(value: unknown): boolean {
  return value != null && value !== false;
}

function compact<T>(items: Array<T | null | undefined>): T[] {
  return items.filter((item): item is T => item != null);
}

function filterMap<T, U>(items: T[], fn: (item: T) => U | null | undefined | false): U[] {
  const out: U[] = [];
  for (const item of items) {
    const v = fn(item);
    if (v !== null && v !== undefined && v !== false) out.push(v);
  }
  return out;
}

function optInt(value: unknown): number | undefined {
  const n = optNum(value);
  return n == null ? undefined : Math.trunc(n);
}

function toInt(value: unknown): number {
  return Math.trunc(num(value));
}

function idKey(id: unknown): string {
  return id == null ? '' : String(id);
}

function lookup<T>(rec: Record<string, T>, id: unknown): T | undefined {
  if (id == null) return undefined;
  return rec[String(id)];
}

function arrayWrap(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function sortByDesc<T>(items: T[], ...fns: Array<(item: T) => number>): T[] {
  return items.sort((a, b) => {
    for (const fn of fns) {
      const d = fn(b) - fn(a);
      if (d) return d;
    }
    return 0;
  });
}

function cmp(a: number | string, b: number | string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isErrorHash(value: unknown): boolean {
  return typeof value === 'object' && value != null && (value as { error?: unknown }).error != null && Boolean((value as { error?: unknown }).error);
}

export class Artizen {
  private venusId: string | undefined;

  constructor(private kv: KVNamespace) {}

  async leaderboard(seasonNumber?: string | number | null): Promise<Leaderboard> {
    const fallback: Leaderboard = { seasons: [], season: null, drives: [], projects: [], funds: [], error: true };
    return this.withArtizenErrors(fallback, () =>
      this.cacheFetch(`${LEADERBOARD_CACHE}/${rubyOr(seasonNumber, 'current')}`, () => this.build(seasonNumber)),
    );
  }

  async project(slug: string): Promise<ProjectPage | null> {
    return this.withArtizenErrors(null, () => this.cacheFetch(`${PROJECT_CACHE}/${slug}`, () => this.buildProject(slug)));
  }

  async fund(slug: string): Promise<FundPage | null> {
    return this.withArtizenErrors(null, () => this.cacheFetch(`${FUND_CACHE}/${slug}`, () => this.buildFund(slug)));
  }

  async refreshCache(): Promise<string> {
    const started = Date.now();
    const seasons = await this.fetchSeasons();

    for (const season of seasons) {
      console.log(`[Artizen] leaderboard season ${season.number}`);
      const data = await this.rebuild(`${LEADERBOARD_CACHE}/${season.number}`, () => this.build(season.number));
      if (data == null || data.error) continue;
      if (season.current) await this.cacheWrite(`${LEADERBOARD_CACHE}/current`, data);
    }

    let dropped = await this.deleteByPrefix(`${PROJECT_CACHE}/`);
    dropped += await this.deleteByPrefix(`${FUND_CACHE}/`);

    const summary = `[Artizen] refreshed ${seasons.length} seasons, dropped ${dropped} project/fund stashes in ${Math.round((Date.now() - started) / 1000)}s`;
    console.log(summary);
    return summary;
  }

  richText(text?: string | null): string | undefined {
    if (blank(text)) return undefined;

    let html = str(text);
    html = html.replace(/\[url=([^\]]+)\](.*?)\[\/url\]/gs, '<a href="$1" target="_blank" rel="noopener">$2</a>');
    html = html.replace(/\[b\](.*?)\[\/b\]/gs, '<strong>$1</strong>');
    html = html.replace(/\[i\](.*?)\[\/i\]/gs, '<em>$1</em>');
    html = html.replace(/\[\/?ml\]/g, '');
    html = html.replace(/\[ul\]/g, '<ul>');
    html = html.replace(/\[\/ul\]/g, '</ul>');
    html = html.replace(/\[li[^\]]*\]/g, '<li>');
    html = html.replace(/\[\/li\]/g, '</li>');
    html = html.replace(/\r\n?/g, '\n');
    html = html.replace(/\n{2,}/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    return `<p>${html}</p>`;
  }

  videoIframe(url?: string | null): string | undefined {
    if (blank(url)) return undefined;

    const youtube = String(url).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]+)/);
    if (youtube) {
      return `<div class="embed-responsive embed-responsive-16by9 mb-3"><iframe class="embed-responsive-item" src="https://www.youtube.com/embed/${youtube[1]}" allowfullscreen></iframe></div>`;
    }
    const vimeo = String(url).match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (vimeo) {
      return `<div class="embed-responsive embed-responsive-16by9 mb-3"><iframe class="embed-responsive-item" src="https://player.vimeo.com/video/${vimeo[1]}" allowfullscreen></iframe></div>`;
    }
    return `<p><a href="${url}" target="_blank" rel="noopener">Watch presentation</a></p>`;
  }

  private async build(seasonNumber?: string | number | null): Promise<Leaderboard> {
    const seasons = await this.fetchSeasons();
    const season = this.pickSeason(seasons, seasonNumber);
    if (!season) return { seasons, season: null, drives: [], projects: [], funds: [], error: true };

    return {
      seasons,
      season,
      drives: await this.fetchDrives(season.id),
      projects: await this.projectRows(season),
      funds: await this.fundRows(season.id, { current: season.current }),
      error: false,
    };
  }

  private async fetchSeasons(): Promise<Season[]> {
    const seasons = sortByDesc(
      filterMap(await this.list('season'), (row) => {
        const number = optInt(row['season number']);
        if (number == null) return undefined;

        const tag = row['Season tag'];
        return {
          id: str(row['_id']),
          number,
          title: str(rubyOr(row['title'], `Season ${number}`)),
          tag,
          current: !blank(tag) && tag != 'Ended',
          total_raised: optNum(row['total raised usd']),
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

  private pickSeason(seasons: Season[], seasonNumber?: string | number | null): Season | undefined {
    let found: Season | undefined;
    if (!blank(seasonNumber)) found = seasons.find((s) => s.number === toInt(seasonNumber));
    return found || seasons.find((s) => s.current) || seasons[0];
  }

  private async projectRows(season: Season): Promise<ProjectRow[]> {
    const seasonId = season.id;
    const rows = (await this.list('projectseason', {
      sortField: 'funding total',
      descending: true,
      constraints: [
        { key: 'season ', constraint_type: 'equals', value: seasonId },
        { key: 'funding total', constraint_type: 'greater than', value: 0 },
      ],
    })).filter((row) => !row['hide from competition']);
    if (rows.length === 0) return this.legacySeasonProjectRows(season);

    const projects = await this.indexed('project', rows.map((r) => r['project']));
    const venusByProject = await this.venusBuysByProject(seasonId);
    const prizes = await this.drivePrizesByProject(seasonId);

    return filterMap(rows, (row) => {
      const project = lookup(projects, row['project']) || {};
      if (project['Hide'] || project['unPublished']) return undefined;

      const name = str(presence(project['Name']) ?? row['name']).trim();
      if (blank(name)) return undefined;

      const slug = presence(project['Slug']) ?? row['project'];
      const venus = num(lookup(venusByProject, row['project']));
      const ledgerPrize = num(row['funding prize funds usd']);
      const prize = Math.max(ledgerPrize, num(lookup(prizes, row['project'])));
      return {
        name,
        url: this.localProjectPath(slug),
        creator: presence(str(rubyOr(project[LEAD_CREATOR], row['lead creator'])).trim()),
        logline: presence(project['Logline']),
        sales: this.communitySales(row['funding total sales'], venus),
        venus,
        match: num(row['funding match']) + num(row['funding boost ']),
        prize,
        raised: num(row['funding total']) + prize - ledgerPrize,
      };
    });
  }

  private async fetchDrives(seasonId: string): Promise<Drive[]> {
    const drives = sortByDesc(
      (await this.list('boost', {
        constraints: [
          { key: 'season', constraint_type: 'equals', value: seasonId },
          { key: 'Type', constraint_type: 'equals', value: 'Fund drive' },
        ],
      })).map((row) => this.normalizeDrive(row)),
      (drive) => drive.number || 0,
    );
    await this.attachDrivePodiums(drives);
    return drives;
  }

  private async attachDrivePodiums(drives: Drive[]): Promise<void> {
    if (drives.length === 0) return;

    const pages = await this.parallel(drives, (drive) =>
      this.getResults('boostparticipant', {
        limit: 100,
        cursor: 0,
        sort_field: 'boost score',
        descending: true,
        constraints: JSON.stringify([{ key: 'boost', constraint_type: 'equals', value: drive.id }]),
      }),
    );
    const records = pages.flat();
    const catalogs = {
      project: await this.indexed('project', records.map((row) => row['project'])),
      fund: await this.indexed('fund', records.map((row) => row['fund'])),
    };
    drives.forEach((drive, i) => {
      const rows = pages[i];
      drive.podium = this.podiumRows(rows, 'project', catalogs.project);
      drive.fund_podium = this.podiumRows(rows, 'fund', catalogs.fund);
    });
  }

  private podiumRows(rows: Row[], kind: 'project' | 'fund', records: Record<string, Row>): PodiumRow[] {
    const field = kind;
    const nameField = kind === 'fund' ? 'name' : 'Name';
    return filterMap(rows, (row) => {
      if (kind === 'fund' && !blank(row['project'])) return undefined;

      const id = row[field];
      if (blank(id)) return undefined;

      const record = lookup(records, id);
      const slug = (record && presence(rubyOr(record['Slug'], record['slugg']))) || id;
      const points = num(row['boost points received']);
      const salesMatch = num(row['sales + match (both)']);
      return {
        name: presence(str(record && record[nameField]).trim()) || (field[0].toUpperCase() + field.slice(1)),
        url: kind === 'fund' ? this.localFundPath(slug) : this.localProjectPath(slug),
        sales_match: salesMatch,
        points,
        score: (points * salesMatch) / 100.0,
      };
    }).slice(0, 3);
  }

  private normalizeDrive(row: Row): Drive {
    const slug = row['slugg'];
    return {
      id: str(row['_id']),
      name: str(row['Name']).trim(),
      slug,
      url: `${SITE_URL}/index/boost/${presence(slug) ?? row['_id']}`,
      season_id: row['season'],
      season_number: optInt(row['season number']),
      image: this.mediaUrl(row['image']),
      description: presence(row['Description']),
      status: row['status'],
      active: row['status'] == 'Active',
      number: optInt(row['fund drive number']),
      start: row['start date'],
      end: row['end date'],
      multiple: optNum(row['boost multiple']),
      match_pot: optNum(row['total match pot funds']),
      prize_projects: optNum(row['prize pot projects']),
      prize_funds: optNum(row['prize pot funds']),
      goal: optNum(row['goal']),
      match_per_project: optNum(row['Artizen match per project']),
      ...this.drivePlacePrizes(row),
    };
  }

  private drivePlacePrizes(row: Row): Pick<Drive, 'project_first' | 'project_second' | 'project_third' | 'fund_first' | 'fund_second' | 'fund_third'> {
    const out: Record<string, number | undefined> = {};
    for (const kind of ['project', 'fund'] as const) {
      for (const [ord, nth] of [['first', '1st'], ['second', '2nd'], ['third', '3rd']] as const) {
        out[`${kind}_${ord}`] = optNum(row[`${kind} ${nth} prize `]);
      }
    }
    return out;
  }

  private projectDriveDetails(drives: Drive[], statsByDrive: Record<string, DriveStat>): ProjectDriveDetail[] {
    return filterMap(drives, (drive) => {
      const stat = statsByDrive[drive.id];
      if (!stat) return undefined;
      if (!(num(stat.available) > 0 || num(stat.raised) > 0 || num(stat.sales) > 0 || num(stat.venus) > 0)) return undefined;

      return {
        ...stat,
        name: drive.name,
        status: drive.status,
        active: drive.active,
        number: drive.number,
        url: drive.url,
        multiple: drive.multiple,
        season: drive.season,
        season_id: drive.season_id,
        season_number: drive.season_number,
      };
    });
  }

  private nestProjectFunding(seasons: ProjectFundingSeason[], drives: ProjectDriveDetail[], matchingFunds: MatchingFund[]): ProjectFundingSeason[] {
    const known = seasons.map((season) => season.number);
    for (const row of [...drives, ...matchingFunds]) {
      if (known.some((n) => n == row.season_number)) continue;

      seasons.push({
        number: row.season_number,
        title: rubyOr(row.season, `Season ${row.season_number}`),
        sales: 0.0,
        venus: 0.0,
        match: 0.0,
        prize: 0.0,
        raised: 0.0,
      });
      known.push(row.season_number);
    }
    sortByDesc(seasons, (season) => season.number || 0);

    return seasons.map((season) => {
      const seasonDrives = drives.filter((drive) => drive.season_number == season.number);
      const seasonFunds = matchingFunds.filter((fund) => fund.season_number == season.number);
      const named = seasonDrives.map((drive) => drive.name);
      const stubs = uniq(seasonFunds.map((fund) => fund.drive)).filter((name) => !named.some((n) => n == name));
      for (const name of stubs) {
        const sample = seasonFunds.find((fund) => fund.drive == name);
        seasonDrives.push({
          name: name as string,
          url: null,
          active: sample && sample.drive_active,
          number: sample && sample.drive_number,
          sales: 0.0,
          venus: 0.0,
          match: 0.0,
          prize: 0.0,
          available: sum(
            seasonFunds.filter((fund) => fund.drive == name),
            (fund) => num(fund.available),
          ),
          multiple: sample && sample.drive_multiple,
          status: undefined,
          season: undefined,
          season_id: undefined,
          raised: 0,
        });
      }
      sortByDesc(seasonDrives, (drive) => drive.number || 0);
      const nested = seasonDrives.map((drive) => ({
        ...drive,
        funds: seasonFunds.filter((fund) => fund.drive == drive.name),
      }));
      return {
        ...season,
        available: sum(nested, (drive) => num(drive.available)),
        drives: nested,
      };
    });
  }

  private nestFundFunding(contribSeasons: FundFundingSeason[], matchedProjects: FundMatchedProject[], unallocated = 0): FundFundingSeason[] {
    const seasons = contribSeasons.map((season) => ({ ...season }));
    const known = seasons.map((season) => season.number);
    for (const project of matchedProjects) {
      if (known.some((n) => n == project.season_number)) continue;

      seasons.push({
        number: project.season_number,
        title: rubyOr(project.season, `Season ${project.season_number}`),
        total: 0.0,
        count: 0,
      });
      known.push(project.season_number);
    }
    sortByDesc(seasons, (season) => season.number || 0);

    const nested = seasons.map((season) => {
      const seasonProjects = matchedProjects.filter((project) => project.season_number == season.number);
      const drives: FundDriveNest[] = sortByDesc(
        groupBy(seasonProjects, (project) => rubyOr(project.drive, 'Drive')).map(([name, projects]) => {
          const sample = projects[0];
          const active = sample && sample.drive_active;
          const leftover = sum(projects, (project) => num(project.available));
          return {
            name: str(name),
            url: sample && sample.drive_url,
            active,
            number: sample && sample.drive_number,
            multiple: sample && sample.drive_multiple,
            unlocked: sum(projects, (project) => num(project.unlocked)),
            available: active ? leftover : 0.0,
            projects: [...projects].sort((a, b) => {
              const av = num(b.available) - num(a.available);
              if (av) return av;
              return num(b.unlocked) - num(a.unlocked);
            }),
          } satisfies FundDriveNest;
        }),
        (drive) => drive.number || 0,
      );
      return {
        ...season,
        unlocked: sum(drives, (drive) => drive.unlocked),
        available: sum(drives, (drive) => drive.available),
        drives,
      };
    });

    if (num(unallocated) >= 0.5 && nested.length > 0) {
      const latest = nested[0];
      const row: FundDriveNest = {
        name: 'Unallocated',
        url: null,
        active: false,
        adjustment: true,
        number: null,
        multiple: null,
        unlocked: 0.0,
        available: num(unallocated),
        projects: [],
      };
      const activeIdx = latest.drives!.findIndex((drive) => drive.active);
      if (activeIdx >= 0) latest.drives!.splice(activeIdx + 1, 0, row);
      else latest.drives!.push(row);
      latest.available = num(latest.available) + num(unallocated);
    }

    return nested;
  }

  private async buildProject(slug: string): Promise<ProjectPage | null> {
    const row = await this.findOne('project', slug);
    if (row == null || row['Hide']) return null;

    const id = str(row['_id']);
    const slugValue = presence(row['Slug']) ?? id;
    const seasonsMeta = await this.seasonsById();
    const seasonRows = await this.list('projectseason', {
      constraints: [{ key: 'project', constraint_type: 'equals', value: id }],
    });
    const slices = await this.list('projectfundboostslice', {
      constraints: [{ key: 'project', constraint_type: 'equals', value: id }],
    });
    const participants = await this.list('boostparticipant', {
      constraints: [{ key: 'project', constraint_type: 'equals', value: id }],
    });

    const boostIds = uniq(compact([...slices, ...participants].map((r) => r['boost'])));
    const drives = await this.fetchNormalizedDrives(boostIds, seasonsMeta);
    sortByDesc(drives, (d) => d.season_number || 0, (d) => d.number || 0);

    const venusTxs = await this.venusTransactions({ projectId: id });
    const venusBySeason: Record<string, number> = {};
    const venusByBoost: Record<string, number> = {};
    for (const tx of venusTxs) {
      const seasonKey = idKey(tx['Season']);
      venusBySeason[seasonKey] = (venusBySeason[seasonKey] || 0) + num(tx['amount spent $USD']);
      const drive = this.assignVenusDrive(tx, drives);
      if (drive) {
        venusByBoost[drive.id] = (venusByBoost[drive.id] || 0) + num(tx['amount spent $USD']);
      }
    }

    const prizeBySeason: Record<string, number> = {};
    const stats: Record<string, Record<string, DriveStat>> = {};
    stats[id] = stats[id] || {};
    for (const part of participants) {
      if (blank(part['boost'])) continue;

      const venus = num(venusByBoost[idKey(part['boost'])]);
      const prize = num(part['prize earned usd']);
      stats[id][idKey(part['boost'])] = {
        sales: this.communitySales(part['fund drive sales (both)'], venus),
        venus,
        match: num(part['match boost unlocked (both)']),
        prize,
        raised: num(part['sales + match (both)']) + prize,
      };
      let seasonId = part['season'];
      if (blank(seasonId)) {
        const drive = drives.find((d) => d.id == part['boost']);
        seasonId = drive && drive.season_id;
      }
      if (rubyTruthy(seasonId) && prize > 0) {
        const sk = idKey(seasonId);
        prizeBySeason[sk] = (prizeBySeason[sk] || 0) + prize;
      }
    }
    for (const [boostId, rows] of groupBy(slices, (s) => s['boost'])) {
      if (blank(boostId)) continue;

      const leftover = this.leftoverMatch(rows);
      if (!(leftover > 0)) continue;

      const drive = drives.find((d) => d.id == boostId);
      const key = idKey(boostId);
      stats[id][key] ||= { sales: 0.0, venus: 0.0, match: 0.0, raised: 0.0 };
      stats[id][key].available = drive && drive.active ? leftover : 0.0;
    }

    const fundIds = uniq(compact(slices.map((s) => s['fund'])));
    const fundsById = await this.indexed('fund', fundIds);
    const matchingFunds = sortByDesc(
      filterMap(groupBy(slices, (s) => [s['fund'], s['boost']]), ([pair, rows]) => {
        const [fundId, boostId] = pair as [unknown, unknown];
        const fund = lookup(fundsById, fundId);
        if (!fund) return undefined;

        const drive = drives.find((d) => d.id == boostId);
        const fundSlug = presence(fund['Slug']) ?? fundId;
        return {
          name: str(fund['name']).trim(),
          url: this.localFundPath(fundSlug),
          drive: drive && drive.name,
          drive_active: drive && drive.active,
          drive_number: drive && drive.number,
          drive_multiple: drive && drive.multiple,
          season: drive && drive.season,
          season_number: drive && drive.season_number,
          available: drive && drive.active ? this.leftoverMatch(rows) : 0.0,
          unlocked: sum(rows, (r) => num(r['match unlocked'])),
          cap: sum(rows, (r) => num(r['match cap $'])),
        } satisfies MatchingFund;
      }),
      (f) => f.season_number || 0,
      (f) => f.drive_number || 0,
      (f) => f.cap,
    );

    const tagIds = arrayWrap(row['impact tags (impact tag)']);
    const tags = compact((await this.fetchByIds('impacttag', tagIds)).map((t) => t['name'] as string | undefined));

    const driveDetails = this.projectDriveDetails(drives, stats[id]);
    const seasonImage = [...seasonRows]
      .sort((a, b) => toInt(rubyOr(b['season number'], 0)) - toInt(rubyOr(a['season number'], 0)))
      .map((srow) => srow['image crop'])
      .find((img) => !blank(img));
    const seasons = filterMap(seasonRows, (srow) => {
      const meta = lookup(seasonsMeta, srow['season ']);
      const sVenus = num(venusBySeason[idKey(srow['season '])]);
      const sSales = this.communitySales(srow['funding total sales'], sVenus);
      const sMatch = num(srow['funding match']) + num(srow['funding boost ']);
      const sPrize = Math.max(
        num(srow['funding prize funds usd']),
        num(prizeBySeason[idKey(srow['season '])]),
        num(srow['old funding prize leaderboard  (usd)']),
      );
      const sRaised = sSales + sVenus + sMatch + sPrize;
      if (!(sRaised > 0)) return undefined;

      return {
        number: rubyOr(srow['season number'], meta?.number) as number | undefined,
        title: rubyOr(meta?.title, `Season ${srow['season number']}`),
        sales: sSales,
        venus: sVenus,
        match: sMatch,
        prize: sPrize,
        raised: sRaised,
      } satisfies ProjectFundingSeason;
    });
    const submissionRows = await this.list('projectsubmission', {
      constraints: [{ key: 'Project', constraint_type: 'equals', value: id }],
    });
    this.appendLegacyProjectSeasons(seasons, row, seasonsMeta);
    this.applyLegacySubmissionAwards(seasons, submissionRows, seasonsMeta);
    sortByDesc(seasons, (s) => s.number || 0);
    return {
      name: str(row['Name']).trim(),
      artizen_url: this.projectUrl(slugValue),
      creator: presence(str(row[LEAD_CREATOR]).trim()),
      logline: presence(row['Logline']),
      description: presence(row['Description']),
      impact: presence(row['Impact']),
      progress: presence(row['Progress']),
      team: presence(row['Team']),
      image: this.mediaUrl(rubyOr(row['(old) Artifact Image -crop'], rubyOr(seasonImage, row['Profile image lead creator']))),
      video: presence(row['video presentation']),
      tags,
      seasons: this.nestProjectFunding(seasons, driveDetails, matchingFunds),
      submissions: await this.formatProjectSubmissions(submissionRows, seasonsMeta),
    };
  }

  private async formatProjectSubmissions(rows: Row[], seasonsMeta: Record<string, Season>): Promise<ProjectSubmission[]> {
    const kept = rows.filter((row) => !(row['Submitted'] == false));
    const fundIds = uniq(compact(kept.map((row) => row['Fund'])));
    const fundsById = await this.indexed('fund', fundIds);
    return filterMap(kept, (row) => {
      const fund = lookup(fundsById, row['Fund']);
      if (!fund) return undefined;

      const slug = presence(fund['Slug']) ?? row['Fund'];
      const meta = lookup(seasonsMeta, row['season']);
      const number = rubyOr(row['season number'], meta?.number) as number | undefined;
      return {
        name: str(fund['name']).trim(),
        url: this.localFundPath(slug),
        status: presence(str(row['Status'])),
        season: rubyOr(meta?.title, rubyTruthy(number) ? `Season ${number}` : undefined),
        season_number: number,
        created_at: row['Created Date'],
      } satisfies ProjectSubmission;
    }).sort((a, b) => {
      let c = cmp(b.season_number || 0, a.season_number || 0);
      if (c !== 0) return c;

      c = cmp(this.submissionStatusRank(a.status), this.submissionStatusRank(b.status));
      return c === 0 ? cmp(str(b.created_at), str(a.created_at)) : c;
    });
  }

  private submissionStatusRank(status: string | undefined): number {
    switch (status) {
      case 'Curated':
      case 'Approved':
        return 0;
      case 'Submitted':
        return 1;
      default:
        return 2;
    }
  }

  private async buildFund(slug: string): Promise<FundPage | null> {
    const row = await this.findOne('fund', slug);
    if (!row) return null;

    const id = str(row['_id']);
    const slugValue = presence(row['Slug']) ?? id;
    const ext = rubyTruthy(row['Extended info'])
      ? (await this.findBy('fundextendedinfo', '_id', row['Extended info']))[0]
      : undefined;

    const slices = await this.list('projectfundboostslice', {
      constraints: [
        { key: 'fund', constraint_type: 'equals', value: id },
        { key: 'match cap $', constraint_type: 'greater than', value: 0 },
      ],
    });
    const awardRows = await this.listFundAwards([id]);
    const projectIds = uniq(compact([...slices.map((s) => s['project']), ...awardRows.map((s) => s['Project'])]));
    const projects = await this.indexed('project', projectIds);
    const boostIds = uniq(compact(slices.map((s) => s['boost'])));
    const seasonsMeta = await this.seasonsById();
    const driveList = await this.fetchNormalizedDrives(boostIds, seasonsMeta);
    const drives: Record<string, Drive> = Object.fromEntries(driveList.map((d) => [d.id, d]));

    const matchedProjects: FundMatchedProject[] = filterMap(groupBy(slices, (s) => [s['project'], s['boost']]), ([pair, rows]) => {
      const [projectId, boostId] = pair as [unknown, unknown];
      const project = lookup(projects, projectId);
      if (!project) return undefined;

      const drive = lookup(drives, boostId);
      const projectSlug = presence(project['Slug']) ?? projectId;
      return {
        name: str(project['Name']).trim(),
        url: this.localProjectPath(projectSlug),
        creator: presence(str(project[LEAD_CREATOR]).trim()),
        hidden: project['Hide'] || project['unPublished'],
        drive: drive && drive.name,
        drive_url: drive && drive.url,
        drive_active: drive && drive.active,
        drive_number: drive && drive.number,
        drive_multiple: drive && drive.multiple,
        season: drive && drive.season,
        season_number: drive && drive.season_number,
        available: this.leftoverMatch(rows),
        unlocked: sum(rows, (r) => num(r['match unlocked'])),
      } satisfies FundMatchedProject;
    });
    matchedProjects.push(...this.fundAwardProjects(awardRows, projects, seasonsMeta));

    const contribs = await this.list('fundcontribution', {
      constraints: [
        { key: 'Fund', constraint_type: 'equals', value: id },
        { key: 'confirmed', constraint_type: 'equals', value: true },
      ],
    });
    const contribSeasons = filterMap(groupBy(contribs, (c) => c['Season']), ([seasonId, rows]) => {
      const meta = lookup(seasonsMeta, seasonId);
      return {
        number: meta?.number,
        title: rubyOr(meta?.title, 'Season'),
        total: sum(rows, (r) => num(r['amount $USD'])),
        count: rows.length,
      } satisfies FundFundingSeason;
    });

    const contribTotal = sum(contribs, (c) => num(c['amount $USD']));
    const slicedAvailable = sum(
      matchedProjects.filter((project) => project.drive_active),
      (project) => num(project.available),
    );
    const unallocated = num(row['Funding - current']) - slicedAvailable;
    const seasons = this.nestFundFunding(contribSeasons, matchedProjects, unallocated);

    return {
      name: (ext && presence(ext['full title'])) || str(row['name']).trim(),
      artizen_url: this.fundUrl(slugValue),
      image: this.mediaUrl(row['cover image']),
      subtitle: ext ? presence(ext['subtitle']) : undefined,
      for_title: ext ? presence(ext['for title']) : undefined,
      description: ext ? presence(ext['description']) : undefined,
      eligibility: ext ? presence(ext['eligibility']) : undefined,
      sponsor: ext ? presence(ext['lead sponsor (text)']) : undefined,
      video: ext ? presence(ext['welcome video']) : undefined,
      available: sum(seasons, (season) => num(season.available)),
      unlocked: sum(seasons, (season) => num(season.unlocked)),
      prize_art: optNum(row['Prize ART']),
      prize_usd: optNum(row['Prize USD']),
      active: row['active'],
      contrib_total: contribTotal,
      seasons,
    };
  }

  private async findOne(type: string, slug: string, slugField = 'Slug'): Promise<Row | undefined> {
    const rows = await this.findBy(type, slugField, slug, 5);
    const row = rows.find((r) => !r['Hide'] && !r['unPublished']) || rows[0];
    if (row) return row;

    return (await this.findBy(type, '_id', slug))[0];
  }

  private async fundRows(seasonId: string, { current = false } = {}): Promise<FundRow[]> {
    const contribs = await this.list('fundcontribution', {
      constraints: [
        { key: 'Season', constraint_type: 'equals', value: seasonId },
        { key: 'confirmed', constraint_type: 'equals', value: true },
      ],
    });

    const totals: Record<string, number> = {};
    const lastAt: Record<string, unknown> = {};
    for (const contrib of contribs) {
      const id = contrib['Fund'];
      if (blank(id)) continue;

      const key = idKey(id);
      totals[key] = (totals[key] || 0) + num(contrib['amount $USD']);
      const created = contrib['Created Date'];
      if (created && (lastAt[key] == null || created > (lastAt[key] as string))) lastAt[key] = created;
    }

    const funds = await this.fetchByIds('fund', Object.keys(totals));
    const unlocked = current ? await this.fundUnlocked(Object.keys(totals)) : {};
    const exts = await this.indexed(
      'fundextendedinfo',
      funds.map((fund) => fund['Extended info']),
    );
    const ranked = filterMap(funds, (fund) => {
      const id = str(fund['_id']);
      const seasonTotal = num(totals[id]);
      if (!(seasonTotal > 0)) return undefined;

      const slug = presence(fund['Slug']) ?? id;
      const ext = lookup(exts, fund['Extended info']);
      const row: FundRow = {
        name: str(fund['name']).trim(),
        subtitle: ext ? presence(ext['subtitle']) : undefined,
        url: this.localFundPath(slug),
        season_total: seasonTotal,
        last_contribution: lastAt[id],
        active: fund['active'],
      };
      if (current) {
        row.unlocked = num(unlocked[id]);
        row.available = optNum(fund['Funding - current']);
        row.raised = num(row.available) + row.unlocked;
      }
      return row;
    });
    return ranked.sort((a, b) => {
      if (current) {
        const av = num(b.available) - num(a.available);
        if (av) return av;
        return b.season_total - a.season_total;
      }
      return b.season_total - a.season_total;
    });
  }

  private async fundUnlocked(fundIds: unknown[]): Promise<Record<string, number>> {
    const unlocked: Record<string, number> = {};
    const ids = uniq(compact(fundIds));
    for (const batch of batches(ids, IN_BATCH)) {
      const slices = await this.list('projectfundboostslice', {
        constraints: [
          { key: 'fund', constraint_type: 'in', value: batch },
          { key: 'match unlocked', constraint_type: 'greater than', value: 0 },
        ],
      });
      for (const slice of slices) {
        const key = idKey(slice['fund']);
        unlocked[key] = (unlocked[key] || 0) + num(slice['match unlocked']);
      }
    }
    for (const row of await this.listFundAwards(ids)) {
      const key = idKey(row['Fund']);
      unlocked[key] = (unlocked[key] || 0) + num(row['$ amount raised']);
    }
    return unlocked;
  }

  private async listFundAwards(fundIds: unknown[]): Promise<Row[]> {
    const ids = uniq(compact(fundIds));
    if (ids.length === 0) return [];

    const pages = await this.parallel(batches(ids, IN_BATCH), (batch) =>
      this.list('projectsubmission', {
        constraints: [
          { key: 'Fund', constraint_type: 'in', value: batch },
          { key: 'Status', constraint_type: 'equals', value: 'Curated' },
          { key: '$ amount raised', constraint_type: 'greater than', value: 0 },
        ],
      }),
    );
    return pages.flat();
  }

  private fundAwardProjects(awardRows: Row[], projects: Record<string, Row>, seasonsMeta: Record<string, Season>): FundMatchedProject[] {
    return filterMap(
      groupBy(awardRows, (row) => {
        const number = rubyOr(row['season number'], lookup(seasonsMeta, row['season'])?.number);
        return [row['Project'], number];
      }),
      ([pair, rows]) => {
        const [projectId, number] = pair as [unknown, unknown];
        const raised = sum(rows, (row) => num(row['$ amount raised']));
        if (!(raised > 0 && rubyTruthy(number))) return undefined;

        const project = lookup(projects, projectId);
        const meta = lookup(seasonsMeta, rows[0]['season']);
        const projectSlug = (project && presence(project['Slug'])) || projectId;
        return {
          name: presence(str(project && project['Name']).trim()) || 'Project',
          url: this.localProjectPath(projectSlug),
          creator: project ? presence(str(project[LEAD_CREATOR]).trim()) : undefined,
          hidden: project && (project['Hide'] || project['unPublished']),
          drive: 'Awards',
          drive_url: null,
          drive_active: false,
          drive_number: null,
          drive_multiple: null,
          season: rubyOr(meta?.title, `Season ${number}`),
          season_number: number as number,
          available: 0.0,
          unlocked: raised,
        } satisfies FundMatchedProject;
      },
    );
  }

  private async list(
    type: string,
    opts: { constraints?: Constraint[]; sortField?: string; descending?: boolean } = {},
  ): Promise<Row[]> {
    const params: Record<string, unknown> = { limit: PAGE_SIZE };
    if (opts.constraints) params.constraints = JSON.stringify(opts.constraints);
    if (opts.sortField) params.sort_field = opts.sortField;
    if (opts.descending) params.descending = true;

    const first = await this.get(type, { ...params, cursor: 0 });
    const results = first.results || [];
    const remaining = toInt(first.remaining);
    if (remaining <= 0) return results;

    const pageCount = Math.ceil(remaining / PAGE_SIZE);
    const cursors = Array.from({ length: pageCount }, (_, i) => (i + 1) * PAGE_SIZE);
    const extra = await this.parallel(cursors, (cursor) => this.getResults(type, { ...params, cursor }));
    return results.concat(extra.flat());
  }

  private async fetchByIds(type: string, ids: unknown[]): Promise<Row[]> {
    const compactIds = uniq(compact(ids));
    if (compactIds.length === 0) return [];

    const pages = await this.parallel(batches(compactIds, IN_BATCH), (batch) =>
      this.getResults(type, {
        limit: PAGE_SIZE,
        constraints: JSON.stringify([{ key: '_id', constraint_type: 'in', value: batch }]),
      }),
    );
    return pages.flat();
  }

  private async indexed(type: string, ids: unknown[]): Promise<Record<string, Row>> {
    const rows = await this.fetchByIds(type, ids);
    return Object.fromEntries(rows.filter((row) => row['_id'] != null).map((row) => [String(row['_id']), row]));
  }

  private async seasonsById(): Promise<Record<string, Season>> {
    const seasons = await this.fetchSeasons();
    return Object.fromEntries(seasons.map((s) => [s.id, s]));
  }

  private async fetchNormalizedDrives(boostIds: unknown[], seasonsMeta: Record<string, Season>): Promise<Drive[]> {
    const drives = (await this.fetchByIds('boost', boostIds)).map((r) => this.normalizeDrive(r));
    this.applySeasonNames(drives, seasonsMeta);
    return drives;
  }

  private leftoverMatch(rows: Row[]): number {
    return sum(rows, (r) => num(r['match cap $']) - num(r['match unlocked']));
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

  private async get(type: string, params: Record<string, unknown>): Promise<BubbleResponse> {
    const url = new URL(`${BASE_URL}/${type}`);
    for (const [key, value] of Object.entries(params)) {
      if (value == null) continue;
      url.searchParams.set(key, typeof value === 'string' ? value : String(value));
    }
    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Artizen API ${response.status} for ${type}`);

    const body = JSON.parse(await response.text()) as { response?: BubbleResponse };
    const result = body.response;
    if (result == null) throw new Error(`missing response`);
    return result;
  }

  private async getResults(type: string, params: Record<string, unknown>): Promise<Row[]> {
    return (await this.get(type, params)).results || [];
  }

  private async findBy(type: string, key: string, value: unknown, limit = 1): Promise<Row[]> {
    return this.getResults(type, {
      limit,
      constraints: JSON.stringify([{ key, constraint_type: 'equals', value }]),
    });
  }

  private async parallel<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
    if (items.length === 0) return [];
    if (items.length === 1) return [await fn(items[0])];

    const results: R[] = new Array(items.length);
    let error: unknown;
    let nextIndex = 0;

    const worker = async () => {
      for (;;) {
        if (error) break;
        const i = nextIndex++;
        if (i >= items.length) break;
        try {
          results[i] = await fn(items[i]);
        } catch (e) {
          error ??= e;
          break;
        }
      }
    };

    const n = Math.min(PARALLEL, items.length);
    await Promise.all(Array.from({ length: n }, () => worker()));
    if (error) throw error;
    return results;
  }

  private async cacheFetch<T>(key: string, build: () => Promise<T>): Promise<T> {
    const cached = await this.kv.get(key);
    if (cached != null) return JSON.parse(cached) as T;
    return this.cacheWrite(key, await build());
  }

  private async cacheWrite<T>(key: string, value: T): Promise<T> {
    if (value && !isErrorHash(value)) {
      await this.kv.put(key, JSON.stringify(value));
    }
    return value;
  }

  private async rebuild<T>(key: string, build: () => Promise<T>): Promise<T | null> {
    return this.withArtizenErrors(null, async () => this.cacheWrite(key, await build()), key);
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

  private async venusAccountId(): Promise<string> {
    if (this.venusId !== undefined) return this.venusId;

    const rows = await this.findBy('useraccount', 'name', 'Venus');
    this.venusId = str(rubyOr(rows[0] && rows[0]['_id'], VENUS_ACCOUNT_ID));
    return this.venusId;
  }

  private async venusTransactions(opts: { seasonId?: string | null; projectId?: string | null } = {}): Promise<Row[]> {
    const id = await this.venusAccountId();
    if (blank(id)) return [];

    const constraints: Constraint[] = [
      { key: 'Buyer (User account)', constraint_type: 'equals', value: id },
      { key: 'confirmed', constraint_type: 'equals', value: true },
    ];
    if (opts.seasonId) constraints.push({ key: 'Season', constraint_type: 'equals', value: opts.seasonId });
    if (opts.projectId) constraints.push({ key: 'project', constraint_type: 'equals', value: opts.projectId });
    return this.list('transaction', { constraints });
  }

  private async venusBuysByProject(seasonId: string): Promise<Record<string, number>> {
    const sums: Record<string, number> = {};
    for (const tx of await this.venusTransactions({ seasonId })) {
      const pid = tx['project'];
      if (blank(pid)) continue;

      const key = idKey(pid);
      sums[key] = (sums[key] || 0) + num(tx['amount spent $USD']);
    }
    return sums;
  }

  private async drivePrizesByProject(seasonId: string): Promise<Record<string, number>> {
    const sums: Record<string, number> = {};
    const parts = await this.list('boostparticipant', {
      constraints: [
        { key: 'season', constraint_type: 'equals', value: seasonId },
        { key: 'prize earned usd', constraint_type: 'greater than', value: 0 },
      ],
    });
    for (const part of parts) {
      const pid = part['project'];
      if (blank(pid)) continue;

      const key = idKey(pid);
      sums[key] = (sums[key] || 0) + num(part['prize earned usd']);
    }
    return sums;
  }

  private assignVenusDrive(tx: Row, drives: Drive[]): Drive | undefined {
    const created = this.parseTime(tx['Created Date']);
    if (!created) return undefined;

    let candidates = drives.filter((drive) => drive.season_id == tx['Season']);
    if (candidates.length === 0) candidates = drives;

    const inWindow = candidates.filter((drive) => {
      const start = this.parseTime(drive.start);
      const finish = this.parseTime(drive.end);
      if (!start) return false;
      return created >= start && (finish == null || created <= finish);
    });
    if (inWindow.length > 0) {
      return inWindow.reduce((best, drive) => {
        const a = this.parseTime(drive.start)?.getTime() ?? 0;
        const b = this.parseTime(best.start)?.getTime() ?? 0;
        return a > b ? drive : best;
      });
    }

    const started = candidates.filter((drive) => {
      const start = this.parseTime(drive.start);
      return start != null && start <= created;
    });
    if (started.length === 0) return undefined;
    return started.reduce((best, drive) => {
      const a = this.parseTime(drive.start)?.getTime() ?? 0;
      const b = this.parseTime(best.start)?.getTime() ?? 0;
      return a > b ? drive : best;
    });
  }

  private parseTime(value: unknown): Date | undefined {
    if (blank(value)) return undefined;
    const date = new Date(str(value));
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  private communitySales(gross: unknown, venus: unknown): number {
    const sales = num(gross) - num(venus);
    return sales > 0 ? sales : 0.0;
  }

  // S4/S5 predate projectseason; Artizen stores them on the project record.
  // A later projectseason stub may exist with sales but no prize/match — merge, don't skip.
  private appendLegacyProjectSeasons(seasons: ProjectFundingSeason[], project: Row, seasonsMeta: Record<string, Season>): void {
    const byNumber: Record<number, Season> = Object.fromEntries(
      Object.values(seasonsMeta).map((meta) => [meta.number, meta]),
    );
    const existing: Record<string, ProjectFundingSeason> = Object.fromEntries(seasons.map((season) => [String(season.number), season]));
    for (const number of [4, 5]) {
      const funding = this.legacySeasonFunding(project, number);
      if (!(funding && num(funding.raised) > 0)) continue;

      const row = existing[String(number)];
      if (row) {
        row.sales = Math.max(num(row.sales), num(funding.sales));
        row.match = Math.max(num(row.match), num(funding.match));
        row.prize = Math.max(num(row.prize), num(funding.prize));
        row.raised = row.sales + num(row.venus) + row.match + row.prize;
      } else {
        const meta = byNumber[number];
        seasons.push({
          ...funding,
          number,
          title: rubyOr(meta?.title, `Season ${number}`),
        });
      }
    }
  }

  private legacySeasonFunding(project: Row, number: number): Omit<ProjectFundingSeason, 'number' | 'title'> | undefined {
    switch (number) {
      case 4: {
        const raised = num(project['season 4 total raised ']);
        const match = num(project['season 4 match funding']);
        const sales = Math.max(raised - match, 0.0);
        return { sales, venus: 0.0, match, prize: 0.0, raised };
      }
      case 5: {
        const sales = num(project['season 5 total sales']);
        const prize = num(project['season 5 leaderboard prize (usd)']);
        return { sales, venus: 0.0, match: 0.0, prize, raised: sales + prize };
      }
      default:
        return undefined;
    }
  }

  // S4/S5 fund awards live on curated submissions, not projectseason match/prize.
  private applyLegacySubmissionAwards(seasons: ProjectFundingSeason[], submissionRows: Row[], seasonsMeta: Record<string, Season>): void {
    const awards: Record<number, { match: number; prize: number }> = {};
    for (const row of submissionRows) {
      if (row['Status'] !== 'Curated') continue;

      const number = rubyOr(row['season number'], lookup(seasonsMeta, row['season'])?.number) as number | undefined;
      if (![4, 5].some((n) => n == number)) continue;

      const bucket = (awards[number as number] ||= { match: 0.0, prize: 0.0 });
      bucket.match += num(row['$ amount raised']);
      bucket.prize += num(row['prize unlocked usd']);
    }
    const existing: Record<string, ProjectFundingSeason> = Object.fromEntries(seasons.map((season) => [String(season.number), season]));
    for (const [numberStr, extra] of Object.entries(awards)) {
      const number = Number(numberStr);
      const added = extra.match + extra.prize;
      if (!(added > 0)) continue;

      const row = existing[String(number)];
      if (row) {
        row.match += extra.match;
        row.prize += extra.prize;
        row.raised = num(row.sales) + num(row.venus) + row.match + row.prize;
      } else {
        const meta = Object.values(seasonsMeta).find((season) => season.number === number);
        seasons.push({
          number,
          title: rubyOr(meta?.title, `Season ${number}`),
          sales: 0.0,
          venus: 0.0,
          match: extra.match,
          prize: extra.prize,
          raised: added,
        });
      }
    }
  }

  private async curatedAwardsByProject(seasonId: string): Promise<Record<string, { match: number; prize: number }>> {
    const awards: Record<string, { match: number; prize: number }> = {};
    const rows = await this.list('projectsubmission', {
      constraints: [
        { key: 'season', constraint_type: 'equals', value: seasonId },
        { key: 'Status', constraint_type: 'equals', value: 'Curated' },
      ],
    });
    for (const row of rows) {
      const projectId = row['Project'];
      if (blank(projectId)) continue;

      const key = idKey(projectId);
      const bucket = (awards[key] ||= { match: 0.0, prize: 0.0 });
      bucket.match += num(row['$ amount raised']);
      bucket.prize += num(row['prize unlocked usd']);
    }
    return awards;
  }

  private async legacySeasonProjectRows(season: Season): Promise<ProjectRow[]> {
    const number = season.number;
    let constraints: Constraint[];
    switch (number) {
      case 4:
        constraints = [{ key: 'season 4 total raised ', constraint_type: 'greater than', value: 0 }];
        break;
      case 5:
        constraints = [{ key: 'season 5 total sales', constraint_type: 'greater than', value: 0 }];
        break;
      default:
        return [];
    }
    const awards = await this.curatedAwardsByProject(season.id);
    return filterMap(await this.list('project', { constraints }), (project) => {
      if (project['Hide'] || project['unPublished']) return undefined;

      const name = str(project['Name']).trim();
      if (blank(name)) return undefined;

      const funding = this.legacySeasonFunding(project, number);
      if (!funding) return undefined;

      const extra = lookup(awards, project['_id']);
      if (extra) {
        funding.match += extra.match;
        funding.prize += extra.prize;
        funding.raised = funding.sales + funding.venus + funding.match + funding.prize;
      }
      if (!(num(funding.raised) > 0)) return undefined;

      const slug = presence(project['Slug']) ?? project['_id'];
      return {
        ...funding,
        name,
        url: this.localProjectPath(slug),
        creator: presence(str(project[LEAD_CREATOR]).trim()),
        logline: presence(project['Logline']),
      };
    });
  }

  private applySeasonNames(drives: Drive[], seasonsMeta: Record<string, Season>): void {
    for (const drive of drives) {
      const meta = lookup(seasonsMeta, drive.season_id);
      if (!rubyTruthy(drive.season_number)) {
        drive.season_number = meta?.number;
      }
      drive.season = rubyOr(meta?.title, rubyTruthy(drive.season_number) ? `Season ${drive.season_number}` : undefined);
    }
  }

  private projectUrl(slugOrId: unknown): string {
    return `${SITE_URL}/index/p/${slugOrId}`;
  }

  private fundUrl(slugOrId: unknown): string {
    return `${SITE_URL}/index/mf/${slugOrId}`;
  }

  private localProjectPath(slugOrId: unknown): string {
    return `/projects/${slugOrId}`;
  }

  private localFundPath(slugOrId: unknown): string {
    return `/funds/${slugOrId}`;
  }

  private mediaUrl(path: unknown): string | undefined {
    if (blank(path)) return undefined;
    const s = str(path);
    return s.startsWith('//') ? `https:${s}` : s;
  }
}
