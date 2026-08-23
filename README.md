# artizen.fyi

Created by [Stephen Reid](https://stephenreid.net/)

Public leaderboards and private, on-device fund matching for [artizen.fund](https://artizen.fund/), running on Cloudflare. [artizen.fyi](https://artizen.fyi) is the canonical deployment.

## Infra

artizen.fyi is a Worker plus KV. No D1, R2, Queues, Durable Objects, or Pages.

- **Worker** — HTML routes, static browser assets, Bubble API crawler, hourly cron
- **KV** — JSON cache (`artizen/leaderboard/…`, `artizen/project/…`, `artizen/fund/…`, `artizen/boosts/…`, `artizen/matching/v1`, `artizen/matching/v2`)

It runs on Workers Paid so a season rebuild has enough CPU (free is 10 ms) and the hourly cron can run up to 15 minutes. Cron refreshes every season and remaining boosts, then drops project/fund pages so they rebuild on next visit. On artizen.fyi, GET `/projects`, `/funds`, `/drives`, and `/boosts` only read KV — they never crawl Bubble.

artizen.fyi is the apex; `www` 301s there.

## Local development

PRs are welcome. Work against a local Worker:

```bash
npm install
npm run dev          # local Worker + local KV
npm run check        # types, unit tests, and browser bundle budgets
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

## Fund matching

`/match` accepts an existing project or a private, freeform description. Project detail pages use the same matcher in a Fund alignment panel. The browser fetches a fixed, versioned public catalog from `/match/index.v2.json`, then performs all ranking in a Web Worker. Freeform text and embeddings are kept in memory and are never added to a URL, persisted, or sent to a server or external service.

The V2 ranker uses only official fund language, reviewed project-agnostic facets, and distinctive core concepts. Historical relationships, availability, and activity are display context only and never affect rank or score. The primary list contains up to seven strong or good matches; the full catalog remains available separately. Results describe thematic fit, not eligibility, open applications, geography, or deadlines.

An optional “Improve with local AI” action lazy-loads the pinned `mixedbread-ai/mxbai-embed-xsmall-v1` INT8 model and scores the complete catalog in the same Worker. Model and fund-vector assets are self-hosted and cached; the deterministic matcher stays available if loading or inference fails. Generate the pinned assets with `npm run prepare:semantic` followed by `npm run build:semantic-vectors -- path/to/match-index.v2.json`.

The hourly cron validates and atomically replaces the matching index. A failed build leaves the previous valid index in KV. It rejects empty catalogs, incomplete pagination, invalid hashes, and unexplained record-count drops over 20%. Checked-in ontology and fund vocabulary corrections live under `src/matching/` and must not encode project-specific rules or eligibility claims.

To inspect, benchmark, or run the human-label evaluation harness against an exported index:

```bash
npm run inspect:matching:v2 -- path/to/match-index.json "Green Goods"
npm run benchmark:matching:v2 -- path/to/match-index.json
npm run evaluate:matching:v2 -- path/to/review-export.json path/to/match-index.json
npm run qa:match -- path/to/match-index.json 8790
```

The local-only `/match/review` route supports blind 0–3 judgments, deliberate JSON import/export, a deterministic tuning/holdout split, and evidence reveal only after rating. It visibly identifies fixture indexes. Production rejects fixtures. Generated browser bundles are checked against the 60 KB gzip base-client budget and Cloudflare’s 25 MiB per-asset limit during `npm run build:client`.

## Routes

| Path | Page |
| --- | --- |
| `/` | redirect to `/projects` (keeps `?season=`) |
| `/projects`, `/funds`, `/drives` | season leaderboards (`?season=` optional) |
| `/boosts` | remaining boosts + top 100 holders |
| `/search` | project/fund search (`?q=`) |
| `/match` | private, client-side fund matching |
| `/match/review` | blind relevance review, local QA server only |
| `/match/index.json` | V1 matching catalog kept during parallel rollout |
| `/match/index.v2.json` | V2 fit-driven matching catalog |
| `/projects/:slug`, `/funds/:slug` | detail |
| `/index/p/:slug`, `/index/mf/:slug` | 301 to the matching detail page (artizen.fund path) |
