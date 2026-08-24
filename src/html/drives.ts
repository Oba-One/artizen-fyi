import { BONUS_POWER, driveHasBonusPot, type BonusChart, type Drive, type Leaderboard, type PodiumRow } from '../artizen';
import { compactNum, delimited, fmtDate, prizeLabel, truncate, usd } from '../format';
import { board, boardEmpty, escapeHtml, layout, namedLink, pageTitle, panel } from './layout';

export function renderDrives(data: Leaderboard, seasonParam: string | null): string {
  const empty = boardEmpty(data);
  let body = '';
  let extra = '';
  if (!empty) {
    const chart = bonusChartPanel(data.drives);
    body =
      (chart?.html ?? '') +
      (data.drives.length === 0
        ? panel('<p class="text-muted mb-0">No fund drives in this season.</p>')
        : `<div class="row">${data.drives.map((drive) => driveCard(drive)).join('')}</div>`);
    extra = chart?.script ?? '';
  }
  return layout({
    title: pageTitle(data),
    body: board(data, 'drives', seasonParam) + body,
    extra,
    season: seasonParam,
    boards: true,
  });
}

function pickBonusChart(drives: Drive[]): { drive: Drive; chart: BonusChart } | undefined {
  const hits = drives.filter((drive) => drive.bonus_chart);
  const drive = hits.find((item) => item.active) ?? hits[0];
  return drive?.bonus_chart ? { drive, chart: drive.bonus_chart } : undefined;
}

function bonusChartPanel(drives: Drive[]): { html: string; script: string } | undefined {
  const picked = pickBonusChart(drives);
  if (!picked) return undefined;
  const { drive, chart } = picked;
  const kind = chart.kind === 'fund' ? 'funds' : 'projects';
  const noun = chart.kind === 'fund' ? 'fund' : 'project';
  const payload = {
    pot: chart.pot,
    weightSum: chart.weight_sum,
    power: BONUS_POWER,
    kind,
    points: chart.shares.map((row) => ({
      name: row.name,
      url: row.url,
      x: row.points,
      y: row.bonus,
    })),
  };
  const html = panel(`
    <h2 class="artizen-panel-title">Bonus vs boosts</h2>
    <p class="text-muted small mb-3">${escapeHtml(drive.name)} · ${kind} share a <strong>${usd(chart.pot)}</strong> pot on a fifth-root curve (<code>boosts<sup>${BONUS_POWER}</sup></code>). Showing the top 10 by boosts; hover a ${noun} for its take.</p>
    <div class="artizen-bonus-chart"><canvas id="artizen-bonus-chart" aria-label="Bonus versus boosts"></canvas></div>
  `);
  const script = `
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script>
(function() {
  var canvas = document.getElementById('artizen-bonus-chart');
  if (!canvas || !window.Chart) return;
  var data = ${JSON.stringify(payload).replace(/</g, '\\u003c')};
  var maxX = 1;
  for (var i = 0; i < data.points.length; i++) {
    if (data.points[i].x > maxX) maxX = data.points[i].x;
  }
  maxX *= 1.06;
  var curve = [];
  var curveSteps = 128;
  for (var s = 0; s <= curveSteps; s++) {
    var progress = s / curveSteps;
    var x = maxX * Math.pow(progress, 1 / data.power);
    var w = x > 0 ? Math.pow(x, data.power) : 0;
    curve.push({ x: x, y: data.weightSum > 0 ? (w / data.weightSum) * data.pot : 0 });
  }
  var ink = '#101212';
  var muted = '#8690A0';
  var line = '#E2E5E7';
  var green = '#1ACC6C';
  var accent = data.kind === 'funds' ? '#4C6EF5' : green;
  function compact(n) {
    var a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\\.0$/, '') + 'm';
    if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\\.0$/, '') + 'k';
    return String(Math.round(n));
  }
  function money(n) {
    if (Math.abs(n) >= 100) return '$' + Math.round(n).toLocaleString('en-US');
    return '$' + Number(n).toFixed(2);
  }
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = muted;
  new Chart(canvas, {
    type: 'scatter',
    data: {
      datasets: [
        {
          label: 'Fifth root',
          data: curve,
          showLine: true,
          pointRadius: 0,
          pointHitRadius: 0,
          borderColor: accent,
          borderWidth: 2,
          backgroundColor: 'transparent',
          tension: 0,
          order: 2
        },
        {
          label: data.kind === 'funds' ? 'Top 10 funds' : 'Top 10 projects',
          data: data.points,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBorderWidth: 1,
          pointBorderColor: '#fff',
          backgroundColor: accent,
          order: 1
        }
      ]
    },
    options: {
      animation: false,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: true },
      onHover: function(e, els) {
        var t = e.native && e.native.target;
        if (t) t.style.cursor = els.length && els[0].datasetIndex === 1 ? 'pointer' : 'default';
      },
      onClick: function(_e, els, chart) {
        var el = els[0];
        if (!el || el.datasetIndex !== 1) return;
        var pt = chart.data.datasets[1].data[el.index];
        if (pt && pt.url) location.href = pt.url;
      },
      plugins: {
        legend: {
          display: true,
          labels: { boxWidth: 12, color: ink, usePointStyle: true }
        },
        tooltip: {
          callbacks: {
            title: function(items) {
              var pt = items[0] && items[0].raw;
              return pt && pt.name ? pt.name : '';
            },
            label: function(item) {
              if (item.datasetIndex === 0) return 'Fifth root  ' + money(item.parsed.y);
              return compact(item.parsed.x) + ' boosts  ·  ' + money(item.parsed.y);
            }
          }
        }
      },
      scales: {
        x: {
          title: { display: true, text: 'Boosts', color: ink },
          grid: { color: line },
          ticks: { callback: compact },
          min: 0
        },
        y: {
          title: { display: true, text: 'Bonus', color: ink },
          grid: { color: line },
          ticks: { callback: money },
          min: 0
        }
      }
    }
  });
})();
</script>`;
  return { html, script };
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
            ${showBonus ? `<td class="text-end text-nowrap">${usd(row.bonus)}</td>` : ''}
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
