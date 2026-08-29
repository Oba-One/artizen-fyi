import type {
  BoostDirection,
  BoostHolder,
  BoostHolderPage,
  BoostSort,
  BoostsSummary,
} from '../artizen';
import { compactNum, delimited } from '../format';
import { escapeHtml, layout, panel } from './layout';

export type BoostsView = {
  q?: string;
  page?: number;
  sort?: BoostSort;
  dir?: BoostDirection;
  results?: BoostHolderPage | null;
};

function pct(share: number): string {
  const p = share * 100;
  if (p >= 10) return `${p.toFixed(1)}%`;
  if (p >= 1) return `${p.toFixed(2)}%`;
  return `${p.toFixed(3)}%`;
}

function stat(label: string, value: string, hint?: string): string {
  const title = hint ? ` title="${escapeHtml(hint)}"` : '';
  return `<div class="artizen-stat"${title}><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

export function renderBoostHolderRows(holders: BoostHolder[]): string {
  if (holders.length === 0) return '<tr><td colspan="4" class="artizen-boost-empty">No matching holders</td></tr>';
  return holders
    .map((holder) => {
      const avatar = holder.image
        ? `<img class="artizen-holder-avatar" src="${escapeHtml(holder.image)}" alt="" loading="lazy">`
        : '<span class="artizen-holder-avatar artizen-holder-avatar-empty" aria-hidden="true"></span>';
      const admin = holder.admin ? ' <span class="badge text-bg-secondary artizen-badge-sm">admin</span>' : '';
      return `<tr>
        <td>
          <span class="artizen-holder"><span class="artizen-holder-rank">#${holder.rank}</span>${avatar}<strong>${escapeHtml(holder.name)}</strong>${admin}</span>
        </td>
        <td class="text-end">${delimited(holder.points)}</td>
        <td class="text-end">${pct(holder.share)}</td>
        <td class="text-end">${pct(holder.cumulative)}</td>
      </tr>`;
    })
    .join('');
}

function boostsHref(view: Required<Pick<BoostsView, 'q' | 'page' | 'sort' | 'dir'>>): string {
  const params = new URLSearchParams();
  if (view.q) params.set('q', view.q);
  if (view.page > 1) params.set('page', String(view.page));
  if (view.sort !== 'boosts') params.set('sort', view.sort);
  if (view.dir !== 'desc') params.set('dir', view.dir);
  const query = params.toString();
  return query ? `/boosts?${query}` : '/boosts';
}

function sortHeader(
  label: string,
  column: BoostSort,
  view: Required<Pick<BoostsView, 'q' | 'sort' | 'dir'>>,
  numeric = false,
): string {
  const active = view.sort === column;
  const nextDir: BoostDirection = active && view.dir === 'desc' ? 'asc' : 'desc';
  const dir = active ? nextDir : column === 'name' ? 'asc' : 'desc';
  const href = boostsHref({ q: view.q, page: 1, sort: column, dir });
  const ariaSort = active ? ` aria-sort="${view.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
  const direction = active ? dir : column === 'name' ? 'ascending' : 'descending';
  return `<th${numeric ? ' class="text-end"' : ''}${ariaSort}><a class="artizen-boost-sort" href="${escapeHtml(href)}" aria-label="Sort by ${escapeHtml(label)}, ${direction}">${escapeHtml(label)}${active ? `<span aria-hidden="true">${view.dir === 'asc' ? ' ↑' : ' ↓'}</span>` : ''}</a></th>`;
}

function holderStatus(offset: number, count: number, total: number, searched: boolean): string {
  if (total === 0) return searched ? 'No matching holders' : 'No holders';
  const noun = searched ? 'matching holders' : 'holders';
  return `Showing ${delimited(offset + 1)}–${delimited(offset + count)} of ${delimited(total)} ${noun}`;
}

