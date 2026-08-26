import type { Drive, Row } from './types';

export const SITE_URL = 'https://artizen.fund';
export const LEAD_CREATOR = 'Lead Creator\t(text)';

export function num(value: unknown): number {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const n = parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

/** First non-empty field; keys match after trim so Bubble trailing spaces still hit. */
export function field(row: Row, ...keys: string[]): unknown {
  const wanted = new Set(keys.flatMap((key) => [key, key.trim()]));
  for (const [key, value] of Object.entries(row)) {
    if (!wanted.has(key) && !wanted.has(key.trim())) continue;
    if (value == null || value === false || value === '') continue;
    return value;
  }
  return undefined;
}

export function maybeNum(value: unknown): number | undefined {
  return value == null ? undefined : num(value);
}

export function int(value: unknown): number {
  return Math.trunc(num(value));
}

export function text(value: unknown): string | undefined {
  if (value == null || value === false) return undefined;
  const s = String(value).trim();
  return s || undefined;
}

export function ids(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (value == null || value === false || value === '') continue;
    const id = String(value);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function byId<T>(rec: Record<string, T>, id: unknown): T | undefined {
  return id == null ? undefined : rec[String(id)];
}

export function sum<T>(items: T[], fn: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += fn(item);
  return total;
}

export function bump(rec: Record<string, number>, key: string, amount: number): void {
  rec[key] = (rec[key] || 0) + amount;
}

export function groupBy<T>(items: T[], keyFn: (item: T) => unknown): Array<[unknown, T[]]> {
  const order: string[] = [];
  const orig = new Map<string, unknown>();
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const sk = key == null ? '\0null\0' : typeof key === 'object' ? JSON.stringify(key) : `${typeof key}:${String(key)}`;
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

export function mapSome<T, U>(items: T[], fn: (item: T) => U | null | undefined): U[] {
  const out: U[] = [];
  for (const item of items) {
    const value = fn(item);
    if (value != null) out.push(value);
  }
  return out;
}

export function sortByDesc<T>(items: T[], ...fns: Array<(item: T) => number>): T[] {
  return items.sort((a, b) => {
    for (const fn of fns) {
      const d = fn(b) - fn(a);
      if (d) return d;
    }
    return 0;
  });
}

export function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function failed(value: unknown): boolean {
  return typeof value === 'object' && value != null && Boolean((value as { error?: unknown }).error);
}

export function hidden(row?: Row | null): boolean {
  return Boolean(row?.['Hide'] || row?.['unPublished']);
}

export const BONUS_POWER = 0.2;

export function bonusWeight(points: number): number {
  return points > 0 ? points ** BONUS_POWER : 0;
}

export function bonusShare(points: number, weightSum: number, pot: number): number {
  if (!(weightSum > 0) || !(pot > 0)) return 0;
  return (bonusWeight(points) / weightSum) * pot;
}

export function bonusWeightSum(rows: Row[]): number {
  return sum(rows, (row) => bonusWeight(num(row['boost points received'])));
}

export function leftoverMatch(rows: Row[]): number {
  return sum(rows, (r) => num(r['match cap $']) - num(r['match unlocked']));
}

export function communitySales(gross: unknown, venus: unknown): number {
  const sales = num(gross) - num(venus);
  return sales > 0 ? sales : 0.0;
}

export function seasonFunding(
  row: Row,
  split: { venus?: number; sprint?: number } = {},
  extraPrize?: number,
  extraBonus?: number,
) {
  const venus = num(split.venus);
  const sprint = num(split.sprint);
  const sales = communitySales(row['funding total sales'], venus + sprint);
  const match = num(row['funding match']) + num(row['funding boost ']);
  const prize = Math.max(
    num(row['funding prize funds usd']),
    num(extraPrize),
    num(row['old funding prize leaderboard  (usd)']),
  );
  const bonus = num(extraBonus);
  return {
    sales,
    venus,
    sprint,
    match,
    prize,
    bonus,
    raised: sales + venus + sprint + match + prize + bonus,
  };
}

export function driveHasBonusPot(drive: Drive): boolean {
  return num(drive.bonus_projects) > 0 || num(drive.bonus_funds) > 0;
}

export function driveContext(drive?: Drive) {
  return {
    drive: drive && drive.name,
    drive_active: drive && drive.active,
    drive_number: drive && drive.number,
    drive_multiple: drive && drive.multiple,
    season: drive && drive.season,
    season_number: drive && drive.season_number,
  };
}

export function projectUrl(slugOrId: unknown): string {
  return `${SITE_URL}/index/p/${slugOrId}`;
}

export function fundUrl(slugOrId: unknown): string {
  return `${SITE_URL}/index/mf/${slugOrId}`;
}

export function localProjectPath(slugOrId: unknown): string {
  return `/projects/${slugOrId}`;
}

export function localFundPath(slugOrId: unknown): string {
  return `/funds/${slugOrId}`;
}

export function mediaUrl(path: unknown): string | undefined {
  if (path == null || path === false || path === '') return undefined;
  if (typeof path === 'object' && !Array.isArray(path)) {
    const rec = path as Record<string, unknown>;
    return mediaUrl(rec.url ?? rec.src);
  }
  const s = String(path).trim();
  if (!s || s === '[object Object]') return undefined;
  return s.startsWith('//') ? `https:${s}` : s;
}

export function firstMedia(...paths: unknown[]): string | undefined {
  for (const path of paths) {
    const url = mediaUrl(path);
    if (url) return url;
  }
  return undefined;
}

export function parseTime(value: unknown): Date | undefined {
  if (value == null || value === false || value === '') return undefined;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

// Admin "Sales no" checkouts are sprint prizes, not drive sales / Venus sparkle.
export function venusSplit(tx: Row): { venus: number; sprint: number } {
  const amount = num(tx['amount spent $USD']);
  if (/sales no/i.test(String(tx['admin checkout type'] ?? ''))) return { venus: 0, sprint: amount };
  return { venus: amount, sprint: 0 };
}

export function assignVenusDrive(tx: Row, drives: Drive[]): Drive | undefined {
  const created = parseTime(tx['Created Date']);
  if (!created) return undefined;

  let candidates = drives.filter((drive) => drive.season_id == tx['Season']);
  if (candidates.length === 0) candidates = drives;

  const inWindow = candidates.filter((drive) => {
    const start = parseTime(drive.start);
    const finish = parseTime(drive.end);
    if (!start) return false;
    return created >= start && (finish == null || created <= finish);
  });
  if (inWindow.length > 0) return latestStart(inWindow);

  // Ended drives freeze `fund drive sales`. A later Venus buy is not in that
  // number, so peeling it there zeros Sales. Put it on a drive still open.
  const open = candidates.filter((drive) => {
    const finish = parseTime(drive.end);
    return finish == null || created <= finish;
  });
  const pool = open.length > 0 ? open : candidates;
  return pool.find((drive) => drive.active) ?? latestStart(pool);
}

function latestStart(drives: Drive[]): Drive | undefined {
  if (drives.length === 0) return undefined;
  return drives.reduce((best, drive) => {
    const a = parseTime(drive.start)?.getTime() ?? 0;
    const b = parseTime(best.start)?.getTime() ?? 0;
    return a > b ? drive : best;
  });
}
