import type { Bubble } from './bubble';
import { legacySeasonProjectRows } from './legacy';
import type {
  BonusChart,
  BonusShareRow,
  BoostHolder,
  BoostsPage,
  Drive,
  FundRow,
  Leaderboard,
  PodiumRow,
  ProjectRow,
  Row,
  Season,
} from './types';
import {
  LEAD_CREATOR,
  bonusShare,
  bonusWeightSum,
  bump,
  byId,
  driveHasBonusPot,
  field,
  hidden,
  ids,
  localFundPath,
  localProjectPath,
  mapSome,
  maybeNum,
  mediaUrl,
  num,
  seasonFunding,
  sortByDesc,
  sum,
  text,
  venusSplit,
} from './util';

const TOP_BOOST_HOLDERS = 100;
const BONUS_CHART_POINTS = 10;
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

  const { drives, bonuses } = await fetchDrives(client, season.id);
  const [projects, funds] = await Promise.all([
    projectRows(client, season, bonuses),
    fundRows(client, season.id, { current: season.current }),
  ]);
  return { seasons, season, drives, projects, funds, error: false };
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

async function projectRows(client: Bubble, season: Season, bonuses: Record<string, number>): Promise<ProjectRow[]> {
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
      const funding = seasonFunding(
        row,
        byId(venusByProject, row['project']),
        byId(prizes, row['project']),
        byId(bonuses, row['project']),
      );
      return {
        name,
        url: localProjectPath(slug),
        creator: text(project[LEAD_CREATOR] || row['lead creator']),
        logline: text(project['Logline']),
        ...funding,
      };
    }),
    (project) => project.raised,
  );
}

async function fetchDrives(client: Bubble, seasonId: string): Promise<{ drives: Drive[]; bonuses: Record<string, number> }> {
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
  return { drives, bonuses: await attachDrivePodiums(client, drives) };
}

async function attachDrivePodiums(client: Bubble, drives: Drive[]): Promise<Record<string, number>> {
  if (drives.length === 0) return {};

  const [pages, bonusParts] = await Promise.all([
    Promise.all(
      drives.flatMap((drive) => {
        const rankField = driveHasBonusPot(drive) ? 'sales + match' : 'boost score';
        return [topBoostParticipants(client, drive.id, 'project', rankField), topBoostParticipants(client, drive.id, 'fund', rankField)];
      }),
    ),
    Promise.all(
      drives.map(async (drive) => {
        if (!driveHasBonusPot(drive)) return { project: [] as Row[], fund: [] as Row[] };
        const [project, fund] = await Promise.all([
          client.driveBonusParticipants(drive.id, 'project'),
          client.driveBonusParticipants(drive.id, 'fund'),
        ]);
        return { project, fund };
      }),
    ),
  ]);
  const weights = bonusParts.map((parts) => ({
    project: bonusWeightSum(parts.project),
    fund: bonusWeightSum(parts.fund),
  }));
  const chartParts = bonusParts.map((parts) => ({
    project: sortByDesc([...parts.project], (row) => num(row['boost points received'])).slice(0, BONUS_CHART_POINTS),
    fund: sortByDesc([...parts.fund], (row) => num(row['boost points received'])).slice(0, BONUS_CHART_POINTS),
  }));
  const records = pages.flat();
  const [projectCatalog, fundCatalog] = await Promise.all([
    client.indexed(
      'project',
      ids([...records, ...chartParts.flatMap((p) => p.project)].map((row) => row['project'])),
    ),
    client.indexed(
      'fund',
      ids([...records, ...chartParts.flatMap((p) => p.fund)].map((row) => row['fund'])),
    ),
  ]);
  const catalogs = { project: projectCatalog, fund: fundCatalog };
  drives.forEach((drive, i) => {
    const salesRank = driveHasBonusPot(drive);
    drive.podium = podiumRows(pages[i * 2], 'project', catalogs.project, salesRank, num(drive.bonus_projects), weights[i].project);
    drive.fund_podium = podiumRows(pages[i * 2 + 1], 'fund', catalogs.fund, salesRank, num(drive.bonus_funds), weights[i].fund);
    const projectShares = bonusShareRows(
      chartParts[i].project,
      'project',
      catalogs.project,
      num(drive.bonus_projects),
      weights[i].project,
    );
    const fundShares = bonusShareRows(
      chartParts[i].fund,
      'fund',
      catalogs.fund,
      num(drive.bonus_funds),
      weights[i].fund,
    );
    drive.bonus_chart = bonusChart('project', num(drive.bonus_projects), weights[i].project, projectShares)
      ?? bonusChart('fund', num(drive.bonus_funds), weights[i].fund, fundShares);
  });

  const bonuses: Record<string, number> = {};
  drives.forEach((drive, i) => {
    if (drive.active) return;
    const weightSum = weights[i].project;
    const pot = num(drive.bonus_projects);
    if (!(weightSum > 0) || !(pot > 0)) return;
    for (const row of bonusParts[i].project) {
      const pid = row['project'];
      if (!pid) continue;
      bump(bonuses, String(pid), bonusShare(num(row['boost points received']), weightSum, pot));
    }
  });
  return bonuses;
}

