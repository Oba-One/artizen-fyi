import type { FundRow, Leaderboard } from '../artizen';
import { fmtDate, truncate, usd } from '../format';
import { board, boardEmpty, datatable, dtPlaceholder, escapeHtml, layout, namedLink, pageTitle, panel } from './layout';

export function renderFunds(data: Leaderboard, seasonParam: string | null): string {
  const empty = boardEmpty(data);
  const current = Boolean(data.season?.current);
  let table = '';
  let extra = '';
  if (!empty) {
    const extraHeads = current
      ? '<th class="text-end">Unlocked</th><th class="text-end">Available</th><th class="text-end">Raised</th>'
      : '';
    const funds = [...data.funds].sort((a, b) =>
      current ? (b.available ?? -1) - (a.available ?? -1) : b.season_total - a.season_total,
    );
    const body = funds
      .map((fund: FundRow) => {
        const subtitle = fund.subtitle
          ? `<br><small class="text-muted">${escapeHtml(truncate(fund.subtitle, 90))}</small>`
          : '';
        const inactive = fund.active === false ? '<br><span class="badge text-bg-secondary">Inactive</span>' : '';
        const created = fmtDate(fund.created_at, true);
        const extraCols = current
          ? `<td class="text-end" data-order="${fund.unlocked ?? -1}">${usd(fund.unlocked)}</td>
             <td class="text-end" data-order="${fund.available ?? -1}">${usd(fund.available)}</td>
             <td class="text-end" data-order="${fund.raised ?? -1}">${usd(fund.raised)}</td>`
          : '';
        return `<tr>
          <td><strong>${namedLink(fund.url, fund.name)}</strong>${subtitle}${inactive}</td>
          <td class="text-nowrap" data-order="${escapeHtml(String(fund.created_at ?? ''))}">${escapeHtml(created)}</td>
          <td class="text-end" data-order="${fund.season_total}">${usd(fund.season_total)}</td>
          ${extraCols}
        </tr>`;
      })
      .join('');
    table = panel(`
      ${dtPlaceholder()}
      <table id="artizen-funds-table" class="table table-sm">
        <thead><tr><th>Fund</th><th>Created</th><th class="text-end">Contributions</th>${extraHeads}</tr></thead>
        <tbody>${body}</tbody>
      </table>`);
    extra = current
      ? datatable('artizen-funds-table', [[4, 'desc']], [2, 3, 4, 5], { noun: 'funds' })
      : datatable('artizen-funds-table', [[2, 'desc']], [2], { noun: 'funds' });
  }
  return layout({
    title: pageTitle(data),
    body: board(data, 'funds', seasonParam) + table,
    extra,
    datatables: Boolean(extra),
    season: seasonParam,
    boards: true,
  });
}
