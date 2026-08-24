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

Node 22 or newer — Wrangler requires it, and the index builders use the WebCrypto global that older runtimes do not expose.

To work on the on-device AI path, fetch its assets once (see [Fund matching](#fund-matching)); without them the “Improve with local AI” control stays hidden.

Matching changes need a catalog rebuild before they show up, because KV keeps serving the previous index:

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

## Fund matching

`/match` accepts an existing project or a private, freeform description. Project detail pages use the same matcher in a Fund alignment panel. The browser fetches a fixed, versioned public catalog and performs all ranking in a Web Worker. Freeform text and embeddings are kept in memory and are never added to a URL, persisted, or sent to a server or external service.

The catalog is served in three pieces, because no page needs all of it. `/match/core.v3.json` carries funds, facets, and scoring — about 250 KB, and all a first paint uses. `/match/projects.v3.json` carries the project list and is fetched only when someone reaches for the picker. `/match/project/:slug.json` carries a single record, which is all a project page needs. The combined `/match/index.v2.json` is still served for the QA harness and the calibration scripts.

Each project carries its own fund history as compact `[fundId, kind]` pairs rather than the catalog shipping one flat relationship table. A browser matching one project reads sixteen rows of nine thousand, so the table was roughly half the payload and almost entirely other people's projects.

Selecting a catalog project needs no model download at all: both sides were embedded when the catalog was built, so the browser fetches the fund vectors (262 KB) plus one project shard (about 50 KB) and takes a dot product. The on-device model is still required for a freeform description, and for a catalog project whose description or tags have been edited, since neither is text that was embedded in advance.

Project and fund thumbnails are the one exception worth naming: their URLs travel inside the public catalog, but the browser loads the images themselves from Artizen's media host. That host therefore sees which cards were rendered. Nothing about the project description, the tags, or the ranking leaves the browser.

The V2 ranker uses only official fund language, reviewed project-agnostic facets, and distinctive core concepts. Historical relationships, availability, and activity are display context only and never affect rank or score. The primary list holds twelve funds - a count that divides evenly across one, two, three, and four columns, so the grid never ends on a part-filled row. Every strong or good match comes first, then the closest exploratory ones to make up the number, each carrying the badge that says which it is. The full catalog remains available separately. Results describe thematic fit, not eligibility, open applications, geography, or deadlines.

Each card carries a 0-100 fit index, mapped piecewise onto the band thresholds rather than being the raw score, so the number and the label always agree: worth a look starts at 30, good at 65, strong at 85. Raw scores top out near 0.78 in practice, which is why the display is anchored to the bands instead of shown directly. Three filters sit above the results and are named for what the catalog actually records: **Active curation** is the fund's `active` flag and is on by default, **Funds available** is a positive `Funding - current`, and **New to me** hides funds this project has already applied to, been curated in, or been funded by. Funds that are not curating are shown with a warning treatment rather than silently ranked alongside the rest. A focus chip row filters by the shared taxonomy facets, ordered by how often each appears in the current result set; funds that carry no facets never match a focus filter, and the empty state says so. A name search, a sort control, and a per-project shortlist held in `localStorage` sit alongside them, and the full catalog pages in the same twelves rather than painting 244 cards at once.

Selecting a catalog project matches immediately: scoring one is a dot product against vectors already in memory, so there is nothing for a separate submit step to buy. The submit button remains for freeform descriptions and for re-running after a refinement, and says "Update matches" only while a refinement is actually pending. The local AI control appears on the same principle - only when there is something it could improve, which means a freeform description or an edited project, never an empty form or a project whose comparison is already prepared.

Cards animate in on a fresh set of results and settle in place when an existing set is narrowed, so a keystroke in the fund search does not replay the sequence. The whole animation is a keyframe and a custom property; `prefers-reduced-motion` turns it off.

Impact tags are the single largest lever on match quality: tagged projects average 7.6 evidence-backed matches against 3.4, and 30% of untagged projects have no evidence-backed match at all. A third of the catalog carries no tags, so selecting one of those projects surfaces a prompt above the refine disclosure rather than leaving the picker buried inside it.

Editing the description or the tags takes the input off the precomputed comparison, because it is no longer the text that was embedded at build time. The results region says so and offers the two ways back: run the model on this device, or drop the refinements. When the on-device model does replace a baseline reading, cards that moved up more than two places or entered the top twelve are marked, so the download has visible evidence behind it.

Band thresholds are calibrated against the score distribution of the whole catalog, not chosen by hand:

```bash
npm run calibrate:matching:v2 -- path/to/match-index.json     # baseline ranker
npm run calibrate:semantic:v2 -- path/to/match-index.json     # with semantic scoring applied
npm run compare:match-modes  -- path/to/match-index.json      # how much the two actually differ
```

The semantic sweep exists because semantic scoring uses a different weight profile, and bands set from baseline scores alone can collapse under it. Measured across the catalog the two distributions turn out close (rank-1 medians 0.43 and 0.45), so one set of thresholds serves both.

`ScoringConfigV2` travels **inside** the index, so a threshold change in `src/matching/index-v2.ts` does nothing until the catalog is rebuilt. Production picks it up on the next hourly cron; locally, fire the cron by hand (see [Local development](#local-development)) and confirm `scoring.version` in the served `/match/index.v2.json` matches the source.

Semantic scoring comes from two paths. Choosing a project from the catalog uses **precomputed embeddings**: both sides of the comparison are known when the catalog is built, so the vectors ship as static files and the browser only takes a dot product — about 3.5 MB of vectors, no model, no WebAssembly, no inference. Freeform descriptions do not exist until someone types them, so those still need the model on the device: an optional “Improve with local AI” action lazy-loads the pinned `mixedbread-ai/mxbai-embed-xsmall-v1` INT8 model and scores the complete catalog in the same Worker. That path costs roughly 50 MB on a cold run — 24 MB of weights plus the ONNX runtime — which is why it stays opt-in and the button hides itself when a precomputed answer is already on screen.

Each vector record carries a fingerprint of the exact text it was built from, so a project or fund whose wording has changed since the catalog was generated is skipped rather than scored against text it no longer has. Model and fund-vector assets are self-hosted and cached; the deterministic matcher stays available if loading or inference fails. The control only appears once the browser confirms the pinned weights are actually being served, so a deployment that skipped them shows nothing rather than a button that always fails.

`public/` is gitignored, so these assets exist only where they have been generated:

```bash
npm run prepare:semantic                                          # pinned model, integrity-checked
npm run build:semantic-vectors -- path/to/match-index.v2.json     # or a URL to a deployed catalog
```

The second command writes `match-fund-vectors-v2.bin` and 64 project shards, `match-project-vectors-v2-N.bin`. Regenerate them whenever the matching index is rebuilt; records whose fingerprint no longer matches are simply ignored, so a stale file degrades rather than misleads.

The project vectors are sharded because a page scores one project. A single 3 MB file meant a project page downloaded three thousand times what it read; the browser now fetches the one shard, about 50 KB, that holds the project it is matching. `vectorBucket` in `src/matching/semantic-text.ts` decides which, and the builder and the browser must agree on it exactly.

`npm run deploy` runs `prepare:semantic` first. The vector catalogs are separate because they are built from a specific index. Regenerate them whenever `src/matching/taxonomy.ts` changes, since the vector version is derived from the taxonomy version. `npm run build:client` warns when either asset is missing.

Asset URLs and the vector version live in `src/matching/semantic-config.ts` and are read from the browser bundle rather than from the index, so changing them takes effect on the next deploy instead of waiting for the hourly cron to rewrite the catalog.

The hourly cron validates and atomically replaces the matching index. A failed build leaves the previous valid index in KV. It rejects empty catalogs, incomplete pagination, invalid hashes, and unexplained record-count drops over 20%. Checked-in ontology and fund vocabulary corrections live under `src/matching/` and must not encode project-specific rules or eligibility claims.

To inspect, benchmark, or run the human-label evaluation harness against an exported index:

```bash
npm run facet:gaps          -- path/to/match-index.json      # vocabulary the taxonomy has no facet for
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
| `/match/index.v2.json` | V2 fit-driven matching catalog, combined |
| `/match/core.v3.json` | funds, facets, and scoring — what a first paint needs |
| `/match/projects.v3.json` | the project list, fetched when the picker opens |
| `/match/project/:slug.json` | one project record, for a project page |
| `/projects/:slug`, `/funds/:slug` | detail |
| `/index/p/:slug`, `/index/mf/:slug` | 301 to the matching detail page (artizen.fund path) |
