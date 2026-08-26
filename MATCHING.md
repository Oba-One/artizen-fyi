# Fund matching

Built by [Afolabi](https://github.com/Oba-One).

`/match` accepts an existing project or a private, freeform description. Project detail pages use the same matcher in a Fund alignment panel. The browser fetches a fixed, versioned public catalog and performs all ranking in a Web Worker. Freeform text and embeddings are kept in memory and are never added to a URL, persisted, or sent to a server or external service.

The catalog is served in three pieces, because no page needs all of it. `/match/core.json` carries funds, facets, and scoring — about 250 KB, and all a first paint uses. `/match/projects.json` carries the project list and is fetched only when someone reaches for the picker. `/match/project/:id.json` carries a single record, which is all a project page needs. The combined `/match/index.json` remains available for the QA harness and calibration scripts. These are deploy-time static assets, so a request never reads or parses the combined KV document.

Each project carries its own fund history as compact `[fundId, kind]` pairs rather than the catalog shipping one flat relationship table. A browser matching one project reads sixteen rows of nine thousand, so the table was roughly half the payload and almost entirely other people's projects.

Selecting a catalog project needs no model download at all: both sides were embedded when the catalog was built, so the browser fetches the fund vectors (262 KB) plus one project shard (about 50 KB) and takes a dot product. The on-device model is still required for a freeform description, and for a catalog project whose description or tags have been edited, since neither is text that was embedded in advance.

Project and fund thumbnails are the one exception worth naming: their URLs travel inside the public catalog, but the browser loads the images themselves from Artizen's media host. That host therefore sees which cards were rendered. Nothing about the project description, the tags, or the ranking leaves the browser.

The ranker uses only official fund language, reviewed project-agnostic facets, and distinctive core concepts. Historical relationships, availability, and activity are display context only and never affect rank or score. The primary list holds twelve funds - a count that divides evenly across one, two, and three columns, so the grid never ends on a part-filled row. Every strong or good match comes first, then the closest exploratory ones to make up the number, each carrying the badge that says which it is. The full catalog remains available separately. Results describe thematic fit, not eligibility, open applications, geography, or deadlines.

Each card carries a 0-99 fit index, mapped piecewise onto the band thresholds rather than being the raw score, so the number and the label always agree: worth a look starts at 30, good at 65, strong at 85. The scale stops at 99 because this is thematic alignment, not proof of a perfect match. Raw scores top out near 0.78 in practice, which is why the display is anchored to the bands instead of shown directly. Three filters sit above the results and are named for what the catalog actually records: **Active curation** is the fund's `active` flag and is on by default, **Funds available** is a positive `Funding - current`, and **New to me** hides funds this project has already applied to, been curated in, or been funded by. Funds that are not curating are labelled rather than silently ranked alongside the rest. A focus chip row filters by the shared taxonomy facets, ordered by how often each appears in the current result set; funds that carry no facets never match a focus filter, and the empty state says so. A name search, a sort control, and a per-project shortlist held in `localStorage` sit alongside them, and the full catalog pages in the same twelves rather than painting 244 cards at once.

Selecting a catalog project matches immediately: scoring one is a dot product against vectors already in memory, so there is nothing for a separate submit step to buy. The submit button remains for freeform descriptions and for re-running after a refinement, and says "Update matches" only while a refinement is actually pending. The local AI control appears on the same principle - only when there is something it could improve, which means a freeform description or an edited project, never an empty form or a project whose comparison is already prepared.

Cards animate in on a fresh set of results and settle in place when an existing set is narrowed, so a keystroke in the fund search does not replay the sequence. The whole animation is a keyframe and a custom property; `prefers-reduced-motion` turns it off.

Impact tags are the single largest lever on match quality: tagged projects average 7.6 evidence-backed matches against 3.4, and 30% of untagged projects have no evidence-backed match at all. A third of the catalog carries no tags, so selecting one of those projects surfaces a prompt above the refine disclosure rather than leaving the picker buried inside it.

Editing the description or the tags takes the input off the precomputed comparison, because it is no longer the text that was embedded at build time. The results region says so and offers the two ways back: run the model on this device, or drop the refinements. When the on-device model does replace a baseline reading, cards that moved up more than two places or entered the top twelve are marked, so the download has visible evidence behind it.

Band thresholds are calibrated against the score distribution of the whole catalog, not chosen by hand:

```bash
npm run calibrate:matching -- path/to/match-index.json     # baseline ranker
npm run calibrate:semantic -- path/to/match-index.json     # with semantic scoring applied
npm run compare:match-modes  -- path/to/match-index.json      # how much the two actually differ
```

The semantic sweep exists because semantic scoring uses a different weight profile, and bands set from baseline scores alone can collapse under it. Measured across the catalog the two distributions turn out close (rank-1 medians 0.43 and 0.45), so one set of thresholds serves both.

`ScoringConfig` travels **inside** the index, so a threshold change in `src/matching/index.ts` does nothing until the deploy catalog is rebuilt. `npm run deploy` does that automatically; locally, build a catalog explicitly and confirm `scoring.version` in `/match/index.json` matches the source.

Semantic scoring comes from two paths. Choosing a project from the catalog uses **precomputed embeddings**: both sides of the comparison are known when the catalog is built, so the vectors ship as static files and the browser only takes a dot product — about 3.5 MB of vectors, no model, no WebAssembly, no inference. Freeform descriptions do not exist until someone types them, so those still need the model on the device: an optional “Improve with local AI” action lazy-loads the pinned `mixedbread-ai/mxbai-embed-xsmall-v1` INT8 model and scores the complete catalog in the same Worker. That path costs roughly 50 MB on a cold run — 24 MB of weights plus the ONNX runtime — which is why it stays opt-in and the button hides itself when a precomputed answer is already on screen.

Each vector record carries a fingerprint of the exact text it was built from, so it cannot be scored against different wording. Model, catalog, and vector assets are generated in one predeploy sequence and shipped together. The deterministic matcher stays available if loading or inference fails. The control only appears once the browser confirms the pinned weights are actually being served, and it rechecks after a transient network failure.

`public/` is gitignored, so these assets exist only where they have been generated:

```bash
npm run prepare:semantic                                          # pinned model, integrity-checked
npm run build:match-catalog -- path/to/match-index.json           # omit the path to crawl live Artizen data
npm run build:semantic-vectors -- public/match/index.json
```

The final command writes `match-fund-vectors.bin` and 64 project shards, `match-project-vectors-N.bin`. `npm run deploy` runs all three steps in order, so a normal deploy cannot silently omit the catalog, model, or precomputed vectors.

The project vectors are sharded because a page scores one project. A single 3 MB file meant a project page downloaded three thousand times what it read; the browser now fetches the one shard, about 50 KB, that holds the project it is matching. `vectorBucket` in `src/matching/semantic-text.ts` decides which, and the builder and the browser must agree on it exactly.

`onnxruntime-web` is pinned to an exact version in both `dependencies` and `overrides`. `overrides` keeps a transitive bump from installing a second copy under `@huggingface/transformers`, which would otherwise ship wasm from one version to a runtime bundled from another, and `build:client` asserts the installed version still matches the pin.

ONNX Runtime ships four `ort-wasm-simd-threaded` builds, but each of its entry points hardcodes one of them rather than choosing at runtime - which one you get is decided by the entry point transformers imports, not by the browser. Ours resolves to `asyncify`, which is also how WebGPU is served in this version, so `jsep` and `jspi` are 40 MB that no code path can reach. `build:client` reads the wasm filenames out of the built bundles and copies only those, so an upgrade that switches entry points moves the copy list with it in the same build; it fails if the bundle names a file ONNX Runtime does not ship, and deletes variants a previous build left behind. Any asset above 90% of Cloudflare's 25 MiB per-file limit is reported on every build.

`npm run deploy` fetches and verifies the pinned model, builds one live Artizen catalog, and generates vectors from that exact catalog before Wrangler uploads any assets. The vector version is derived from the taxonomy version, so taxonomy changes invalidate old vectors automatically. `npm run build:client` warns when local assets are missing.

Asset URLs and the vector version live in `src/matching/semantic-config.ts` and are read from the browser bundle rather than duplicated across build scripts.

The matching catalog is deployment-scoped rather than hourly: catalog JSON and vectors are one release artifact. The UI treats a catalog as current for 30 days, then identifies its build date and warns that newer Artizen changes may be missing. The builder rejects fixtures, empty catalogs, invalid hashes, and unexplained record-count drops over 20%. Bubble pagination drift is logged but does not break unrelated crawls. Checked-in ontology and fund vocabulary corrections live under `src/matching/` and must not encode project-specific rules or eligibility claims.

To inspect, benchmark, or run the human-label evaluation harness against an exported index:

```bash
npm run facet:gaps          -- path/to/match-index.json      # vocabulary the taxonomy has no facet for
npm run inspect:matching -- path/to/match-index.json "Green Goods"
npm run benchmark:matching -- path/to/match-index.json
npm run evaluate:matching -- path/to/match-index.json path/to/review-export.json
npm run qa:match -- path/to/match-index.json 8790
```

The local-only `/match/review` route supports blind 0–3 judgments, deliberate JSON import/export, a deterministic tuning/holdout split, and evidence reveal only after rating. It visibly identifies fixture indexes. Production rejects fixtures, and the review bundle is only built for local development or `qa:match`. Generated browser bundles are checked against the 60 KB gzip base-client budget and Cloudflare’s 25 MiB per-asset limit during `npm run build:client`.
