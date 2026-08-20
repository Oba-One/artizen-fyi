import type { Bubble } from './bubble';
import { legacySeasonProjectRows } from './legacy';
import type { BoostHolder, BoostsPage, Drive, FundRow, Leaderboard, PodiumRow, ProjectRow, Row, Season } from './types';
import {
  LEAD_CREATOR,
  bump,
  byId,
  communitySales,
  hidden,
  localFundPath,
  localProjectPath,
  mapSome,
  maybeNum,
  mediaUrl,
  num,
  sortByDesc,
  sum,
  text,
  venusSplit,
} from './util';

const TOP_BOOST_HOLDERS = 100;
const BOOST_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: '0', min: 0, max: 0 },
  { label: '1–99', min: 1, max: 99 },
  { label: '100–999', min: 100, max: 999 },
  { label: '1k–9.9k', min: 1_000, max: 9_999 },
  { label: '10k–99k', min: 10_000, max: 99_999 },
  { label: '100k–999k', min: 100_000, max: 999_999 },
  { label: '1M+', min: 1_000_000, max: Infinity },
];

export async function buildLeaderboard(
  client: Bubble,
  seasonNumber?: string | number | null,
): Promise<Leaderboard> {
  const seasons = await client.fetchSeasons();
  const season = client.pickSeason(seasons, seasonNumber);
  if (!season) return { seasons, season: null, drives: [], projects: [], funds: [], error: true };

  return {
    seasons,
    season,
    drives: await fetchDrives(client, season.id),
    projects: await projectRows(client, season),
    funds: await fundRows(client, season.id, { current: season.current }),
    error: false,
  };
}

export async function buildBoosts(client: Bubble): Promise<BoostsPage> {
  type Candidate = { name: string; image?: string; points: number; admin: boolean };
  const points: number[] = [];
  const candidates: Candidate[] = [];
  const buckets = BOOST_BUCKETS.map((bucket) => ({ label: bucket.label, users: 0, points: 0 }));

  await client.listEach('useraccount', (row) => {
    const value = num(row['points - current']);
    points.push(value);
    const held = value > 0 ? value : 0;
    const bucket = buckets.find((_, i) => value >= BOOST_BUCKETS[i].min && value <= BOOST_BUCKETS[i].max);
    if (bucket) {
      bucket.users += 1;
      bucket.points += held;
    }
    if (!(value > 0)) return;

    candidates.push({
      name: text(row['name']) || unnamedHolder(row['wallet']),
      image: mediaUrl(row['profile image']),
      points: value,
      admin: boostAdmin(row['Role']),
    });
  });

  const remaining = sum(points, (p) => (p > 0 ? p : 0));
  const holders = candidates.length;
  const admin = sum(candidates, (c) => (c.admin ? c.points : 0));
  const sortedHolders = sortByDesc(candidates, (c) => c.points);
  const topRows = sortedHolders.slice(0, TOP_BOOST_HOLDERS);
  const topPoints = sum(topRows, (c) => c.points);
  let running = 0;
  const top = topRows.map((row, i) => {
    running += row.points;
    return {
      rank: i + 1,
      name: row.name,
      image: row.image,
      points: row.points,
      share: remaining > 0 ? row.points / remaining : 0,
      cumulative: remaining > 0 ? running / remaining : 0,
      admin: row.admin,
    } satisfies BoostHolder;
  });

  return {
    remaining,
    accounts: points.length,
    holders,
    zero: points.filter((p) => p === 0).length,
    mean: holders > 0 ? remaining / holders : 0,
    median: median(points),
    admin,
    community: remaining - admin,
    top_points: topPoints,
    top_share: remaining > 0 ? topPoints / remaining : 0,
    updated_at: new Date().toISOString(),
    buckets,
    top,
    error: false,
  };
}

function unnamedHolder(wallet: unknown): string {
  const w = text(wallet) ?? '';
  if (w.length < 10) return 'Unnamed';
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
}