const BOOSTS_SCRIPT = `
<script>
(function() {
  var section = document.getElementById('artizen-boost-results');
  if (!section || !section.dataset.snapshot) return;
  var form = document.getElementById('artizen-boost-search');
  var input = document.getElementById('artizen-holder-q');
  var table = document.getElementById('artizen-boosts-table');
  var body = table && table.tBodies[0];
  var status = document.getElementById('artizen-boost-status');
  var more = document.getElementById('artizen-boost-more');
  var error = document.getElementById('artizen-boost-error');
  var retry = document.getElementById('artizen-boost-retry');
  if (!form || !input || !body || !status || !more || !error || !retry) return;

  var controller = null;
  var timer = 0;
  var composing = false;
  var lastAction = null;
  var number = new Intl.NumberFormat('en-US');

  function percent(value) {
    var p = Number(value) * 100;
    if (p >= 10) return p.toFixed(1) + '%';
    if (p >= 1) return p.toFixed(2) + '%';
    return p.toFixed(3) + '%';
  }

  function cell(text, numeric) {
    var td = document.createElement('td');
    if (numeric) td.className = 'text-end';
    td.textContent = text;
    return td;
  }

  function holderRow(holder) {
    var tr = document.createElement('tr');
    var nameCell = document.createElement('td');
    var wrap = document.createElement('span');
    wrap.className = 'artizen-holder';
    var rank = document.createElement('span');
    rank.className = 'artizen-holder-rank';
    rank.textContent = '#' + holder.rank;
    wrap.appendChild(rank);
    if (holder.image) {
      var image = document.createElement('img');
      image.className = 'artizen-holder-avatar';
      image.src = holder.image;
      image.alt = '';
      image.loading = 'lazy';
      wrap.appendChild(image);
    } else {
      var empty = document.createElement('span');
      empty.className = 'artizen-holder-avatar artizen-holder-avatar-empty';
      empty.setAttribute('aria-hidden', 'true');
      wrap.appendChild(empty);
    }
    var strong = document.createElement('strong');
    strong.textContent = holder.name;
    wrap.appendChild(strong);
    if (holder.admin) {
      var badge = document.createElement('span');
      badge.className = 'badge text-bg-secondary artizen-badge-sm';
      badge.textContent = 'admin';
      wrap.appendChild(badge);
    }
    nameCell.appendChild(wrap);
    tr.appendChild(nameCell);
    tr.appendChild(cell(number.format(holder.points), true));
    tr.appendChild(cell(percent(holder.share), true));
    tr.appendChild(cell(percent(holder.cumulative), true));
    return tr;
  }

  function emptyRow() {
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'artizen-boost-empty';
    td.textContent = 'No matching holders';
    tr.appendChild(td);
    return tr;
  }

  function pageUrl(query) {
    var url = new URL('/boosts', location.origin);
    if (query) url.searchParams.set('q', query);
    if (section.dataset.sort !== 'boosts') url.searchParams.set('sort', section.dataset.sort);
    if (section.dataset.dir !== 'desc') url.searchParams.set('dir', section.dataset.dir);
    return url;
  }

  function setBusy(busy) {
    section.setAttribute('aria-busy', busy ? 'true' : 'false');
    more.setAttribute('aria-disabled', busy ? 'true' : 'false');
    if (busy) more.textContent = 'Loading…';
  }

  function showError(message) {
    error.hidden = false;
    error.querySelector('span').textContent = message;
    more.textContent = 'Show 100 more';
  }

  function clearError() {
    error.hidden = true;
  }

  function updateMore(data, query) {
    more.hidden = !data.hasMore;
    more.textContent = 'Show 100 more';
    if (data.hasMore) {
      var next = pageUrl(query);
      next.searchParams.set('page', String(Math.floor((data.offset + data.holders.length) / data.limit) + 1));
      more.href = next.pathname + next.search;
    }
  }

  function apply(data, append, query, refreshed) {
    if (!append) body.replaceChildren();
    if (!append && data.holders.length === 0) body.appendChild(emptyRow());
    data.holders.forEach(function(holder) { body.appendChild(holderRow(holder)); });
    var start = append ? Number(section.dataset.start || 0) : data.offset;
    var end = data.offset + data.holders.length;
    section.dataset.start = String(start);
    section.dataset.nextOffset = String(end);
    section.dataset.snapshot = data.snapshot;
    section.dataset.total = String(data.total);
    var noun = query ? ' matching holders' : ' holders';
    status.textContent = data.total === 0
      ? (query ? 'No matching holders' : 'No holders')
      : 'Showing ' + number.format(start + 1) + '–' + number.format(end) + ' of ' + number.format(data.total) + noun;
    if (refreshed) status.textContent = 'Boost data refreshed. ' + status.textContent;
    document.querySelectorAll('.artizen-boost-sort').forEach(function(link) {
      var href = new URL(link.href, location.href);
      if (query) href.searchParams.set('q', query);
      else href.searchParams.delete('q');
      link.href = href.pathname + href.search;
    });
    updateMore(data, query);
  }

  async function load(append, useSnapshot, refreshed) {
    if (controller) controller.abort();
    var requestController = new AbortController();
    controller = requestController;
    var query = input.value.trim().slice(0, 100);
    var offset = append ? Number(section.dataset.nextOffset || 0) : 0;
    var url = new URL('/boosts/holders.json', location.origin);
    if (useSnapshot && section.dataset.snapshot) url.searchParams.set('snapshot', section.dataset.snapshot);
    if (query) url.searchParams.set('q', query);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', '100');
    url.searchParams.set('sort', section.dataset.sort);
    url.searchParams.set('dir', section.dataset.dir);
    lastAction = function() { load(append, useSnapshot, refreshed); };
    clearError();
    setBusy(true);
    try {
      var response = await fetch(url, { headers: { accept: 'application/json' }, signal: requestController.signal });
      if (response.status === 410 && useSnapshot) return load(false, false, true);
      if (!response.ok) throw new Error('request failed');
      var data = await response.json();
      apply(data, append, query, refreshed);
      if (!append) {
        var nextUrl = pageUrl(query);
        if (location.pathname + location.search !== nextUrl.pathname + nextUrl.search) {
          history.pushState(null, '', nextUrl);
        }
      }
    } catch (cause) {
      if (cause && cause.name === 'AbortError') return;
      showError('Could not load holders.');
    } finally {
      if (controller === requestController) {
        setBusy(false);
        controller = null;
      }
    }
  }

  function search() {
    window.clearTimeout(timer);
    timer = window.setTimeout(function() { load(false, true, false); }, 250);
  }

  input.addEventListener('compositionstart', function() { composing = true; });
  input.addEventListener('compositionend', function() { composing = false; search(); });
  input.addEventListener('input', function() { if (!composing) search(); });
  form.addEventListener('submit', function(event) {
    event.preventDefault();
    window.clearTimeout(timer);
    load(false, true, false);
  });
  more.addEventListener('click', function(event) {
    if (more.getAttribute('aria-disabled') === 'true') return event.preventDefault();
    event.preventDefault();
    load(true, true, false);
  });
  retry.addEventListener('click', function() { if (lastAction) lastAction(); });
  if (!error.hidden) lastAction = function() { load(false, true, false); };
  window.addEventListener('popstate', function() { location.reload(); });
})();
</script>`;

