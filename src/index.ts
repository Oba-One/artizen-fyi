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

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
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

    if (request.method === 'GET' && path === '/projects') {
      return html(renderProjects(await artizen.leaderboard(season), season));
    }

    if (request.method === 'GET' && path === '/funds') {
      return html(renderFunds(await artizen.leaderboard(season), season));
    }

    if (request.method === 'GET' && path === '/drives') {
      return html(renderDrives(await artizen.leaderboard(season), season));
    }

    const project = path.match(/^\/projects\/([^/]+)$/);
    if (request.method === 'GET' && project) {
      const data = await artizen.project(decodeURIComponent(project[1]));
      return data ? html(renderProject(data)) : html(renderNotFound(), 404);
    }

    const fund = path.match(/^\/funds\/([^/]+)$/);
    if (request.method === 'GET' && fund) {
      const data = await artizen.fund(decodeURIComponent(fund[1]));
      return data ? html(renderFund(data)) : html(renderNotFound(), 404);
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
