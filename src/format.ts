import type { ProjectRow } from './artizen';

export type Funded = ProjectRow & {
  vmp: number;
  multiple_v?: number;
  multiple_ex?: number;
  multiple?: number;
};

export function usd(value?: number | null): string {
  if (value == null || Number.isNaN(Number(value))) return '';
  const n = Number(value);
  const precision = Math.abs(n) >= 100 ? 0 : 2;
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
  if (a >= 1_000_000) {
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
  const vmp = venus + match + prize;
  return {
    ...row,
    sales,
    venus,
    match,
    prize,
    vmp,
    multiple_v: sales > 0 ? venus / sales : undefined,
    multiple_ex: sales > 0 ? (venus + match) / sales : undefined,
    multiple: sales > 0 ? vmp / sales : undefined,
    raised: row.raised == null ? sales + vmp : Number(row.raised) || 0,
  };
}

export function multipleLabel(multiple?: number): string {
  return multiple == null ? '' : `${multiple.toFixed(1)}x`;
}

export function moneyCells(
  row: {
    sales?: number | null;
    venus?: number | null;
    match?: number | null;
    prize?: number | null;
    raised?: number | null;
  },
  tag = 'td',
): string {
  const f = funding({
    name: '',
    url: '',
    sales: row.sales ?? 0,
    venus: row.venus ?? 0,
    match: row.match ?? 0,
    prize: row.prize ?? 0,
    raised: row.raised ?? 0,
  });
  const cells = [
    usd(f.sales),
    usd(f.venus),
    usd(f.match),
    usd(f.prize),
    usd(f.vmp),
    multipleLabel(f.multiple_v),
    multipleLabel(f.multiple_ex),
    multipleLabel(f.multiple),
    usd(f.raised),
  ];
  return cells.map((content) => `<${tag} class="text-right">${content}</${tag}>`).join('');
}

export function heatRanks<T extends Record<string, unknown>>(rows: T[], fields: (keyof T)[]): Record<string, number[]> {
  const heat: Record<string, number[]> = {};
  for (const field of fields) {
    const pairs = rows.map((row, i) => [i, Number(row[field]) || 0] as const);
    pairs.sort((a, b) => b[1] - a[1]);
    const ranks: number[] = new Array(rows.length);
    let lastVal: number | null = null;
    let lastRank = 0;
    pairs.forEach(([i, val], order) => {
      if (val !== lastVal) {
        lastRank = order + 1;
        lastVal = val;
      }
      ranks[i] = lastRank;
    });
    heat[String(field)] = ranks;
  }
  return heat;
}

export function rankPct(rank: number | undefined, total: number): number | undefined {
  if (!rank || total <= 0) return undefined;
  return Math.max(Math.ceil((rank / total) * 100), 1);
}

export function rankStyle(pct?: number): string {
  if (pct == null || pct <= 1) return 'background-color: #2DB963';
  const t = Math.log(pct) / Math.log(100);
  const r = Math.round(45 + (255 - 45) * t);
  const g = Math.round(185 + (255 - 185) * t);
  const b = Math.round(99 + (255 - 99) * t);
  return `background-color: rgb(${r},${g},${b})`;
}

export function heatTd(
  row: Record<string, unknown>,
  field: string,
  ranks: number[],
  index: number,
  total: number,
  as: 'usd' | 'x',
): string {
  const value = Number(row[field]) || 0;
  const pct = rankPct(ranks[index], total);
  const label = as === 'x' ? multipleLabel(row[field] as number | undefined) : usd(value);
  const note = pct != null ? `<br><small class="artizen-rank">${pct}%</small>` : '';
  return `<td class="text-right artizen-heat" data-order="${value}" style="${rankStyle(pct)}">${label}${note}</td>`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(value: unknown, withYear = false): string {
  if (value == null || value === '') return '';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return '';
  const day = String(d.getUTCDate()).padStart(2, '0');
  const mon = MONTHS[d.getUTCMonth()];
  return withYear ? `${day} ${mon} ${d.getUTCFullYear()}` : `${day} ${mon}`;
}
