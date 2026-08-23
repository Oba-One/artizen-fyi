import { escapeHtml, layout, panel } from './layout';

function tagPicker(prefix: string, capped = true): string {
  return `<div class="artizen-match-tags" data-tag-picker="${escapeHtml(prefix)}">
    <label for="${escapeHtml(prefix)}-tag">Impact tags <span class="text-muted">(${capped ? 'optional, up to 8' : 'all stored tags are included'})</span></label>
    <div class="artizen-match-tag-entry">
      <input class="form-control" id="${escapeHtml(prefix)}-tag" type="text" list="match-tag-options" autocomplete="off" data-tag-input>
      <button class="btn btn-outline-dark" type="button" data-tag-add>Add tag</button>
    </div>
    <ul class="artizen-match-selected-tags" data-selected-tags aria-label="Selected impact tags"></ul>
  </div>`;
}

export function renderMatch(): string {
  return layout({
    title: 'Find funds',
    description: 'Find Artizen funds that align with a project',
    matching: true,
    extra: '<script type="module" src="/assets/match-client.js"></script>',
    body: panel(`
      <main class="artizen-match-page" data-match-root data-match-mode="form">
        <div class="artizen-match-intro">
          <span class="badge artizen-match-eyebrow">Private, on-device matching</span>
          <h1>Find funds for your project</h1>
          <p class="lead">Choose an Artizen project or describe one. Your description stays in this browser while the matching engine compares it with the public fund catalog.</p>
        </div>

        <form data-match-form>
          <fieldset class="artizen-match-mode">
            <legend class="visually-hidden">Project source</legend>
            <label><input type="radio" name="match-source" value="existing" checked> Select a project</label>
            <label><input type="radio" name="match-source" value="describe"> Describe a project</label>
          </fieldset>

          <section data-source-panel="existing" aria-labelledby="existing-project-title">
            <h2 id="existing-project-title">Select a project</h2>
            <div class="artizen-project-picker">
              <label for="match-project">Project</label>
              <input class="form-control" id="match-project" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="match-project-options" aria-describedby="match-project-help" autocomplete="off" placeholder="Search projects by name, tag, or description" data-project-input required>
              <ul class="artizen-project-options" id="match-project-options" role="listbox" data-project-options hidden></ul>
            </div>
            <p class="form-text" id="match-project-help">Start typing, then choose a project or press Enter on the highlighted result.</p>
            <p class="visually-hidden" role="status" aria-live="polite" data-project-search-status></p>
            <div class="artizen-match-project-preview" data-project-preview hidden></div>
            <details class="artizen-match-refine">
              <summary>Refine this project for this match</summary>
              <label for="match-existing-description">Project description</label>
              <textarea class="form-control" id="match-existing-description" maxlength="1000" rows="4" data-existing-description></textarea>
              ${tagPicker('existing', false)}
            </details>
          </section>

          <section data-source-panel="describe" aria-labelledby="describe-project-title" hidden>
            <h2 id="describe-project-title">Describe a project</h2>
            <label for="match-title">Project title <span class="text-muted">(optional)</span></label>
            <input class="form-control" id="match-title" type="text" maxlength="120" autocomplete="off" data-project-title>
            <label for="match-description">Project description</label>
            <textarea class="form-control" id="match-description" maxlength="1000" rows="5" placeholder="What are you making, who is it for, and what change do you hope it creates?" data-project-description></textarea>
            ${tagPicker('describe')}
          </section>

          <datalist id="match-tag-options" data-tag-options></datalist>
          <button class="btn btn-dark artizen-match-submit" type="submit">Find matching funds</button>
        </form>

        <section class="artizen-match-output" aria-labelledby="match-results-title">
          <div class="artizen-match-heading">
            <div>
              <h2 id="match-results-title">Fund recommendations</h2>
              <p class="text-muted mb-0">Ranked by thematic fit using each fund’s official language, not eligibility or past relationships.</p>
            </div>
          </div>
          <p class="artizen-match-status" data-match-status role="status" aria-live="polite">The public matching catalog is loading…</p>
          <div class="artizen-match-controls" data-match-controls hidden>
            <label><input type="checkbox" data-open-only> Open now</label>
          </div>
          <div class="artizen-match-results" data-match-results></div>
          <button class="btn btn-outline-dark artizen-match-more" type="button" data-match-more hidden>Show more funds</button>
          <div class="artizen-semantic-controls" data-semantic-controls hidden>
            <button class="btn btn-outline-dark" type="button" data-semantic-button>Improve with local AI</button>
            <progress max="1" value="0" data-semantic-progress hidden></progress>
            <span class="text-muted" data-semantic-status></span>
          </div>
        </section>

        <p class="artizen-match-note">Alignment is not a guarantee of eligibility, an open application, or a current deadline. Check each fund’s requirements on Artizen.</p>
        <noscript><p class="artizen-note">Fund matching needs JavaScript to run privately in your browser.</p></noscript>
      </main>
    `),
  });
}