function boostAdmin(role: unknown): boolean {
  const value = (text(role) ?? '').toLowerCase();
  return value.includes('admin') || value === 'scott';
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function projectRows(client: Bubble, season: Season): Promise<ProjectRow[]> {
  const seasonId = season.id;
  const rows = (
    await client.list('projectseason', {
      sortField: 'funding total',
      descending: true,
      constraints: [
        { key: 'season ', constraint_type: 'equals', value: seasonId },
        { key: 'funding total', constraint_type: 'greater than', value: 0 },
      ],
    })
  ).filter((row) => !row['hide from competition']);
  if (rows.length === 0) return legacySeasonProjectRows(client, season);

  const projects = await client.indexed(
    'project',
    rows.map((r) => r['project']),
  );
  const venusByProject = await venusBuysByProject(client, seasonId);
  const prizes = await drivePrizesByProject(client, seasonId);

  return sortByDesc(
    mapSome(rows, (row) => {
      const project = byId(projects, row['project']) || {};
      if (hidden(project)) return undefined;

      const name = text(project['Name'] ?? row['name']);
      if (!name) return undefined;

      const slug = text(project['Slug']) ?? row['project'];
      const split = byId(venusByProject, row['project']) || { venus: 0, sprint: 0 };
      const ledgerPrize = num(row['funding prize funds usd']);
      const prize = Math.max(ledgerPrize, num(byId(prizes, row['project'])));
      return {
        name,
        url: localProjectPath(slug),
        creator: text(project[LEAD_CREATOR] || row['lead creator']),
        logline: text(project['Logline']),
        sales: communitySales(row['funding total sales'], split.venus + split.sprint),
        venus: split.venus,
        match: num(row['funding match']) + num(row['funding boost ']),
        prize,
        sprint: split.sprint,
        raised: num(row['funding total']) + prize - ledgerPrize,
      };
    }),
    (project) => project.raised,
  );
}

async function fetchDrives(client: Bubble, seasonId: string): Promise<Drive[]> {
  const drives = sortByDesc(
    (
      await client.list('boost', {
        constraints: [
          { key: 'season', constraint_type: 'equals', value: seasonId },
          { key: 'Type', constraint_type: 'equals', value: 'Fund drive' },
        ],
      })
    ).map((row) => client.normalizeDrive(row)),
    (drive) => drive.number || 0,
  );
  await attachDrivePodiums(client, drives);
  return drives;
}

async function attachDrivePodiums(client: Bubble, drives: Drive[]): Promise<void> {
  if (drives.length === 0) return;

  const pages = await Promise.all(
    drives.flatMap((drive) => [topBoostParticipants(client, drive.id, 'project'), topBoostParticipants(client, drive.id, 'fund')]),
  );
  const records = pages.flat();
  const catalogs = {
    project: await client.indexed(
      'project',
      records.map((row) => row['project']),
    ),
    fund: await client.indexed(
      'fund',
      records.map((row) => row['fund']),
    ),
  };
  drives.forEach((drive, i) => {
    drive.podium = podiumRows(pages[i * 2], 'project', catalogs.project);
    drive.fund_podium = podiumRows(pages[i * 2 + 1], 'fund', catalogs.fund);
  });
}

function topBoostParticipants(client: Bubble, boostId: string, kind: 'project' | 'fund'): Promise<Row[]> {
  return client.getResults('boostparticipant', {
    limit: 3,
    cursor: 0,
    sort_field: 'boost score',
    descending: true,
    constraints: [
      { key: 'boost', constraint_type: 'equals', value: boostId },
      { key: kind, constraint_type: 'is_not_empty' },
    ],
  });
}

function podiumRows(rows: Row[], kind: 'project' | 'fund', records: Record<string, Row>): PodiumRow[] {
  const field = kind;
  const nameField = kind === 'fund' ? 'name' : 'Name';
  return mapSome(rows, (row) => {
    if (kind === 'fund' && row['project']) return undefined;

    const id = row[field];
    if (!id) return undefined;

    const record = byId(records, id);
    const slug = text(record?.['Slug'] || record?.['slugg']) || id;
    const points = num(row['boost points received']);
    const salesMatch = num(row['sales + match (both)']);
    return {
      name: text(record?.[nameField]) || field[0].toUpperCase() + field.slice(1),
      url: kind === 'fund' ? localFundPath(slug) : localProjectPath(slug),
      sales_match: salesMatch,
      points,
      score: (points * salesMatch) / 100.0,
    };
  }).slice(0, 3);
}

async function fundRows(client: Bubble, seasonId: string, { current = false } = {}): Promise<FundRow[]> {
  const contribs = await client.list('fundcontribution', {
    constraints: [
      { key: 'Season', constraint_type: 'equals', value: seasonId },
      { key: 'confirmed', constraint_type: 'equals', value: true },
    ],
  });

  const totals: Record<string, number> = {};
  const lastAt: Record<string, unknown> = {};
  for (const contrib of contribs) {
    const id = contrib['Fund'];
    if (!id) continue;

    const key = String(id);
    bump(totals, key, num(contrib['amount $USD']));
    const created = contrib['Created Date'];
    if (created && (lastAt[key] == null || created > (lastAt[key] as string))) lastAt[key] = created;
  }

  const funds = await client.fetchByIds('fund', Object.keys(totals));
  const unlocked = current ? await fundUnlocked(client, Object.keys(totals)) : {};
  const exts = await client.indexed(
    'fundextendedinfo',
    funds.map((fund) => fund['Extended info']),
  );
  const ranked = mapSome(funds, (fund) => {
    const id = String(fund['_id'] ?? '');
    const seasonTotal = num(totals[id]);
    if (!(seasonTotal > 0)) return undefined;

    const slug = text(fund['Slug']) ?? id;
    const ext = byId(exts, fund['Extended info']);
    const row: FundRow = {
      name: text(fund['name']) ?? '',
      subtitle: text(ext?.['subtitle']),
      url: localFundPath(slug),
      season_total: seasonTotal,
      last_contribution: lastAt[id],
      active: fund['active'],
    };
    if (current) {
      row.unlocked = num(unlocked[id]);
      row.available = maybeNum(fund['Funding - current']);
      row.raised = num(row.available) + row.unlocked;
    }
    return row;
  });
  return ranked.sort((a, b) => {
    if (current) return num(b.raised) - num(a.raised);
    return b.season_total - a.season_total;
  });
}

async function fundUnlocked(client: Bubble, fundIds: unknown[]): Promise<Record<string, number>> {
  const unlocked: Record<string, number> = {};
  const slices = await client.listWhereIn('projectfundboostslice', 'fund', fundIds, [
    { key: 'match unlocked', constraint_type: 'greater than', value: 0 },
  ]);
  for (const slice of slices) {
    bump(unlocked, String(slice['fund'] ?? ''), num(slice['match unlocked']));
  }
  for (const row of await client.listFundAwards(fundIds)) {
    bump(unlocked, String(row['Fund'] ?? ''), num(row['$ amount raised']));
  }
  return unlocked;
}

async function venusBuysByProject(
  client: Bubble,
  seasonId: string,
): Promise<Record<string, { venus: number; sprint: number }>> {
  const sums: Record<string, { venus: number; sprint: number }> = {};
  for (const tx of await client.venusTransactions({ seasonId })) {
    const pid = tx['project'];
    if (!pid) continue;

    const key = String(pid);
    const split = venusSplit(tx);
    const bucket = (sums[key] ||= { venus: 0, sprint: 0 });
    bucket.venus += split.venus;
    bucket.sprint += split.sprint;
  }
  return sums;
}

async function drivePrizesByProject(client: Bubble, seasonId: string): Promise<Record<string, number>> {
  const sums: Record<string, number> = {};
  const parts = await client.list('boostparticipant', {
    constraints: [
      { key: 'season', constraint_type: 'equals', value: seasonId },
      { key: 'prize earned usd', constraint_type: 'greater than', value: 0 },
    ],
  });
  for (const part of parts) {
    const pid = part['project'];
    if (!pid) continue;

    const key = String(pid);
    bump(sums, key, num(part['prize earned usd']));
  }
  return sums;
}
