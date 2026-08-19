import type { Leaderboard } from '../artizen';
import { usd } from '../format';
import styles from '../styles.css';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function simpleFormat(text: string): string {
  const escaped = escapeHtml(text).replace(/\r\n?/g, '\n');
  return `<p>${escaped.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
}

export function richText(text?: string | null): string | undefined {
  if (text == null || text === '') return undefined;

  let html = String(text);
  html = html.replace(/\[url=([^\]]+)\](.*?)\[\/url\]/gs, '<a href="$1" target="_blank" rel="noopener">$2</a>');
  html = html.replace(/\[b\](.*?)\[\/b\]/gs, '<strong>$1</strong>');
  html = html.replace(/\[i\](.*?)\[\/i\]/gs, '<em>$1</em>');
  html = html.replace(/\[\/?ml\]/g, '');
  html = html.replace(/\[ul\]/g, '<ul>');
  html = html.replace(/\[\/ul\]/g, '</ul>');
  html = html.replace(/\[li[^\]]*\]/g, '<li>');
  html = html.replace(/\[\/li\]/g, '</li>');
  html = html.replace(/\r\n?/g, '\n');
  html = html.replace(/\n{2,}/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  return `<p>${html}</p>`;
}

export function videoIframe(url?: string | null): string | undefined {
  if (url == null || url === '') return undefined;

  const youtube = String(url).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]+)/);
  if (youtube) {
    return `<div class="ratio ratio-16x9 mb-3"><iframe src="https://www.youtube.com/embed/${youtube[1]}" allowfullscreen></iframe></div>`;
  }
  const vimeo = String(url).match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vimeo) {
    return `<div class="ratio ratio-16x9 mb-3"><iframe src="https://player.vimeo.com/video/${vimeo[1]}" allowfullscreen></iframe></div>`;
  }
  return `<p><a href="${url}" target="_blank" rel="noopener">Watch presentation</a></p>`;
}

const TREE_SCRIPT = `
<script>
  document.addEventListener('DOMContentLoaded', function() {
    function setKids(table, id, show) {
      table.querySelectorAll('tr[data-parent="' + id + '"]').forEach(function(tr) {
        var childId = tr.getAttribute('data-id');
        if (show) {
          tr.classList.remove('artizen-tree-hidden');
          if (!childId) return;
          var toggle = tr.querySelector('a.artizen-tree-toggle');
          setKids(table, childId, toggle && toggle.getAttribute('aria-expanded') === 'true');
        } else {
          tr.classList.add('artizen-tree-hidden');
          if (childId) setKids(table, childId, false);
        }
      });
    }
    document.querySelectorAll('.artizen-funding-tree').forEach(function(table) {
      table.addEventListener('click', function(e) {
        var btn = e.target.closest('a.artizen-tree-toggle');
        if (!btn || !table.contains(btn)) return;
        e.preventDefault();
        var row = btn.closest('tr');
        var id = row && row.getAttribute('data-id');
        if (!id) return;
        var expanding = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', expanding);
        var icon = btn.querySelector('i');
        if (icon) {
          icon.classList.toggle('bi-chevron-down', expanding);
          icon.classList.toggle('bi-chevron-right', !expanding);
        }
        setKids(table, id, expanding);
      });
    });
  });
</script>
`;

export function layout(opts: {
  title: string;
  description?: string;
  image?: string | null;
  body: string;
  extra?: string;
  datatables?: boolean;
  chart?: boolean;
  tree?: boolean;
}): string {
  const desc = escapeHtml(opts.description || 'Fund and project leaderboards from Artizen');
  const ogImage = opts.image ? `<meta property="og:image" content="${escapeHtml(opts.image)}">` : '';
  const css = [
    '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.8/css/bootstrap.min.css">',
    opts.datatables
      ? '<link rel="stylesheet" href="https://cdn.datatables.net/v/bs5/dt-3.0.2/datatables.min.css">'
      : '',
    opts.tree
      ? '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap-icons/1.13.1/font/bootstrap-icons.min.css">'
      : '',
  ]
    .filter(Boolean)
    .join('\n  ');
  const js = [
    opts.datatables
      ? '<script src="https://cdn.datatables.net/v/bs5/dt-3.0.2/datatables.min.js"></script>'
      : '',
    opts.chart ? '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.1/chart.umd.min.js"></script>' : '',
    opts.tree ? TREE_SCRIPT : '',
    opts.extra || '',
  ]
    .filter(Boolean)
    .join('\n  ');
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
  ${css}
  <link rel="stylesheet" href="https://s3.amazonaws.com/appforest_uf/f1669921386747x462861532157019100/RocGroteskBold.css">
  <link rel="stylesheet" href="https://s3.amazonaws.com/appforest_uf/f1670009029268x384309142695173700/RocGroteskMedium.css">
  <style>${styles}</style>
</head>
<body>
  <div class="container-fluid py-3">
    ${opts.body}
  </div>
  ${js}
</body>
</html>`;
}

