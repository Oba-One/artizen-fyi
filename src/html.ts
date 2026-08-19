import type {
  Artizen,
  Drive,
  FundPage,
  FundRow,
  Leaderboard,
  ProjectPage,
  ProjectSubmission,
} from './artizen';
import {
  compactNum,
  delimited,
  fmtDate,
  funding,
  heatRanks,
  heatTd,
  moneyCells,
  truncate,
  usd,
} from './format';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function simpleFormat(text: string): string {
  const escaped = escapeHtml(text).replace(/\r\n?/g, '\n');
  return `<p>${escaped.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
}

const STYLES = `
  .artizen-badge-sm { font-size: 0.7rem; font-weight: 600; vertical-align: middle; position: relative; top: -0.12em; }
  .artizen-rank { font-size: 0.7rem; font-weight: 400; white-space: nowrap; color: #000; }
  .artizen-drive-thumb { width: 100%; height: 120px; object-fit: cover; background: #222; }
  .artizen-podium { font-size: 0.75rem; }
  .artizen-podium td:first-child { padding-right: 0.5rem; }
  .artizen-prize-chart { position: relative; height: 280px; }
  .artizen-hero { width: 100%; max-height: 320px; object-fit: cover; border-radius: 6px; background: #eee; }
  #artizen-projects-table { table-layout: fixed; width: 100%; min-width: 68rem; border-collapse: collapse; border-spacing: 0; }
  .artizen-table-scroll { -webkit-overflow-scrolling: touch; }
  @media (max-width: 1099px) {
    .artizen-table-scroll { overflow-x: auto; }
    #artizen-projects-table thead th, #artizen-funds-table thead th { position: static; box-shadow: none; }
  }
  #artizen-projects-table .artizen-heat { width: 7.4%; box-sizing: border-box; }
  #artizen-projects-table td.artizen-heat { white-space: nowrap; }
  #artizen-projects-table td, #artizen-projects-table th { border: none !important; }
  #artizen-projects-table td, #artizen-funds-table td, #artizen-projects-table th, #artizen-funds-table th { vertical-align: middle; }
  #artizen-projects-table thead th, #artizen-funds-table thead th { position: sticky; top: 0; z-index: 2; background: #fff; box-shadow: 0 1px 0 #dee2e6; }
  .artizen-tree-hidden { display: none !important; }
  .artizen-funding-tree td, .artizen-funding-tree th { vertical-align: top; }
  .artizen-tree-toggle { color: inherit; width: 1.15rem; display: inline-block; text-align: center; line-height: 1; vertical-align: top; }
  .artizen-tree-toggle:hover, .artizen-tree-toggle:focus { color: inherit; text-decoration: none; }
  .artizen-tree-label { display: inline-block; vertical-align: top; max-width: calc(100% - 1.4rem); }
  .artizen-tree-drive td:first-child, .artizen-tree-submission td:first-child { padding-left: 1.5rem; }
  .artizen-tree-fund td:first-child, .artizen-tree-project td:first-child { padding-left: 2.75rem; }
  .artizen-tree-adjust td { font-style: italic; color: #888; }
`;

const TREE_SCRIPT = `
<script>
  $(function() {
    function setKids($table, id, show) {
      var $kids = $table.find('tr[data-parent="' + id + '"]');
      if (show) {
        $kids.removeClass('artizen-tree-hidden');
        $kids.each(function() {
          var childId = $(this).attr('data-id');
          if (!childId) return;
          var childOpen = $(this).find('a.artizen-tree-toggle[aria-expanded="true"]').length > 0;
          setKids($table, childId, childOpen);
        });
      } else {
        $kids.addClass('artizen-tree-hidden');
        $kids.each(function() {
          var childId = $(this).attr('data-id');
          if (childId) setKids($table, childId, false);
        });
      }
    }
    $('.artizen-funding-tree').on('click', '.artizen-tree-toggle', function(e) {
      e.preventDefault();
      var $btn = $(this);
      if (!$btn.is('a')) return;
      var $table = $btn.closest('.artizen-funding-tree');
      var id = $btn.closest('tr').attr('data-id');
      var expanding = $btn.attr('aria-expanded') !== 'true';
      $btn.attr('aria-expanded', expanding);
      $btn.find('i').toggleClass('bi-chevron-down', expanding).toggleClass('bi-chevron-right', !expanding);
      setKids($table, id, expanding);
    });
  });
</script>
`;

function layout(opts: { title: string; description?: string; image?: string | null; body: string; extra?: string }): string {
  const desc = escapeHtml(opts.description || 'Fund and project leaderboards from Artizen');
  const ogImage = opts.image ? `<meta property="og:image" content="${escapeHtml(opts.image)}">` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(opts.title)}</title>
  <meta name="description" content="${desc}">
  <meta property="og:title" content="${escapeHtml(opts.title)}">
  <meta property="og:description" content="${desc}">
  ${ogImage}
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/4.0.0-beta/css/bootstrap.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/datatables/1.10.16/css/dataTables.bootstrap4.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap-icons/1.13.1/font/bootstrap-icons.min.css">
  <style>${STYLES}</style>
</head>
<body>
  <div class="container-fluid py-3">
    ${opts.body}
  </div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.2.0/jquery.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/popper.js/1.11.0/umd/popper.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/4.0.0-beta/js/bootstrap.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/datatables/1.10.16/js/jquery.dataTables.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/datatables/1.10.16/js/dataTables.bootstrap4.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.5.1/chart.min.js"></script>
  ${TREE_SCRIPT}
  ${opts.extra || ''}
</body>
</html>`;
}

function datatable(tableId: string, order: Array<[number, string]>, numeric: number[]): string {
  return `<script>
    $(function() {
      $('#${tableId}').DataTable({
        paging: true,
        pageLength: 25,
        lengthMenu: [10, 25, 50, 100],
        searching: true,
        info: true,
        autoWidth: false,
        order: ${JSON.stringify(order)},
        columnDefs: [{ type: 'num', targets: ${JSON.stringify(numeric)} }]
      });
      $('#${tableId}').wrap('<div class="artizen-table-scroll"></div>');
    });
  </script>`;
}

function seasonQuery(season?: string | null): string {
  return season ? `?season=${encodeURIComponent(season)}` : '';
}

function board(data: Leaderboard, tab: 'projects' | 'funds' | 'drives', seasonParam: string | null): string {
  const season = data.season;
  const qs = seasonQuery(seasonParam);
  const options = data.seasons
    .map((s) => {
      const selected = season && s.number === season.number ? ' selected' : '';
      const current = s.current ? ' (current)' : '';
      return `<option value="${s.number}"${selected}>${escapeHtml(s.title)}${current}</option>`;
    })
    .join('');
  const raised = season?.total_raised ? ` · ${usd(season.total_raised)} raised this season` : '';
  const error = data.error && data.projects.length === 0 && data.funds.length === 0;
  const tabs = error
    ? ''
    : `<ul class="nav nav-tabs mb-3">
        <li class="nav-item"><a class="nav-link${tab === 'projects' ? ' active' : ''}" href="/projects${qs}">Projects (${data.projects.length})</a></li>
        <li class="nav-item"><a class="nav-link${tab === 'funds' ? ' active' : ''}" href="/funds${qs}">Funds (${data.funds.length})</a></li>
        <li class="nav-item"><a class="nav-link${tab === 'drives' ? ' active' : ''}" href="/drives${qs}">Drives (${data.drives.length})</a></li>
      </ul>`;
  const alert = error
    ? `<div class="alert alert-warning">
        Could not load Artizen leaderboards. Try again later or visit
        <a href="https://artizen.fund/index/leaderboard" class="alert-link" target="_blank" rel="noopener">their leaderboard</a> directly.
      </div>`
    : '';
  return `
    <div class="mb-3">
      <h2 class="mb-1">Artizen leaderboards</h2>
      <p class="text-muted mb-2">
        Data from <a href="https://artizen.fund/" target="_blank" rel="noopener">artizen.fund</a>${raised}
      </p>
      <form method="get" class="form-inline">
        <label for="artizen-season" class="mr-2 mb-0">Season</label>
        <select name="season" id="artizen-season" class="form-control" onchange="this.form.submit()">${options}</select>
      </form>
    </div>
    ${alert}
    ${tabs}
  `;
}

function chevron(open: boolean, hasKids: boolean): string {
  if (!hasKids) return '<span class="artizen-tree-toggle"></span>';
  return `<a href="#" class="artizen-tree-toggle" aria-expanded="${open}"><i class="bi ${open ? 'bi-chevron-down' : 'bi-chevron-right'}"></i></a>`;
}

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
    const heat = heatRanks(rows, cols.map(([f]) => f));
    const head = cols.map(([, label]) => `<th class="text-right artizen-heat">${label}</th>`).join('');
    const body = rows
      .map((project, i) => {
        const logline = project.logline
          ? `<br><small class="text-muted">${escapeHtml(truncate(project.logline, 90))}</small>`
          : '';
        const cells = cols.map(([field, , as]) => heatTd(project, String(field), heat[String(field)], i, rows.length, as)).join('');
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
  });
}

export function renderFunds(data: Leaderboard, seasonParam: string | null): string {
  const empty = data.error && data.projects.length === 0 && data.funds.length === 0;
  const current = Boolean(data.season?.current);
  let table = '';
  let extra = '';
  if (!empty) {
    const extraHeads = current
      ? '<th class="text-right">Unlocked</th><th class="text-right">Available</th><th class="text-right">Raised</th>'
      : '';
    const body = data.funds
      .map((fund: FundRow) => {
        const subtitle = fund.subtitle
          ? `<br><small class="text-muted">${escapeHtml(truncate(fund.subtitle, 90))}</small>`
          : '';
        const inactive = fund.active === false ? '<br><span class="badge badge-secondary">Inactive</span>' : '';
        const extraCols = current
          ? `<td class="text-right" data-order="${fund.unlocked ?? -1}">${usd(fund.unlocked)}</td>
             <td class="text-right" data-order="${fund.available ?? -1}">${usd(fund.available)}</td>
             <td class="text-right" data-order="${fund.raised ?? -1}">${usd(fund.raised)}</td>`
          : '';
        return `<tr>
          <td><strong><a href="${escapeHtml(fund.url)}" class="text-dark">${escapeHtml(fund.name)}</a></strong>${subtitle}${inactive}</td>
          <td class="text-right" data-order="${fund.season_total}">${usd(fund.season_total)}</td>
          ${extraCols}
        </tr>`;
      })
      .join('');
    table = `
      <p class="text-muted mb-2">
        Fund unlocked = match paid to projects plus awards on curated submissions (Artizen’s distributed). Raised = unlocked + available.
      </p>
      <table id="artizen-funds-table" class="table table-sm">
        <thead><tr><th>Fund</th><th class="text-right">Contributions</th>${extraHeads}</tr></thead>
        <tbody>${body}</tbody>
      </table>`;
    extra = current
      ? datatable('artizen-funds-table', [[3, 'desc']], [1, 2, 3, 4])
      : datatable('artizen-funds-table', [[1, 'desc']], [1]);
  }
  const title = data.season ? `Artizen · ${data.season.title}` : 'Artizen';
  return layout({
    title,
    body: board(data, 'funds', seasonParam) + table,
    extra,
  });
}

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
          ['Projects', 'artizen-project-score-chart', 'podium', ['#2DB963', '#7BC99A', '#C5E8D4']],
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
        $(function() {
          function compactScore(n) {
            var a = Math.abs(n);
            var sign = n < 0 ? '-' : '';
            var div, suffix;
            if (a >= 1e6) { div = 1e6; suffix = 'm'; }
            else if (a >= 1e3) { div = 1e3; suffix = 'k'; }
            else return sign + Math.round(a);
            var scaled = a / div;
            var text = scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\\.0$/, '');
            return sign + text + suffix;
          }
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
                        return text + ': ' + compactScore(n);
                      }
                    }
                  }
                },
                scales: {
                  x: { grid: { display: false } },
                  y: { beginAtZero: true, ticks: { callback: function(v) { return compactScore(v); } } }
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
  });
}

