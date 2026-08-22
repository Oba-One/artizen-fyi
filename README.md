# artizen.fyi

Created by [Stephen Reid](https://stephenreid.net/)

Public leaderboards for [artizen.fund](https://artizen.fund/), running on Cloudflare. [artizen.fyi](https://artizen.fyi) is the canonical deployment.

## Infra

artizen.fyi is a Worker plus KV. No D1, R2, Queues, Durable Objects, or Pages.

- **Worker** — HTML routes, Bubble API crawler, hourly cron
- **KV** — JSON cache (`artizen/leaderboard/…`, `artizen/project/…`, `artizen/fund/…`, `artizen/boosts/…`)

It runs on Workers Paid so a season rebuild has enough CPU (free is 10 ms) and the hourly cron can run up to 15 minutes. Cron refreshes every season and remaining boosts, then drops project/fund pages so they rebuild on next visit. On artizen.fyi, GET `/projects`, `/funds`, `/drives`, and `/boosts` only read KV — they never crawl Bubble.

artizen.fyi is the apex; `www` 301s there.

## Local development

PRs are welcome. Work against a local Worker:

```bash
npm install
npm run dev          # local Worker + local KV
```

Wipe local KV (Wrangler persist) with `rm -rf .wrangler/state`, then restart `npm run dev`. The next page load recrawls Bubble (~30–60s). After that, pages read KV. On artizen.fyi those list pages never crawl; they wait for cron. A project or fund detail with no stash still crawls that one page.

Local cron (writes local KV):

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

Production cron (writes the live CACHE namespace). Uses 8788 so `npm run dev` can stay on 8787:

```bash
npx wrangler dev --env cron --port 8788
```

Then in another terminal:

```bash
curl "http://localhost:8788/cdn-cgi/local/scheduled"
```

A full run crawls every season and can take several minutes. Watch the Wrangler log for `[Artizen] refreshed`.

## Routes

| Path | Page |
| --- | --- |
| `/` | redirect to `/projects` (keeps `?season=`) |
| `/projects`, `/funds`, `/drives` | season leaderboards (`?season=` optional) |
| `/boosts` | remaining boosts + top 100 holders |
| `/search` | project/fund search (`?q=`) |
| `/projects/:slug`, `/funds/:slug` | detail |
| `/index/p/:slug`, `/index/mf/:slug` | 301 to the matching detail page (artizen.fund path) |
