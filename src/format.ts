import type { ProjectRow } from './artizen';

export type Funded = ProjectRow & {
  sv: number;
  svm: number;
  v2: number;
  vmp: number;
  multiple_v?: number;
  multiple_m?: number;
  multiple_p?: number;
  multiple_b?: number;
};

export function usd(value?: number | null): string {
  if (value == null || Number.isNaN(Number(value))) return '';
  const n = Number(value);
  const precision = Math.abs(n) >= 100 ? 0 : 2;
  if (Math.abs(n) < 0.5 / 10 ** precision) return '';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).format(n);
}

export function compactNum(value?: number | null): string {
  if (value == null || Number.isNaN(Number(value))) return '';
  const n = Number(value);
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  let suffix = '';
  let div = 1;
  if (a >= 1_000_000_000) {
    suffix = 'b';
    div = 1_000_000_000;
  } else if (a >= 1_000_000) {
    suffix = 'm';
    div = 1_000_000;
  } else if (a >= 1_000) {
    suffix = 'k';
    div = 1_000;
  } else {
    return `${sign}${Math.round(a)}`;
  }
  const scaled = a / div;
  const text = scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, '');
  return `${sign}${text}${suffix}`;
}

export function delimited(value?: number | null): string {
  if (value == null || Number.isNaN(Number(value))) return '';
  return Math.round(Number(value)).toLocaleString('en-US');
}

