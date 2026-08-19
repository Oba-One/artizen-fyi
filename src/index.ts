import { Artizen } from './artizen';
import {
  renderDrives,
  renderFund,
  renderFunds,
  renderNotFound,
  renderProject,
  renderProjects,
} from './html';

type Bindings = Env & { REFRESH_SECRET?: string };

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

function detail<T>(data: T | null, render: (data: T) => string): Response {
  return data ? html(render(data)) : html(renderNotFound(), 404);
}

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === 'www.artizen.fyi') {
      url.hostname = 'artizen.fyi';
      return Response.redirect(url.toString(), 301);
    }
    const path = url.pathname;
    const season = url.searchParams.get('season');
    const artizen = new Artizen(env.CACHE);

    if (request.method === 'GET' && path === '/') {
      const location = season ? `/projects?season=${encodeURIComponent(season)}` : '/projects';
      return Response.redirect(new URL(location, url).toString(), 302);
    }

    if (request.method === 'GET' && path in BOARDS) {
      const render = BOARDS[path as keyof typeof BOARDS];
      return html(render(await artizen.leaderboard(season), season));
    }

    const project = path.match(/^\/projects\/([^/]+)$/);
    if (request.method === 'GET' && project) {
      return detail(await artizen.project(decodeURIComponent(project[1])), renderProject);
    }

    const fund = path.match(/^\/funds\/([^/]+)$/);
    if (request.method === 'GET' && fund) {
      return detail(await artizen.fund(decodeURIComponent(fund[1])), renderFund);
    }

    if (request.method === 'POST' && path === '/refresh') {
      const secret = env.REFRESH_SECRET;
      if (!secret) return new Response('Not found', { status: 404 });
      const auth = request.headers.get('authorization') || '';
      if (auth !== `Bearer ${secret}`) return new Response('Unauthorized\n', { status: 401 });
      return new Response(`${await artizen.refreshCache()}\n`);
    }

    return html(renderNotFound(), 404);
  },

  async scheduled(_event: ScheduledEvent, env: Env) {
    await new Artizen(env.CACHE).refreshCache();
  },
};
