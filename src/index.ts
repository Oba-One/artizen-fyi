import { Artizen, type FundPage, type ProjectPage } from './artizen';
import type { MatchIndex } from './artizen/types';
import faviconIco from './favicon.ico';
import faviconSvg from './favicon.svg';
import appleTouchIcon from './apple-touch-icon.png';
import ogImage from './og.png';
import {
  renderBoosts,
  renderDetailPlaceholder,
  renderDrives,
  renderFund,
  renderFunds,
  renderMatch,
  renderMatchReview,
  renderNotFound,
  renderPlay,
  renderProject,
  renderProjects,
  renderSearch,
} from './html';

const BOARDS = {
  '/projects': renderProjects,
  '/funds': renderFunds,
  '/drives': renderDrives,
} as const;

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function matchingUnavailable(): Response {
  return new Response(JSON.stringify({ error: 'matching_index_unavailable' }), {
    status: 503,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '300',
    },
  });
}

/** Fixture catalogs exist for local QA only; serving them publicly would look like real advice. */
async function servableMatchIndex(artizen: Artizen, url: URL): Promise<MatchIndex | null> {
  const index = await artizen.matchIndex();
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return index && !(index.source.kind === 'fixture' && !local) ? index : null;
}

/**
 * `variant` keeps the three matching payloads from sharing an ETag. They are all derived from one
 * index version, so without it a 304 for the core document would satisfy a request for the
 * projects document from any cache that keys only on the validator.
 */
function matchingJson(request: Request, indexVersion: string, variant: string, body: () => unknown): Response {
  const etag = `"${indexVersion}-${variant}"`;
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=300, stale-while-revalidate=86400',
    etag,
  };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(JSON.stringify(body()), { headers });
}

async function matchingIndexResponse(artizen: Artizen, request: Request, url: URL): Promise<Response> {
  const index = await servableMatchIndex(artizen, url);
  if (!index) return matchingUnavailable();
  const etag = `"${index.indexVersion}"`;
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=300, stale-while-revalidate=86400',
    etag,
  };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(JSON.stringify(index), { headers });
}

/**
 * The catalog split into what each page actually needs.
 *
 * The combined document is 3 MB, and roughly half of it is relationship rows for other people's
 * projects - a browser matching one project reads sixteen of nine thousand. Funds, facets, and
 * scoring are all a first paint needs; the project list is fetched when the picker opens, and a
 * project page fetches its own record alone.
 */
async function matchingCoreResponse(artizen: Artizen, request: Request, url: URL): Promise<Response> {
  const index = await servableMatchIndex(artizen, url);
  if (!index) return matchingUnavailable();
  return matchingJson(request, index.indexVersion, 'core', () => ({
    ...index,
    projects: [],
    relationships: [],
  }));
}

async function matchingProjectsResponse(artizen: Artizen, request: Request, url: URL): Promise<Response> {
  const index = await servableMatchIndex(artizen, url);
  if (!index) return matchingUnavailable();
  return matchingJson(request, index.indexVersion, 'projects', () => ({
    indexVersion: index.indexVersion,
    projects: index.projects,
  }));
}

async function matchingProjectResponse(artizen: Artizen, request: Request, url: URL, slug: string): Promise<Response> {
  const index = await servableMatchIndex(artizen, url);
  if (!index) return matchingUnavailable();
  const project = index.projects.find((candidate) => candidate.slug === slug || candidate.id === slug);
  if (!project) {
    return new Response(JSON.stringify({ error: 'matching_project_not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' },
    });
  }
  // The variant is a fixed word, not the slug: slugs are catalog text, and one carrying a quote or
  // a percent-encoded newline would either malform the ETag or make the Headers constructor throw.
  // Two projects sharing a validator is harmless anyway - caches key on the URL, which differs.
  return matchingJson(request, index.indexVersion, 'project', () => ({
    indexVersion: index.indexVersion,
    projects: [project],
  }));
}

function detail<T>(data: T | null, render: (data: T) => string): Response {
  return data ? html(render(data)) : html(renderNotFound(), 404);
}

type DetailKind = 'project' | 'fund';

function renderDetail(kind: DetailKind, data: ProjectPage | FundPage): string {
  return kind === 'fund' ? renderFund(data as FundPage) : renderProject(data as ProjectPage);
}

