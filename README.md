# artizen.fyi

Created by [Stephen Reid](https://stephenreid.net/)

Public leaderboards and private, on-device fund matching for [artizen.fund](https://artizen.fund/), running on Cloudflare. [artizen.fyi](https://artizen.fyi) is the canonical deployment.

## Infra

artizen.fyi is a Worker plus KV. No D1, R2, Queues, Durable Objects, or Pages.

- **Worker** — HTML routes, static browser assets, Bubble API crawler, hourly cron
- **KV** — JSON cache (`artizen/leaderboard/…`, `artizen/project/…`, `artizen/fund/…`, `artizen/boosts/…`)

It runs on Workers Paid so a season rebuild has enough CPU (free is 10 ms) and the hourly cron can run up to 15 minutes. Cron refreshes every season and remaining boosts, then drops project/fund pages so they rebuild on next visit. On artizen.fyi, GET `/projects`, `/funds`, `/drives`, `/strategies`, and `/boosts` only read KV — they never crawl Bubble.

Git-push auto-deploy runs `wrangler deploy`, which rebuilds the matching catalog, vectors, and pinned model before upload (`public/` is gitignored, so a clone does not have them). That crawl takes several minutes. `wrangler dev` does not.

artizen.fyi is the apex; `www` 301s there.

## Local development

PRs are welcome. Work against a local Worker:

```bash
npm install
npm run dev          # local Worker + local KV
npm run check        # types, unit tests, and browser bundle budgets
```

Node 22 or newer — Wrangler requires it, and the index builders use the WebCrypto global that older runtimes do not expose.

To work on the on-device AI path, fetch its assets once (see [MATCHING.md](MATCHING.md)); without them the “Improve with local AI” control stays hidden. Wrangler snapshots static assets when it starts, so restart `npm run dev` after generating the model or vector files.

Leaderboard changes need a cache rebuild before they show up, because KV keeps serving the previous data:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled"
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

## Design tokens

Colours come from the [Artizen style guide](https://play.artizen.fund/style-guide/), which splits the palette in three: Brand (Algae, Moss), Interface (Night, Slate, Barracuda, Moon, Stone, Wash, UI Alert, UI Warning, UI Success), and Illustrations (Reef, Gravel, Coral, Truffle, Lavender). The UI uses Brand and Interface only. Illustration colours stay off chrome - they are for drawings. Tokens in `src/styles.css` map Night (`--ink`), Slate, Barracuda (`--muted`), Moon (`--paper`), white (`--panel`), Stone (`--line`), Algae (`--green`), and Moss (`--green-deep`). Buttons follow the guide's three roles - Primary is Slate darkening to Night, Secondary is a Slate outline filling with Moon, and both are pill-shaped at weight 500. Bootstrap's `btn-dark` and `btn-outline-dark` are retargeted onto those roles once, rather than being overridden per call site.

A fund card uses one green, `--green-ink`, for every fill that has to carry type or sit next to type that does: Strong and Good (badge and meter), Applied, Curated, and Funded. Algae on the meter and ink on the badges would be two greens on the same card. Worth a look is a wash of that ink on Moon; limited evidence is a dashed Stone outline. White type on green-ink stays at 4.5:1. Applied uses a send mark rather than a check, because a tick reads as acceptance. Available money and Not curating are Stone outlines on Moon. Curating is the default, so it is not labelled.

One value is not in the palette. `--green-ink: #06773F` exists because Algae is 2.1:1 on white and Moss is 3.0:1, both under the 4.5:1 that text needs - the style guide's own Featured button and Active badge fail this. Green that has to match readable chrome (text, badges, the fit meter) darkens to `--green-ink` and only ever to that. For the same reason a pressed filter is Slate rather than Algae: it is Artizen's Primary treatment, which is what a pressed control is, and it puts the label at 16:1 instead of 2.1:1.

## Fund matching

Private, on-device matching lives at `/match`. Catalog, ranker, on-device model, and local commands are in [MATCHING.md](MATCHING.md).

## Routes

| Path | Page |
| --- | --- |
| `/` | redirect to `/projects` (keeps `?season=`) |
| `/projects`, `/funds`, `/drives` | season leaderboards (`?season=` optional) |
| `/strategies` | three strategies, read from V/S, M/S, and P/S (`?season=` optional) |
| `/boosts` | remaining boosts + top 100 holders |
| `/search` | project/fund search (`?q=`) |
| `/match` | private, client-side fund matching |
| `/match/review` | blind relevance review, local QA server only |
| `/match/index.json` | the matching catalog, combined |
| `/match/core.json` | funds, facets, and scoring — what a first paint needs |
| `/match/projects.json` | the project list, fetched when the picker opens |
| `/match/project/:id.json` | one project record, for a project page |
| `/projects/:slug`, `/funds/:slug` | detail |
| `/index/p/:slug`, `/index/mf/:slug` | 301 to the matching detail page (artizen.fund path) |
