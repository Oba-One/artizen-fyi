# Artizen leaderboards

Public leaderboards for [artizen.fund](https://artizen.fund/), running on Cloudflare.

## Infra

Two products only:

- **Worker** — HTML routes, Bubble API crawler, hourly cron
- **KV** — JSON cache (`artizen/leaderboard/…`, `artizen/project/…`, `artizen/fund/…`)

Cron Triggers are a Worker feature, not a separate service. No D1, R2, Queues, Durable Objects, or Pages.

Workers **Paid** is required: the free plan’s 10 ms CPU cannot rebuild a season, and cron wall time is 15 minutes on paid.

## Setup

```bash
npm install
npx wrangler login
npx wrangler kv namespace create CACHE
```

Paste the printed id into `wrangler.jsonc` → `kv_namespaces[0].id`.

```bash
npx wrangler deploy
```

Optional: set `REFRESH_SECRET` in the Worker dashboard (or `npx wrangler secret put REFRESH_SECRET`) and POST to `/refresh` with `Authorization: Bearer …` to rebuild without waiting for the hour.

```bash
npm run dev          # local Worker + local KV
```

The first `/projects` hit with an empty cache crawls Bubble and can take ~40s. After that, pages read KV. Hourly cron refreshes every season and drops project/fund pages so they rebuild on next visit.

## Routes

| Path | Page |
| --- | --- |
| `/` | redirect to `/projects` |
| `/projects`, `/funds`, `/drives` | season leaderboards |
| `/projects/:slug`, `/funds/:slug` | detail |
| `POST /refresh` | cache rebuild (secret) |