async function detailPage(artizen: Artizen, kind: DetailKind, slug: string, request: Request, url: URL): Promise<Response> {
  const refresh = url.searchParams.has('refresh');
  const cached = await artizen.peek(kind, slug);
  if (cached && !refresh) return html(renderDetail(kind, cached));
  if (url.searchParams.has('content') || request.headers.get('sec-fetch-mode') !== 'navigate') {
    return detail(await artizen.load(kind, slug, refresh), (data) => renderDetail(kind, data));
  }
  const preview = cached
    ? {
        name: cached.name,
        lead: kind === 'fund' ? (cached as FundPage).subtitle : (cached as ProjectPage).logline,
        created_at: kind === 'fund' ? (cached as FundPage).created_at : undefined,
      }
    : await artizen.listedPreview(kind, slug);
  return html(renderDetailPlaceholder(kind, slug, preview));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === 'www.artizen.fyi') {
      url.hostname = 'artizen.fyi';
      return Response.redirect(url.toString(), 301);
    }
    const path = url.pathname;
    const fundAlias = path.match(/^\/index\/(p|mf)\/([^/]+)\/?$/);
    if (request.method === 'GET' && fundAlias) {
      url.pathname = `/${fundAlias[1] === 'mf' ? 'funds' : 'projects'}/${fundAlias[2]}`;
      return Response.redirect(url.toString(), 301);
    }
    const season = url.searchParams.get('season');
    const asset = request.method === 'GET' || request.method === 'HEAD';

    if (asset && path === '/favicon.svg') {
      return new Response(faviconSvg, {
        headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=604800' },
      });
    }
    if (asset && path === '/favicon.ico') {
      return new Response(faviconIco, {
        headers: { 'content-type': 'image/x-icon', 'cache-control': 'public, max-age=604800' },
      });
    }
    if (asset && path === '/apple-touch-icon.png') {
      return new Response(appleTouchIcon, {
        headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' },
      });
    }
    if (asset && path === '/og.png') {
      return new Response(ogImage, {
        headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' },
      });
    }

    const artizen = new Artizen(env.CACHE, url.hostname === 'localhost');

    if (request.method === 'GET' && path === '/') {
      const location = season ? `/projects?season=${encodeURIComponent(season)}` : '/projects';
      return Response.redirect(new URL(location, url).toString(), 302);
    }

    if (request.method === 'GET' && path === '/search') {
      const q = url.searchParams.get('q') || '';
      return html(renderSearch(await artizen.leaderboard(season), q, season));
    }

    if (request.method === 'GET' && path === '/match') {
      return html(renderMatch());
    }

    if (request.method === 'GET' && path === '/match/review') {
      const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      return local ? html(renderMatchReview()) : html(renderNotFound(), 404);
    }

    if (request.method === 'GET' && path === '/match/index.json') {
      return matchingIndexResponse(artizen, request, url);
    }

    if (request.method === 'GET' && path === '/match/core.json') {
      return matchingCoreResponse(artizen, request, url);
    }

    if (request.method === 'GET' && path === '/match/projects.json') {
      return matchingProjectsResponse(artizen, request, url);
    }

    const matchProject = path.match(/^\/match\/project\/(.+)\.json$/);
    if (request.method === 'GET' && matchProject) {
      return matchingProjectResponse(artizen, request, url, decodeURIComponent(matchProject[1]));
    }

    if (request.method === 'GET' && path === '/boosts') {
      return html(renderBoosts(await artizen.boosts()));
    }

    if (request.method === 'GET' && path === '/strategies') {
      return html(renderPlay(await artizen.leaderboard(season), season));
    }

    if (request.method === 'GET' && path in BOARDS) {
      const render = BOARDS[path as keyof typeof BOARDS];
      return html(render(await artizen.leaderboard(season), season));
    }

    const page = path.match(/^\/(projects|funds)\/([^/]+)$/);
    if (request.method === 'GET' && page) {
      const kind: DetailKind = page[1] === 'funds' ? 'fund' : 'project';
      return detailPage(artizen, kind, decodeURIComponent(page[2]), request, url);
    }

    return html(renderNotFound(), 404);
  },

  async scheduled(_event: ScheduledEvent, env: Env) {
    await new Artizen(env.CACHE).refreshCache();
  },
};
