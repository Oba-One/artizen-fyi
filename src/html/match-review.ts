import { layout, panel } from './layout';

export function renderMatchReview(): string {
  return layout({
    title: 'Fund matcher review',
    description: 'Blindly review Artizen fund matching quality',
    matching: true,
    matchStyles: true,
    extra: '<script type="module" src="/assets/match-review.js"></script>',
    body: panel(`
      <main class="artizen-review-page" data-review-root>
        <div class="artizen-match-intro">
          <span class="badge artizen-match-eyebrow">Local QA only</span>
          <h1>Blind fund-match review</h1>
          <p class="lead">Judge thematic fit before seeing rank, score, history, or algorithm identity. Ratings stay in memory unless you deliberately export them.</p>
        </div>

        <section class="artizen-review-provenance" aria-labelledby="review-source-title">
          <h2 id="review-source-title">Review source</h2>
          <dl data-review-provenance><div><dt>Status</dt><dd>Loading indexes…</dd></div></dl>
        </section>

        <section class="artizen-review-setup" aria-labelledby="review-project-title">
          <h2 id="review-project-title">Choose a public project</h2>
          <label for="review-project">Project</label>
          <select class="form-select" id="review-project" data-review-project></select>
          <div class="artizen-review-actions">
            <button class="btn btn-dark" type="button" data-review-start>Start blind review</button>
            <button class="btn btn-outline-dark" type="button" data-review-ai hidden>Include local AI candidates</button>
            <button class="btn btn-outline-dark" type="button" data-review-export>Export ratings JSON</button>
            <label class="btn btn-outline-dark" for="review-import">Import ratings JSON</label>
            <input class="visually-hidden" id="review-import" type="file" accept="application/json" data-review-import>
          </div>
          <p class="artizen-match-status" data-review-status role="status" aria-live="polite"></p>
        </section>

        <section class="artizen-review-candidate" data-review-candidate hidden aria-live="polite"></section>
      </main>
    `),
  });
}
