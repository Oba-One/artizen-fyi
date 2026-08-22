import { driveHasBonusPot, type Drive, type Leaderboard, type PodiumRow } from '../artizen';
import { compactNum, delimited, fmtDate, prizeLabel, truncate, usd } from '../format';
import { board, boardEmpty, escapeHtml, layout, namedLink, pageTitle, panel } from './layout';

export function renderDrives(data: Leaderboard, seasonParam: string | null): string {
  const empty = boardEmpty(data);
  let body = '';
  if (!empty) {
    body =
      data.drives.length === 0
        ? panel('<p class="text-muted mb-0">No fund drives in this season.</p>')
        : `<div class="row">${data.drives.map((drive) => driveCard(drive)).join('')}</div>`;
  }
  return layout({
    title: pageTitle(data),
    body: board(data, 'drives', seasonParam) + body,
    season: seasonParam,
    boards: true,
  });
}

function driveCard(drive: Drive): string {
  const img = drive.image
    ? `<img class="artizen-drive-thumb card-img-top" src="${escapeHtml(drive.image)}" alt="" loading="lazy">`
    : '';
  const multiple = drive.multiple
    ? `<span class="badge text-bg-primary artizen-badge-sm">${Math.trunc(Number(drive.multiple))}x</span>`
    : '';
  const status = drive.active
    ? '<span class="badge text-bg-primary">Active</span>'
    : `<span class="badge text-bg-secondary">${escapeHtml(drive.status)}</span>`;
  const desc = drive.description
    ? `<p class="small text-muted mb-2">${escapeHtml(truncate(String(drive.description), 140))}</p>`
    : '';
  const matchPer = drive.match_per_project
    ? `<div class="artizen-stat"><span>Match / project</span><strong>${usd(drive.match_per_project)}</strong></div>`
    : '';
  const goal = drive.goal
    ? `<div class="artizen-stat"><span>Goal</span><strong>${usd(drive.goal)}</strong></div>`
    : '';
  const salesRank = driveHasBonusPot(drive);
  const kind = drive.active ? 'Leading' : 'Winning';
  const podiums = (
    [
      [`${kind} projects`, drive.podium, [drive.project_first, drive.project_second, drive.project_third], drive.bonus_projects],
      [`${kind} funds`, drive.fund_podium, [drive.fund_first, drive.fund_second, drive.fund_third], drive.bonus_funds],
    ] as const
  )
    .map(([title, podium, prizes, bonus]) => podiumTable(title, podium, prizes, drive, salesRank, bonus))
    .join('');
  return `<div class="col-md-6 mb-3">
    <div class="card h-100">
      ${img}
      <div class="card-body">
        <div class="d-flex justify-content-between align-items-start mb-2 gap-2">
          <h5 class="mb-0">${escapeHtml(drive.name)} ${multiple}</h5>
          ${status}
        </div>
        <p class="small text-muted mb-2">${fmtDate(drive.start)} – ${fmtDate(drive.end, true)}</p>
        ${desc}
        <div class="artizen-stat-row">
          <div class="artizen-stat"><span>Match pot</span><strong>${usd(drive.match_pot)}</strong></div>
          <div class="artizen-stat"><span>Project prizes</span><strong>${usd(placePrizeTotal(drive.project_first, drive.project_second, drive.project_third, drive.prize_projects))}</strong></div>
          <div class="artizen-stat"><span>Fund prizes</span><strong>${usd(placePrizeTotal(drive.fund_first, drive.fund_second, drive.fund_third, drive.prize_funds))}</strong></div>
          ${goal}
          ${matchPer}
        </div>
        ${podiums}
      </div>
    </div>
  </div>`;
}

function placePrizeTotal(
  first?: number | null,
  second?: number | null,
  third?: number | null,
  fallback?: number | null,
): number | null | undefined {
  const total = [first, second, third].reduce<number>((sum, n) => sum + (Number(n) || 0), 0);
  return total > 0 ? total : fallback;
}

function podiumTable(
  title: string,
  podium: PodiumRow[] | undefined,
  prizes: ReadonlyArray<number | null | undefined>,
  drive: Drive,
  salesRank: boolean,
  bonus?: number | null,
): string {
  if (!podium || podium.length === 0) return '';
  const bonusLabel = Number(bonus) > 0 ? `<span class="artizen-podium-bonus">Bonus pot <strong>${usd(bonus)}</strong></span>` : '';
  const showBonus = salesRank && !drive.active;
  const head = salesRank
    ? `<thead><tr><th></th><th class="text-end">Raised</th><th class="artizen-podium-op">→</th><th class="text-end">Prize</th>${showBonus ? '<th class="text-end">Bonus</th>' : ''}</tr></thead>`
    : '<thead><tr><th></th><th class="text-end">Raised</th><th class="artizen-podium-op">x</th><th class="text-end">Boosts</th><th class="artizen-podium-op">=</th><th class="text-end">Score</th><th class="artizen-podium-op">→</th><th class="text-end">Prize</th></tr></thead>';
  const rows = podium
    .map((row, i) => {
      const prize = `<td class="text-end text-nowrap">${prizeLabel(prizes[i], drive.active)}</td>`;
      if (salesRank) {
        return `<tr>
            <td><span class="text-muted">${i + 1}.</span> ${namedLink(row.url, row.name)}</td>
            <td class="text-end text-nowrap">${usd(row.sales_match)}</td>
            <td class="artizen-podium-op">→</td>
            ${prize}
            ${showBonus ? `<td class="text-end text-nowrap">${usd(row.bonus, true)}</td>` : ''}
          </tr>`;
      }
      return `<tr>
            <td><span class="text-muted">${i + 1}.</span> ${namedLink(row.url, row.name)}</td>
            <td class="text-end text-nowrap">${usd(row.sales_match)}</td>
            <td class="artizen-podium-op">x</td>
            <td class="text-end text-nowrap">${delimited(row.points)}</td>
            <td class="artizen-podium-op">=</td>
            <td class="text-end text-nowrap">${compactNum(row.score)}</td>
            <td class="artizen-podium-op">→</td>
            ${prize}
          </tr>`;
    })
    .join('');
  return `<div class="artizen-nested">
        <div class="artizen-podium-head">
          <h2 class="artizen-panel-title">${title}</h2>
          ${bonusLabel}
        </div>
        <div class="artizen-podium-scroll">
          <table class="table table-sm mb-0 artizen-podium">
            ${head}
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
}
