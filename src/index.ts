import { Hono } from 'hono';
import { Artizen } from './artizen';
import { renderDrives, renderFund, renderFunds, renderNotFound, renderProject, renderProjects } from './html';

const app = new Hono<{ Bindings: Env & { REFRESH_SECRET?: string } }>();

const BOT_UA =
  /bot|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|linkedinbot|twitterbot|whatsapp|telegrambot|discordbot|ia_archiver|bytespider|gptbot|claudebot|semrush|ahrefs|petalbot/i;

app.use('*', async (c, next) => {
  const ua = c.req.header('user-agent') || '';
  if (BOT_UA.test(ua)) {
    return c.text('Forbidden\n', 403, { 'Cache-Control': 'public, max-age=86400' });
  }
  await next();
});

app.get('/', (c) => {
  const season = c.req.query('season');
  return c.redirect(season ? `/projects?season=${encodeURIComponent(season)}` : '/projects');
});

app.get('/projects', async (c) => {
  const season = c.req.query('season') ?? null;
  const data = await new Artizen(c.env.CACHE).leaderboard(season);
  return c.html(renderProjects(data, season));
});

app.get('/funds', async (c) => {
  const season = c.req.query('season') ?? null;
  const data = await new Artizen(c.env.CACHE).leaderboard(season);
  return c.html(renderFunds(data, season));
});

app.get('/drives', async (c) => {
  const season = c.req.query('season') ?? null;
  const data = await new Artizen(c.env.CACHE).leaderboard(season);
  return c.html(renderDrives(data, season));
});

app.get('/projects/:slug', async (c) => {
  const artizen = new Artizen(c.env.CACHE);
  const project = await artizen.project(c.req.param('slug'));
  if (!project) return c.html(renderNotFound(), 404);
  return c.html(renderProject(project, artizen));
});

app.get('/funds/:slug', async (c) => {
  const artizen = new Artizen(c.env.CACHE);
  const fund = await artizen.fund(c.req.param('slug'));
  if (!fund) return c.html(renderNotFound(), 404);
  return c.html(renderFund(fund, artizen));
});

app.post('/refresh', async (c) => {
  const secret = c.env.REFRESH_SECRET;
  if (!secret) return c.notFound();
  const auth = c.req.header('authorization') || '';
  if (auth !== `Bearer ${secret}`) return c.text('Unauthorized\n', 401);
  const summary = await new Artizen(c.env.CACHE).refreshCache();
  return c.text(`${summary}\n`);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(new Artizen(env.CACHE).refreshCache());
  },
};