export function renderBoosts(boosts: BoostsSummary, requested: BoostsView = {}): string {
  const failed = boosts.error && boosts.top.length === 0;
  if (failed) {
    return layout({
      title: 'Boosts · artizen.fyi',
      body: panel(
        `<h1>Boosts</h1>
        <p class="mb-0">Could not load remaining boosts. Try again later or visit
          <a href="https://artizen.fund" target="_blank" rel="noopener">artizen.fund</a> directly.</p>`,
      ),
      boosts: true,
    });
  }

  const view = {
    q: (requested.q ?? '').slice(0, 100),
    page: Math.max(1, Math.trunc(requested.page ?? 1)),
    sort: requested.sort ?? ('boosts' as BoostSort),
    dir: requested.dir ?? ('desc' as BoostDirection),
  };
  const registryAvailable = Boolean(boosts.snapshot);
  const fallback: BoostHolderPage = {
    snapshot: boosts.snapshot ?? '',
    updatedAt: boosts.updated_at,
    total: boosts.holders,
    offset: 0,
    limit: 100,
    hasMore: registryAvailable && boosts.top.length < boosts.holders,
    holders: boosts.top,
  };
  const registryError = requested.results === null;
  const results = registryError
    ? { ...fallback, offset: (view.page - 1) * 100, total: 0, hasMore: false, holders: [] }
    : requested.results ?? fallback;
  const rows = renderBoostHolderRows(results.holders);
  const dist = boosts.buckets
    .map((bucket) => {
      const share = boosts.remaining > 0 ? bucket.points / boosts.remaining : 0;
      return `<tr>
        <td>${escapeHtml(bucket.label)}</td>
        <td class="text-end">${delimited(bucket.users)}</td>
        <td class="text-end">${delimited(bucket.points)}</td>
        <td class="artizen-boost-bar-cell">
          <span class="artizen-bar" title="${pct(share)} of remaining"><span style="width:${(share * 100).toFixed(2)}%"></span></span>
        </td>
      </tr>`;
    })
    .join('');
  const stats = `
    <div class="artizen-stat-row artizen-stat-row-boosts mb-3">
      ${stat('Remaining', delimited(boosts.remaining), `${compactNum(boosts.remaining)} unspent boosts`)}
      ${stat('Holders', delimited(boosts.holders), `${delimited(boosts.accounts)} accounts, ${delimited(boosts.zero)} empty`)}
      ${stat('Median', delimited(boosts.median))}
      ${stat('Mean', compactNum(boosts.mean))}
      ${stat('Top 100', pct(boosts.top_share), `${delimited(boosts.top_points)} of remaining`)}
    </div>`;
  const search = registryAvailable
    ? `<form id="artizen-boost-search" class="artizen-boost-search" method="get" action="/boosts" role="search">
        <label for="artizen-holder-q" class="visually-hidden">Search holders</label>
        <span class="artizen-boost-search-field"><i class="bi bi-search" aria-hidden="true"></i><input id="artizen-holder-q" name="q" type="search" maxlength="100" value="${escapeHtml(view.q)}" placeholder="Search holders" autocomplete="off"></span>
        <input type="hidden" name="sort" value="${escapeHtml(view.sort)}">
        <input type="hidden" name="dir" value="${escapeHtml(view.dir)}">
        <button class="btn btn-outline-dark" type="submit">Search</button>
      </form>`
    : '';
  const headers = registryAvailable
    ? `${sortHeader('Holder', 'name', view)}${sortHeader('Boosts', 'boosts', view, true)}${sortHeader('Share', 'share', view, true)}${sortHeader('Cumulative', 'cumulative', view, true)}`
    : '<th>Holder</th><th class="text-end">Boosts</th><th class="text-end">Share</th><th class="text-end">Cumulative</th>';
  const nextHref = boostsHref({ ...view, page: view.page + 1 });
  const more = registryAvailable && results.hasMore
    ? `<a id="artizen-boost-more" class="btn btn-outline-dark" href="${escapeHtml(nextHref)}">Show 100 more</a>`
    : '<a id="artizen-boost-more" class="btn btn-outline-dark" href="/boosts" hidden>Show 100 more</a>';
  const status = holderStatus(results.offset, results.holders.length, results.total, Boolean(view.q));
  const holderTable = `
    <section id="artizen-boost-results" class="artizen-boost-results" data-snapshot="${escapeHtml(results.snapshot)}" data-start="${results.offset}" data-next-offset="${results.offset + results.holders.length}" data-total="${results.total}" data-sort="${escapeHtml(view.sort)}" data-dir="${escapeHtml(view.dir)}">
      ${search}
      <p id="artizen-boost-status" class="artizen-boost-status" role="status" aria-live="polite">${escapeHtml(status)}</p>
      <div class="artizen-table-scroll">
        <table id="artizen-boosts-table" class="table table-sm">
          <thead><tr>${headers}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="artizen-boost-actions">
        ${more}
        <p id="artizen-boost-error" class="artizen-boost-error" role="alert"${registryError ? '' : ' hidden'}><span>Could not load holders.</span> <button id="artizen-boost-retry" class="btn btn-link" type="button">Retry</button></p>
      </div>
    </section>`;
  const body = panel(`
    <h1>Boosts</h1>
    ${stats}
    <div class="artizen-nested mb-3">
      <h2 class="artizen-panel-title">Distribution</h2>
      <div class="artizen-table-scroll">
        <table class="table table-sm mb-0 artizen-boost-dist">
          <thead><tr><th>Balance</th><th class="text-end">Users</th><th class="text-end">Boosts</th><th></th></tr></thead>
          <tbody>${dist}</tbody>
        </table>
      </div>
    </div>
    ${holderTable}`);

  return layout({
    title: 'Boosts · artizen.fyi',
    description: 'Unspent Artizen boosts: remaining supply and holder registry',
    body,
    extra: registryAvailable ? BOOSTS_SCRIPT : undefined,
    boosts: true,
    robots: view.q || view.page > 1 ? 'noindex,follow' : undefined,
  });
}