function topBoostParticipants(
  client: Bubble,
  boostId: string,
  kind: 'project' | 'fund',
  sortField: string,
): Promise<Row[]> {
  return client.getResults('boostparticipant', {
    limit: sortField === 'sales + match' ? 8 : 3,
    cursor: 0,
    sort_field: sortField,
    descending: true,
    constraints: [
      { key: 'boost', constraint_type: 'equals', value: boostId },
      { key: kind, constraint_type: 'is_not_empty' },
    ],
  });
}

function bonusChart(
  kind: 'project' | 'fund',
  pot: number,
  weightSum: number,
  shares: BonusShareRow[],
): BonusChart | undefined {
  if (shares.length === 0 || !(pot > 0) || !(weightSum > 0)) return undefined;
  return { kind, pot, weight_sum: weightSum, shares };
}

function bonusShareRows(
  rows: Row[],
  kind: 'project' | 'fund',
  records: Record<string, Row>,
  pot: number,
  weightSum: number,
): BonusShareRow[] {
  if (!(weightSum > 0) || !(pot > 0)) return [];
  const nameField = kind === 'fund' ? 'name' : 'Name';
  return mapSome(rows, (row) => {
    if (kind === 'fund' && row['project']) return undefined;
    const id = row[kind];
    if (!id) return undefined;
    const record = byId(records, id);
    if (hidden(record)) return undefined;
    const points = num(row['boost points received']);
    if (!(points > 0)) return undefined;
    const slug = text(record?.['Slug'] || record?.['slugg']) || id;
    return {
      name: text(record?.[nameField]) || kind[0].toUpperCase() + kind.slice(1),
      url: kind === 'fund' ? localFundPath(slug) : localProjectPath(slug),
      points,
      bonus: bonusShare(points, weightSum, pot),
    };
  });
}

function podiumRows(
  rows: Row[],
  kind: 'project' | 'fund',
  records: Record<string, Row>,
  salesRank = false,
  pot = 0,
  weightSum = 0,
): PodiumRow[] {
  const nameField = kind === 'fund' ? 'name' : 'Name';
  const mapped = mapSome(rows, (row) => {
    if (kind === 'fund' && row['project']) return undefined;

    const id = row[kind];
    if (!id) return undefined;

    const record = byId(records, id);
    const slug = text(record?.['Slug'] || record?.['slugg']) || id;
    const points = num(row['boost points received']);
    const salesMatch = num(field(row, 'sales + match', 'sales + match (both)'));
    return {
      name: text(record?.[nameField]) || kind[0].toUpperCase() + kind.slice(1),
      url: kind === 'fund' ? localFundPath(slug) : localProjectPath(slug),
      sales_match: salesMatch,
      points,
      score: (points * salesMatch) / 100.0,
      bonus: salesRank && weightSum > 0 ? bonusShare(points, weightSum, pot) : undefined,
    };
  });
  if (salesRank) sortByDesc(mapped, (row) => row.sales_match, (row) => row.points);
  return mapped.slice(0, 3);
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
      created_at: fund['Created Date'],
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
