import type { Drive, Leaderboard } from '../artizen';
import { compactNum, delimited, fmtDate, truncate, usd } from '../format';
import { board, escapeHtml, layout } from './layout';

export function renderDrives(data: Leaderboard, seasonParam: string | null): string {
  const empty = data.error && data.projects.length === 0 && data.funds.length === 0;
  let body = '';
  let extra = '';
  if (!empty) {
    if (data.drives.length === 0) {
      body = '<p class="text-muted">No fund drives in this season.</p>';
    } else {
      const chartDrives = [...data.drives].sort((a, b) => (a.number || 0) - (b.number || 0));
      const labels = chartDrives.map((d) => String(d.name).replace(/ Fund Drive$/i, ''));
      const scoreCharts = (
        [
          ['Projects', 'artizen-project-score-chart', 'podium', ['#1ACC6C', '#7BC99A', '#C5E8D4']],
          ['Funds', 'artizen-fund-score-chart', 'fund_podium', ['#4C6EF5', '#8DA2F7', '#C5CFFB']],
        ] as const
      ).map(([title, id, key, colors]) => ({
        title,
        id,
        series: (['1st', '2nd', '3rd'] as const).map((place, i) => ({
          label: place,
          data: chartDrives.map((d) => d[key]?.[i]?.score ?? null),
          names: chartDrives.map((d) => d[key]?.[i]?.name ?? null),
          borderColor: colors[i],
          backgroundColor: colors[i],
        })),
      }));
      const canvases = scoreCharts
        .map(
          (chart) => `<h6 class="mb-1">${chart.title}</h6><div class="artizen-prize-chart mb-4"><canvas id="${chart.id}"></canvas></div>`,
        )
        .join('');
      extra = `<script>
        document.addEventListener('DOMContentLoaded', function() {
          var compactNum = ${compactNum.toString()};
          var labels = ${JSON.stringify(labels)};
          var charts = ${JSON.stringify(scoreCharts.map((c) => ({ id: c.id, series: c.series })))};
          charts.forEach(function(chart) {
            var el = document.getElementById(chart.id);
            if (!el) return;
            new Chart(el.getContext('2d'), {
              type: 'line',
              data: {
                labels: labels,
                datasets: chart.series.map(function(s) {
                  return Object.assign({ fill: false, tension: 0.2, spanGaps: true }, s);
                })
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: { position: 'bottom', labels: { boxWidth: 12, padding: 12 } },
                  tooltip: {
                    callbacks: {
                      label: function(ctx) {
                        var n = ctx.parsed.y;
                        if (n == null) return ctx.dataset.label;
                        var name = (ctx.dataset.names || [])[ctx.dataIndex];
                        var text = ctx.dataset.label;
                        if (name) text += ' · ' + name;
                        return text + ': ' + compactNum(n);
                      }
                    }
                  }
                },
                scales: {
                  x: { grid: { display: false } },
                  y: { beginAtZero: true, ticks: { callback: function(v) { return compactNum(v); } } }
                }
              }
            });
          });
        });
      </script>`;
      const cards = data.drives.map((drive) => driveCard(drive)).join('');
      body = `
        <p class="text-muted small mb-3">Projects and funds are ranked by boost score: points × (sales + match) / 100.</p>
        ${canvases}
        <div class="row">${cards}</div>`;
    }
  }
  const title = data.season ? `Artizen · ${data.season.title}` : 'Artizen';
  return layout({
    title,
    body: board(data, 'drives', seasonParam) + body,
    extra,
    chart: Boolean(extra),
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
    ? `<dt class="col-6">Match / project</dt><dd class="col-6 text-end">${usd(drive.match_per_project)}</dd>`
    : '';
  const podiums = (
    [
      ['Projects', drive.podium, [drive.project_first, drive.project_second, drive.project_third]],
      ['Funds', drive.fund_podium, [drive.fund_first, drive.fund_second, drive.fund_third]],
    ] as const
  )
    .map(([title, podium, prizes]) => {
      if (!podium || podium.length === 0) return '';
      const rows = podium
        .map(
          (row, i) => `<tr>
            <td><span class="text-muted">${i + 1}.</span> <a href="${escapeHtml(row.url)}" class="text-dark">${escapeHtml(row.name)}</a></td>
            <td class="text-end text-nowrap">${usd(prizes[i])}</td>
            <td class="text-end text-nowrap">${usd(row.sales_match)}</td>
            <td class="text-end text-nowrap">${delimited(row.points)}</td>
            <td class="text-end text-nowrap">${compactNum(row.score)}</td>
          </tr>`,
        )
        .join('');
      return `<h6 class="mt-3 mb-1">${title}</h6>
        <table class="table table-sm mb-0 artizen-podium">
          <thead><tr><th></th><th class="text-end">Prize</th><th class="text-end">Sales+match</th><th class="text-end">Points</th><th class="text-end">Score</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    })
    .join('');
  return `<div class="col-md-6 col-xl-4 mb-3">
    <div class="card h-100">
      ${img}
      <div class="card-body">
        <div class="d-flex justify-content-between align-items-start mb-1">
          <h5 class="mb-0">${escapeHtml(drive.name)} ${multiple}</h5>
          ${status}
        </div>
        <p class="small mb-2">${fmtDate(drive.start)} – ${fmtDate(drive.end, true)}</p>
        ${desc}
        <dl class="row small mb-0">
          <dt class="col-6">Match pot</dt><dd class="col-6 text-end">${usd(drive.match_pot)}</dd>
          <dt class="col-6">Project prizes</dt><dd class="col-6 text-end">${usd(drive.prize_projects)}</dd>
          <dt class="col-6">Fund prizes</dt><dd class="col-6 text-end">${usd(drive.prize_funds)}</dd>
          ${matchPer}
        </dl>
        ${podiums}
      </div>
    </div>
  </div>`;
}