function driveCard(drive: Drive): string {
  const img = drive.image
    ? `<img class="artizen-drive-thumb card-img-top" src="${escapeHtml(drive.image)}" alt="" loading="lazy">`
    : '';
  const multiple = drive.multiple
    ? `<span class="badge badge-primary artizen-badge-sm">${Math.trunc(Number(drive.multiple))}x</span>`
    : '';
  const status = drive.active
    ? '<span class="badge badge-primary">Active</span>'
    : `<span class="badge badge-secondary">${escapeHtml(drive.status)}</span>`;
  const desc = drive.description
    ? `<p class="small text-muted mb-2">${escapeHtml(truncate(String(drive.description), 140))}</p>`
    : '';
  const matchPer = drive.match_per_project
    ? `<dt class="col-6">Match / project</dt><dd class="col-6 text-right">${usd(drive.match_per_project)}</dd>`
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
            <td class="text-right text-nowrap">${usd(prizes[i])}</td>
            <td class="text-right text-nowrap">${usd(row.sales_match)}</td>
            <td class="text-right text-nowrap">${delimited(row.points)}</td>
            <td class="text-right text-nowrap">${compactNum(row.score)}</td>
          </tr>`,
        )
        .join('');
      return `<h6 class="mt-3 mb-1">${title}</h6>
        <table class="table table-sm mb-0 artizen-podium">
          <thead><tr><th></th><th class="text-right">Prize</th><th class="text-right">Sales+match</th><th class="text-right">Points</th><th class="text-right">Score</th></tr></thead>
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
          <dt class="col-6">Match pot</dt><dd class="col-6 text-right">${usd(drive.match_pot)}</dd>
          <dt class="col-6">Project prizes</dt><dd class="col-6 text-right">${usd(drive.prize_projects)}</dd>
          <dt class="col-6">Fund prizes</dt><dd class="col-6 text-right">${usd(drive.prize_funds)}</dd>
          ${matchPer}
        </dl>
        ${podiums}
      </div>
    </div>
  </div>`;
}

export function renderProject(project: ProjectPage, artizen: Artizen): string {
  const tags = (project.tags || []).map((tag) => `<span class="badge badge-secondary mr-1 mb-1">${escapeHtml(tag)}</span>`).join('');
  const imgCol = project.image
    ? `<div class="col-lg-4 mb-3"><img class="artizen-hero" src="${escapeHtml(project.image)}" alt="${escapeHtml(project.name)}"></div><div class="col-lg-8">`
    : '<div class="col-lg-12">';
  const fundingTable = project.seasons.length ? projectFundingTable(project) : '';
  const submissions = project.submissions?.length ? projectSubmissions(project.submissions) : '';
  const video = artizen.videoIframe(project.video) || '';
  const sections = (
    [
      ['About', project.description],
      ['Impact', project.impact],
      ['Progress', project.progress],
      ['Team', project.team],
    ] as const
  )
    .map(([heading, body]) => (body ? `<h2 class="mt-4">${heading}</h2>${simpleFormat(body)}` : ''))
    .join('');
  return layout({
    title: project.name,
    description: project.logline || `Artizen project: ${project.name}`,
    image: project.image,
    body: `
      <p class="mb-3"><a href="/projects">&larr; Artizen leaderboards</a></p>
      <div class="row mb-4">
        ${imgCol}
          <h1 class="mb-2">${escapeHtml(project.name)}</h1>
          ${project.logline ? `<p class="lead">${escapeHtml(project.logline)}</p>` : ''}
          ${project.creator ? `<p class="mb-2">${escapeHtml(project.creator)}</p>` : ''}
          ${tags}
          <p class="mt-2 mb-0"><a href="${escapeHtml(project.artizen_url)}" target="_blank" rel="noopener">View on Artizen</a></p>
        </div>
      </div>
      ${fundingTable}
      ${submissions}
      ${video}
      ${sections}
    `,
  });
}

function projectFundingTable(project: ProjectPage): string {
  const seasons = project.seasons
    .map((season, si) => {
      const seasonId = `s${si}`;
      const seasonOpen = si === 0;
      const drives = season.drives || [];
      const seasonRow = `<tr class="artizen-tree-season" data-id="${seasonId}">
        <td>${chevron(seasonOpen, drives.length > 0)} ${escapeHtml(season.title)}</td>
        ${moneyCells(season)}
        <td class="text-right">${Number(season.available) > 0 ? usd(season.available) : ''}</td>
      </tr>`;
      const driveRows = drives
        .map((drive, di) => {
          const driveId = `${seasonId}d${di}`;
          const driveOpen = seasonOpen && di === 0;
          const funds = drive.funds || [];
          const hidden = seasonOpen ? '' : ' artizen-tree-hidden';
          const driveRow = `<tr class="artizen-tree-drive${hidden}" data-id="${driveId}" data-parent="${seasonId}">
            <td>${chevron(driveOpen, funds.length > 0)} ${escapeHtml(drive.name)}${
              drive.multiple ? ` <span class="badge badge-primary">${Math.trunc(Number(drive.multiple))}x</span>` : ''
            }${drive.active ? ' <span class="badge badge-primary">current</span>' : ''}</td>
            ${moneyCells(drive)}
            <td class="text-right">${drive.active ? usd(drive.available) : ''}</td>
          </tr>`;
          const fundRows = funds
            .map((fund) => {
              const fundHidden = driveOpen ? '' : ' artizen-tree-hidden';
              return `<tr class="artizen-tree-fund${fundHidden}" data-parent="${driveId}">
                <td><span class="artizen-tree-toggle"></span> <a href="${escapeHtml(fund.url)}" class="text-dark">${escapeHtml(fund.name)}</a></td>
                <td class="text-right"></td><td class="text-right"></td>
                <td class="text-right">${usd(fund.unlocked)}</td>
                <td class="text-right"></td><td class="text-right"></td><td class="text-right"></td><td class="text-right"></td><td class="text-right"></td><td class="text-right"></td>
                <td class="text-right">${drive.active ? usd(fund.available) : ''}</td>
              </tr>`;
            })
            .join('');
          return driveRow + fundRows;
        })
        .join('');
      return seasonRow + driveRows;
    })
    .join('');
  const totals = {
    sales: sumField(project.seasons, 'sales'),
    venus: sumField(project.seasons, 'venus'),
    match: sumField(project.seasons, 'match'),
    prize: sumField(project.seasons, 'prize'),
    raised: sumField(project.seasons, 'raised'),
  };
  return `
    <h2 class="mt-4">Funding</h2>
    <div class="table-responsive mb-4">
      <table class="table table-sm artizen-funding-tree">
        <thead><tr>
          <th></th><th class="text-right">Sales</th><th class="text-right">Venus</th><th class="text-right">Match</th>
          <th class="text-right">Prize</th><th class="text-right">V+M+P</th><th class="text-right">V/S</th>
          <th class="text-right">(V+M)/S</th><th class="text-right">(V+M+P)/S</th><th class="text-right">Raised</th>
          <th class="text-right">Available</th>
        </tr></thead>
        <tbody>${seasons}</tbody>
        <tfoot><tr>
          <th>Total</th>
          ${moneyCells(totals, 'th')}
          <th class="text-right">${usd(sumField(project.seasons, 'available'))}</th>
        </tr></tfoot>
      </table>
    </div>`;
}

function projectSubmissions(submissions: ProjectSubmission[]): string {
  const groups: { title: string; items: ProjectSubmission[] }[] = [];
  const index = new Map<string, number>();
  for (const s of submissions) {
    const key = `${s.season_number}\0${s.season}`;
    let i = index.get(key);
    if (i == null) {
      i = groups.length;
      index.set(key, i);
      groups.push({ title: s.season || 'Season', items: [] });
    }
    groups[i].items.push(s);
  }
  const rows = groups
    .map((group, si) => {
      const seasonId = `sub${si}`;
      const open = si === 0;
      const head = `<tr class="artizen-tree-season" data-id="${seasonId}">
        <td>${chevron(open, true)} ${escapeHtml(group.title)}</td><td></td>
      </tr>`;
      const kids = group.items
        .map((submission) => {
          const accepted = submission.status === 'Curated' || submission.status === 'Approved';
          const hidden = open ? '' : ' artizen-tree-hidden';
          return `<tr class="artizen-tree-submission${hidden}" data-parent="${seasonId}">
            <td><span class="artizen-tree-toggle"></span> <a href="${escapeHtml(submission.url)}" class="text-dark">${escapeHtml(submission.name)}</a></td>
            <td class="text-right"><span class="badge ${accepted ? 'badge-primary' : 'badge-secondary'}">${escapeHtml(submission.status)}</span></td>
          </tr>`;
        })
        .join('');
      return head + kids;
    })
    .join('');
  return `
    <h2 class="mt-4">Submissions</h2>
    <div class="table-responsive mb-4">
      <table class="table table-sm artizen-funding-tree">
        <thead><tr><th></th><th class="text-right">Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

export function renderFund(fund: FundPage, artizen: Artizen): string {
  const prize = fund.prize_usd
    ? `<span class="badge badge-primary">Prize ${usd(fund.prize_usd)}</span>`
    : fund.prize_art
      ? `<span class="badge badge-primary">Prize ${delimited(fund.prize_art)} ART</span>`
      : '';
  const fundingTable = fund.seasons.length ? fundFundingTable(fund) : '';
  const video = artizen.videoIframe(fund.video) || '';
  const about = fund.description ? `<h2 class="mt-4">About</h2>${artizen.richText(fund.description)}` : '';
  const eligibility = fund.eligibility ? `<h2 class="mt-4">Eligibility</h2>${artizen.richText(fund.eligibility)}` : '';
  return layout({
    title: fund.name,
    description: fund.subtitle || fund.for_title || `Artizen fund: ${fund.name}`,
    image: fund.image,
    body: `
      <p class="mb-3"><a href="/funds">&larr; Artizen leaderboards</a></p>
      <div class="row mb-4">
        <div class="col-lg-4 mb-3">${fund.image ? `<img class="artizen-hero" src="${escapeHtml(fund.image)}" alt="${escapeHtml(fund.name)}">` : ''}</div>
        <div class="col-lg-8">
          <h1 class="mb-2">${escapeHtml(fund.name)}</h1>
          ${fund.subtitle ? `<p class="lead">${escapeHtml(fund.subtitle)}</p>` : ''}
          ${fund.for_title ? `<p class="text-muted">For ${escapeHtml(fund.for_title)}</p>` : ''}
          ${fund.sponsor ? `<p>Lead sponsor: ${escapeHtml(fund.sponsor)}</p>` : ''}
          ${fund.active === false ? '<span class="badge badge-secondary mr-1">Inactive</span>' : ''}
          ${prize}
          <p class="mt-2 mb-0"><a href="${escapeHtml(fund.artizen_url)}" target="_blank" rel="noopener">View on Artizen</a></p>
        </div>
      </div>
      ${fundingTable}
      ${video}
      ${about}
      ${eligibility}
    `,
  });
}

function fundFundingTable(fund: FundPage): string {
  const seasons = fund.seasons
    .map((season, si) => {
      const seasonId = `s${si}`;
      const seasonOpen = si === 0;
      const drives = season.drives || [];
      const count =
        Number(season.count) > 0
          ? `<small class="text-muted">${season.count} ${season.count === 1 ? 'contribution' : 'contributions'}</small>`
          : '';
      const seasonRow = `<tr class="artizen-tree-season" data-id="${seasonId}">
        <td>${chevron(seasonOpen, drives.length > 0)} ${escapeHtml(season.title)} ${count}</td>
        <td class="text-right">${usd(season.total)}</td>
        <td class="text-right">${usd(season.unlocked)}</td>
        <td class="text-right">${Number(season.available) > 0 ? usd(season.available) : ''}</td>
        <td class="text-right">${usd((season.unlocked || 0) + (season.available || 0))}</td>
      </tr>`;
      const driveRows = drives
        .map((drive, di) => {
          const driveId = `${seasonId}d${di}`;
          const driveOpen = seasonOpen && di === 0;
          const live = drive.active || drive.adjustment;
          const hidden = seasonOpen ? '' : ' artizen-tree-hidden';
          const adjust = drive.adjustment ? ' artizen-tree-adjust' : '';
          const projects = drive.projects || [];
          const driveRow = `<tr class="artizen-tree-drive${adjust}${hidden}" data-id="${driveId}" data-parent="${seasonId}">
            <td>${chevron(driveOpen, projects.length > 0)} ${escapeHtml(drive.name)}${
              drive.multiple ? ` <span class="badge badge-primary">${Math.trunc(Number(drive.multiple))}x</span>` : ''
            }${drive.active ? ' <span class="badge badge-primary">current</span>' : ''}</td>
            <td class="text-right"></td>
            <td class="text-right">${drive.adjustment ? '' : usd(drive.unlocked)}</td>
            <td class="text-right">${live ? usd(drive.available) : ''}</td>
            <td class="text-right">${live || Number(drive.unlocked) > 0 ? usd((drive.unlocked || 0) + (drive.available || 0)) : ''}</td>
          </tr>`;
          const projectRows = projects
            .map((project) => {
              const projectHidden = driveOpen ? '' : ' artizen-tree-hidden';
              return `<tr class="artizen-tree-project${projectHidden}" data-parent="${driveId}">
                <td><span class="artizen-tree-toggle"></span>
                  <span class="artizen-tree-label">
                    <a href="${escapeHtml(project.url)}" class="text-dark">${escapeHtml(project.name)}</a>
                    ${project.hidden ? ' <span class="badge badge-secondary">hidden</span>' : ''}
                    ${project.creator ? `<br><small class="text-muted">${escapeHtml(project.creator)}</small>` : ''}
                  </span>
                </td>
                <td class="text-right"></td>
                <td class="text-right">${usd(project.unlocked)}</td>
                <td class="text-right">${live ? usd(project.available) : ''}</td>
                <td class="text-right">${live || Number(project.unlocked) > 0 ? usd((project.unlocked || 0) + (project.available || 0)) : ''}</td>
              </tr>`;
            })
            .join('');
          return driveRow + projectRows;
        })
        .join('');
      return seasonRow + driveRows;
    })
    .join('');
  return `
    <h2 class="mt-4">Funding</h2>
    <p class="text-muted mb-2">Unlocked = match paid to projects plus awards on curated submissions (Artizen’s distributed). Raised = unlocked + available.</p>
    <div class="table-responsive mb-4">
      <table class="table table-sm artizen-funding-tree">
        <thead><tr>
          <th></th><th class="text-right">Contributions</th><th class="text-right">Unlocked</th>
          <th class="text-right">Available</th><th class="text-right">Raised</th>
        </tr></thead>
        <tbody>${seasons}</tbody>
        <tfoot><tr>
          <th>Total</th>
          <th class="text-right">${usd(sumField(fund.seasons, 'total'))}</th>
          <th class="text-right">${usd(sumField(fund.seasons, 'unlocked'))}</th>
          <th class="text-right">${usd(sumField(fund.seasons, 'available'))}</th>
          <th class="text-right">${usd(sumField(fund.seasons, 'unlocked') + sumField(fund.seasons, 'available'))}</th>
        </tr></tfoot>
      </table>
    </div>`;
}

function sumField<T>(rows: T[], field: keyof T): number {
  return rows.reduce((n, row) => n + (Number(row[field]) || 0), 0);
}

export function renderNotFound(): string {
  return layout({
    title: 'Not found',
    body: '<p>Not found.</p><p><a href="/projects">Artizen leaderboards</a></p>',
  });
}
