# Artizen leaderboards

Public leaderboards for [artizen.fund](https://artizen.fund/), running on Cloudflare. [artizen.fyi](https://artizen.fyi) is the only canonical deployment.

By [Stephen Reid](https://stephenreid.net/).

## Infra

Two products only:

- **Worker** — HTML routes, Bubble API crawler, hourly cron
- **KV** — JSON cache (`artizen/leaderboard/…`, `artizen/project/…`, `artizen/fund/…`)

Cron Triggers are a Worker feature, not a separate service. No D1, R2, Queues, Durable Objects, or Pages.

Workers **Paid** is required: the free plan’s 10 ms CPU cannot rebuild a season, and cron wall time is 15 minutes on paid.

## Local development

PRs are welcome. Run the Worker locally; don’t deploy a second copy.

```bash
npm install
npm run dev          # local Worker + local KV
```

The first `/projects` hit with an empty cache crawls Bubble and can take ~40s. After that, pages read KV. Hourly cron refreshes every season and drops project/fund pages so they rebuild on next visit.

`REFRESH_SECRET` is set in the Worker dashboard for production. POST to `/refresh` with `Authorization: Bearer …` to rebuild without waiting for the hour.

## Routes

| Path | Page |
| --- | --- |
| `/` | redirect to `/projects` (keeps `?season=`) |
| `/projects`, `/funds`, `/drives` | season leaderboards (`?season=` optional) |
| `/search` | project/fund search (`?q=`) |
| `/projects/:slug`, `/funds/:slug` | detail |
| `POST /refresh` | cache rebuild (secret) |

Custom domains `artizen.fyi` and `www.artizen.fyi` are in `wrangler.jsonc`. `www` 301s to the apex.