export function datatable(tableId: string, order: Array<[number, string]>, numeric: number[]): string {
  return `<script>
    document.addEventListener('DOMContentLoaded', function() {
      var table = document.getElementById('${tableId}');
      if (!table) return;
      new DataTable(table, {
        paging: true,
        pageLength: 25,
        lengthMenu: [10, 25, 50, 100],
        searching: true,
        info: true,
        autoWidth: false,
        order: ${JSON.stringify(order)},
        columnDefs: [{ type: 'num', targets: ${JSON.stringify(numeric)} }]
      });
      var wrap = document.createElement('div');
      wrap.className = 'artizen-table-scroll';
      var container = table.closest('.dt-container') || table;
      container.parentNode.insertBefore(wrap, container);
      wrap.appendChild(container);
    });
  </script>`;
}

export function boardEmpty(data: Leaderboard): boolean {
  return Boolean(data.error && data.projects.length === 0 && data.funds.length === 0);
}

export function pageTitle(data: Leaderboard): string {
  return data.season ? `Artizen · ${data.season.title}` : 'Artizen';
}

export function seasonQuery(season?: string | null): string {
  return season ? `?season=${encodeURIComponent(season)}` : '';
}

export function board(data: Leaderboard, tab: 'projects' | 'funds' | 'drives', seasonParam: string | null): string {
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
  const error = boardEmpty(data);
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
      <p class="text-muted mb-2">
        Data from <a href="https://artizen.fund/" target="_blank" rel="noopener">artizen.fund</a>${raised}
      </p>
      <form method="get" class="d-flex align-items-center gap-2">
        <label for="artizen-season" class="mb-0">Season</label>
        <select name="season" id="artizen-season" class="form-select w-auto" onchange="this.form.submit()">${options}</select>
      </form>
    </div>
    ${alert}
    ${tabs}
  `;
}

export function chevron(open: boolean, hasKids: boolean): string {
  if (!hasKids) return '<span class="artizen-tree-toggle"></span>';
  return `<a href="#" class="artizen-tree-toggle" aria-expanded="${open}"><i class="bi ${open ? 'bi-chevron-down' : 'bi-chevron-right'}"></i></a>`;
}

export function treeHidden(open: boolean): string {
  return open ? '' : ' artizen-tree-hidden';
}

export function driveBadges(drive: { multiple?: number | null; active?: boolean | null }): string {
  const multiple = drive.multiple
    ? ` <span class="badge text-bg-primary">${Math.trunc(Number(drive.multiple))}x</span>`
    : '';
  const current = drive.active ? ' <span class="badge text-bg-primary">current</span>' : '';
  return `${multiple}${current}`;
}

export function sumField<T>(rows: T[], field: keyof T): number {
  return rows.reduce((n, row) => n + (Number(row[field]) || 0), 0);
}

export function renderNotFound(): string {
  return layout({
    title: 'Not found',
    body: '<p>Not found.</p><p><a href="/projects">Artizen leaderboards</a></p>',
  });
}
