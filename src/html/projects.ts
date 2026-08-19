import type { Leaderboard } from '../artizen';
import { funding, heatRanks, heatTd, truncate } from '../format';
import { board, datatable, escapeHtml, layout } from './layout';

export function renderProjects(data: Leaderboard, seasonParam: string | null): string {
  const cols: Array<[keyof ReturnType<typeof funding>, string, 'usd' | 'x']> = [
    ['sales', 'Sales', 'usd'],
    ['venus', 'Venus', 'usd'],
    ['match', 'Match', 'usd'],
    ['prize', 'Prize', 'usd'],
    ['vmp', 'V+M+P', 'usd'],
    ['multiple_v', 'V/S', 'x'],
    ['multiple_ex', '(V+M)/S', 'x'],
    ['multiple', '(V+M+P)/S', 'x'],
    ['raised', 'Raised', 'usd'],
  ];
  const empty = data.error && data.projects.length === 0 && data.funds.length === 0;
  let table = '';
  let extra = '';
  if (!empty) {
    const rows = data.projects.map(funding);
    const heat = heatRanks(
      rows,
      cols.map(([f]) => f),
    );
    const head = cols.map(([, label]) => `<th class="text-end artizen-heat">${label}</th>`).join('');
    const body = rows
      .map((project, i) => {
        const logline = project.logline
          ? `<br><small class="text-muted">${escapeHtml(truncate(project.logline, 90))}</small>`
          : '';
        const cells = cols
          .map(([field, , as]) => heatTd(project, String(field), heat[String(field)], i, rows.length, as))
          .join('');
        return `<tr>
          <td><strong><a href="${escapeHtml(project.url)}" class="text-dark">${escapeHtml(project.name)}</a></strong>${logline}</td>
          ${cells}
        </tr>`;
      })
      .join('');
    table = `
      <p class="text-muted small mb-2">
        Project raised = sales + Venus + match + prize. Sales excludes Venus artifact buys. V+M+P = Venus + match + prize.
        The % under each figure is that project's rank in the column — 1% is the top 1%.
        Color follows that percentile on a log scale: full green at 1%, fading to white at 100%.
      </p>
      <table id="artizen-projects-table" class="table table-sm">
        <thead><tr><th>Project</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>`;
    extra = datatable('artizen-projects-table', [[9, 'desc']], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  }
  const title = data.season ? `Artizen · ${data.season.title}` : 'Artizen';
  return layout({
    title,
    body: board(data, 'projects', seasonParam) + table,
    extra,
    datatables: Boolean(extra),
  });
}
