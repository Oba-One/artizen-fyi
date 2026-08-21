import type { Leaderboard } from '../artizen';
import { funding, heatRanks, heatTd, MONEY_COLS, MONEY_INDEXES, RAISED_INDEX, moneyHeaders, truncate } from '../format';
import { board, boardEmpty, datatable, dtPlaceholder, escapeHtml, layout, namedLink, pageTitle, panel } from './layout';

export function renderProjects(data: Leaderboard, seasonParam: string | null): string {
  const empty = boardEmpty(data);
  let table = '';
  let extra = '';
  if (!empty) {
    const rows = data.projects.map(funding).sort((a, b) => (b.raised || 0) - (a.raised || 0));
    const heat = heatRanks(
      rows,
      MONEY_COLS.map((col) => col.field),
    );
    const body = rows
      .map((project, i) => {
        const logline = project.logline
          ? `<br><small class="text-muted">${escapeHtml(truncate(project.logline, 90))}</small>`
          : '';
        const cells = MONEY_COLS.map((col) => {
          const colHeat = heat[String(col.field)];
          return heatTd(project, String(col.field), colHeat.ranks, i, rows.length, col.as, colHeat.maxPct);
        }).join('');
        return `<tr>
          <td><strong>${namedLink(project.url, project.name)}</strong>${logline}</td>
          ${cells}
        </tr>`;
      })
      .join('');
    table = panel(`
      <div class="artizen-note">
        <p>Sales excludes Venus artifact buys.</p>
        <dl class="artizen-defs">
          <div><dt>S+V</dt><dd>Sales + Venus</dd></div>
          <div><dt>S+V+M</dt><dd>S + V + Match</dd></div>
          <div><dt>V2</dt><dd>V + Venus extras</dd></div>
          <div><dt>V2+M+P</dt><dd>V2 + M + Prize</dd></div>
          <div><dt>Raised</dt><dd>S + V2 + M + P</dd></div>
        </dl>
        <p>The % under each figure is that project’s rank in the column — 1% is the top 1%. Color follows that percentile on a log scale: full green at 1%, fading to white at the smallest non-zero value. <span class="text-body">Tables scroll horizontally on small screens.</span></p>
      </div>
      ${dtPlaceholder()}
      <table id="artizen-projects-table" class="table table-sm">
        <thead><tr><th>Project</th>${moneyHeaders('text-end artizen-heat')}</tr></thead>
        <tbody>${body}</tbody>
      </table>`);
    extra = datatable('artizen-projects-table', [[RAISED_INDEX, 'desc']], MONEY_INDEXES, { noun: 'projects' });
  }
  return layout({
    title: pageTitle(data),
    body: board(data, 'projects', seasonParam) + table,
    extra,
    datatables: Boolean(extra),
    season: seasonParam,
    boards: true,
  });
}