export function truncate(text: string, length: number): string {
  if (text.length <= length) return text;
  return `${text.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

export function funding(row: ProjectRow): Funded {
  const sales = Number(row.sales) || 0;
  const venus = Number(row.venus) || 0;
  const match = Number(row.match) || 0;
  const prize = Number(row.prize) || 0;
  const bonus = Number(row.bonus) || 0;
  const sprint = Number(row.sprint) || 0;
  const sv = sales + venus;
  const svm = sv + match;
  const v2 = venus + sprint;
  const vmp = v2 + match + prize + bonus;
  return {
    ...row,
    sales,
    venus,
    match,
    prize,
    bonus,
    sprint,
    sv,
    svm,
    v2,
    vmp,
    multiple_v: sales !== 0 ? v2 / sales : undefined,
    multiple_m: sales !== 0 ? match / sales : undefined,
    multiple_p: sales !== 0 ? prize / sales : undefined,
    multiple_b: sales !== 0 ? bonus / sales : undefined,
    raised: row.raised == null ? sales + vmp : Number(row.raised) || 0,
  };
}

function multipleLabel(multiple?: number): string {
  if (multiple == null || multiple === 0) return '';
  const text = multiple.toFixed(1);
  if (text === '0.0' || text === '-0.0') return '';
  return `${text}x`;
}

export type MoneyFormat = 'usd' | 'x';

type MoneyCol = {
  field: keyof Funded;
  label: string;
  as: MoneyFormat;
};

const MONEY_COLS: readonly MoneyCol[] = [
  { field: 'sales', label: 'Sales', as: 'usd' },
  { field: 'venus', label: 'Venus sales', as: 'usd' },
  { field: 'sv', label: 'S+VS', as: 'usd' },
  { field: 'match', label: 'Match', as: 'usd' },
  { field: 'svm', label: 'S+VS+M', as: 'usd' },
  { field: 'sprint', label: 'Venus extras', as: 'usd' },
  { field: 'prize', label: 'Prize', as: 'usd' },
  { field: 'bonus', label: 'Bonus', as: 'usd' },
  { field: 'multiple_v', label: 'V/S', as: 'x' },
  { field: 'multiple_m', label: 'M/S', as: 'x' },
  { field: 'multiple_p', label: 'P/S', as: 'x' },
  { field: 'multiple_b', label: 'B/S', as: 'x' },
  { field: 'raised', label: 'Raised', as: 'usd' },
];

export function moneyColumns(includeBonus = false): MoneyCol[] {
  return MONEY_COLS.flatMap((col) => {
    if (col.field === 'bonus' || col.field === 'multiple_b') return includeBonus ? [col] : [];
    return [col];
  });
}

type MoneyRow = {
  sales?: number | null;
  venus?: number | null;
  match?: number | null;
  prize?: number | null;
  bonus?: number | null;
  sprint?: number | null;
  raised?: number | null;
};

function funded(row: MoneyRow): Funded {
  return funding({
    name: '',
    url: '',
    sales: row.sales ?? 0,
    venus: row.venus ?? 0,
    match: row.match ?? 0,
    prize: row.prize ?? 0,
    bonus: row.bonus ?? 0,
    sprint: row.sprint ?? 0,
    raised: row.raised ?? 0,
  });
}

function endCell(content: string, tag: string): string {
  return `<${tag} class="text-end">${content}</${tag}>`;
}

function projectedLabel(label: string, title = 'Projected prize — not yet earned'): string {
  if (!label) return label;
  return `<span class="artizen-prize-projected" data-bs-toggle="tooltip" data-bs-container="body" data-bs-title="${title}" tabindex="0">${label}</span>`;
}

export function prizeLabel(value?: number | null, projected = false): string {
  const label = usd(value);
  return projected ? projectedLabel(label) : label;
}

function moneyLabel(row: Funded, col: MoneyCol): string {
  if (col.as === 'x') return multipleLabel(row[col.field] as number | undefined);
  return usd(row[col.field] as number);
}

export function moneyHeaders(className = 'text-end', cols: readonly MoneyCol[] = moneyColumns()): string {
  return cols.map((col) => `<th class="${className}">${col.label}</th>`).join('');
}

export function moneyCells(row: MoneyRow, tag = 'td', cols: readonly MoneyCol[] = moneyColumns()): string {
  const f = funded(row);
  return cols.map((col) => endCell(moneyLabel(f, col), tag)).join('');
}

export function heatRanks<T extends Record<string, unknown>>(
  rows: T[],
  fields: (keyof T)[],
  eligible?: (row: T, index: number) => boolean,
): Record<string, { ranks: (number | undefined)[]; maxRank: number }> {
  const heat: Record<string, { ranks: (number | undefined)[]; maxRank: number }> = {};
  const inPlay = rows.map((row, i) => !eligible || eligible(row, i));
  for (const field of fields) {
    const pairs = rows
      .map((row, i) => [i, Number(row[field]) || 0] as const)
      .filter(([i]) => inPlay[i]);
    pairs.sort((a, b) => b[1] - a[1]);
    const ranks: (number | undefined)[] = new Array(rows.length);
    let lastVal: number | null = null;
    let lastRank = 0;
    let maxNonZeroRank = 0;
    pairs.forEach(([i, val], order) => {
      if (val !== lastVal) {
        lastRank = order + 1;
        lastVal = val;
      }
      ranks[i] = lastRank;
      if (val > 0) maxNonZeroRank = lastRank;
    });
    heat[String(field)] = {
      ranks,
      maxRank: maxNonZeroRank || 1,
    };
  }
  return heat;
}

export function rankStyle(rank?: number, maxRank = 100, minRank = 1): string {
  if (rank == null) return 'background-color: #1ACC6C';
  const lo = Math.max(minRank, 1);
  const hi = Math.max(maxRank, rank, lo);
  if (rank <= lo || hi <= lo) return 'background-color: #1ACC6C';
  const t = Math.min((Math.log(rank) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)), 1);
  const r = Math.round(26 + (255 - 26) * t);
  const g = Math.round(204 + (255 - 204) * t);
  const b = Math.round(108 + (255 - 108) * t);
  return `background-color: rgb(${r},${g},${b})`;
}

export function heatTd(
  row: Record<string, unknown>,
  field: string,
  ranks: (number | undefined)[],
  index: number,
  as: 'usd' | 'x',
  maxRank = 100,
): string {
  const value = Number(row[field]) || 0;
  const rank = ranks[index];
  const label = as === 'x' ? multipleLabel(row[field] as number | undefined) : usd(value);
  const note = label && rank != null ? `<br><small class="artizen-rank">${rank}</small>` : '';
  const heat = label && rank != null ? rankStyle(rank, maxRank) : 'background-color: #fff';
  return `<td class="text-end artizen-heat" data-order="${value}" style="${heat}">${label}${note}</td>`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(value: unknown, withYear = false): string {
  if (value == null || value === '') return '';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return '';
  const day = String(d.getUTCDate());
  const mon = MONTHS[d.getUTCMonth()];
  return withYear ? `${day} ${mon} ${d.getUTCFullYear()}` : `${day} ${mon}`;
}
