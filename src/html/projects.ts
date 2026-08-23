import type { Leaderboard } from '../artizen';
import { funding, heatRanks, heatTd, moneyColumns, moneyHeaders, truncate } from '../format';
import { board, boardEmpty, datatable, dtPlaceholder, escapeHtml, layout, namedLink, pageTitle, panel } from './layout';

export function renderProjects(data: Leaderboard, seasonParam: string | null): string {
  const empty = boardEmpty(data);
  let table = '';
  let extra = '';
  if (!empty) {
    const rows = data.projects.map(funding).sort((a, b) => (b.raised || 0) - (a.raised || 0));
    const includeBonus = rows.some((row) => Number(row.bonus) > 0);
    const cols = moneyColumns(includeBonus);
    const heat = heatRanks(
      rows,
      cols.map((col) => col.field),
      (_row, i) => i < 100,
    );
    const body = rows
      .map((project, i) => {
        const logline = project.logline
          ? `<br><small class="text-muted">${escapeHtml(truncate(project.logline, 90))}</small>`
          : '';
        const cells = cols
          .map((col) => {
            const colHeat = heat[String(col.field)];
            return heatTd(project, String(col.field), colHeat.ranks, i, col.as, colHeat.maxRank);
          })
          .join('');
        return `<tr${i < 100 ? ' data-top="1"' : ''}>
          <td><strong>${namedLink(project.url, project.name)}</strong>${logline}</td>
          ${cells}
        </tr>`;
      })
      .join('');
    const raisedIndex = cols.findIndex((col) => col.field === 'raised') + 1;
    const moneyIndexes = cols.map((_, i) => i + 1);
    table = panel(`
      <div class="artizen-note">
        <p>Sales excludes Venus artifact buys.</p>
        <dl class="artizen-defs">
          <div><dt>S+VS</dt><dd>Sales + Venus sales</dd></div>
          <div><dt>S+VS+M</dt><dd>S + VS + Match</dd></div>
          <div><dt>V</dt><dd>VS + Venus extras</dd></div>
          <div><dt>Raised</dt><dd>S + V + M + P${includeBonus ? ' + B' : ''}</dd></div>
        </dl>
        <p>The number under each figure is that project’s rank in the column among the 100 that raised the most. Color follows that rank on a log scale: full green at 1, fading to white at the smallest non-zero value. <span class="text-body">Tables scroll horizontally on small screens.</span></p>
      </div>
      ${dtPlaceholder()}
      <table id="artizen-projects-table" class="table table-sm">
        <thead><tr><th>Project</th>${moneyHeaders('text-end artizen-heat', cols)}</tr></thead>
        <tbody>${body}</tbody>
      </table>`);
    extra = datatable('artizen-projects-table', [[raisedIndex, 'desc']], moneyIndexes, { noun: 'projects', topFilter: 100 });
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
