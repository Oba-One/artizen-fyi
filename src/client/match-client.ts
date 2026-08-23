import type {
  FundProfile,
  FundProfileV2,
  FundRecommendation,
  FundRecommendationV2,
  MatchIndexV1,
  MatchIndexV2,
  MatchResultV2,
  ProjectMatchInput,
  ProjectProfile,
} from '../artizen/types';
import { isMatchIndexStale, type MatchResult } from '../matching/engine';
import { findExactProject, matchInputForProject, projectLabel, searchProjects } from '../matching/project-search';

const INITIAL_RESULTS = 7;
const initialized = new WeakSet<Element>();

type BrowserMatchIndex = MatchIndexV1 | MatchIndexV2;
type BrowserFund = FundProfile | FundProfileV2;
type BrowserRecommendation = FundRecommendation | FundRecommendationV2;
type BrowserMatchResult = MatchResult | MatchResultV2;

type WorkerResponse =
  | { type: 'ready'; indexVersion: string }
  | { type: 'result'; requestId: number; result: BrowserMatchResult; semanticFallback?: string }
  | { type: 'semantic-progress'; requestId: number; progress: number }
  | { type: 'semantic-ready'; requestId: number }
  | { type: 'error'; requestId?: number; message: string };

type Pending = {
  resolve: (result: BrowserMatchResult) => void;
  reject: (error: Error) => void;
};

type SemanticPending = {
  resolve: () => void;
  reject: (error: Error) => void;
  onProgress: (progress: number) => void;
};

class BrowserMatcher {
  private requestId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly semanticPending = new Map<number, SemanticPending>();

  constructor(
    readonly index: BrowserMatchIndex,
    private readonly worker: Worker,
  ) {
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      if (event.data.type === 'result') {
        const pending = this.pending.get(event.data.requestId);
        if (!pending) return;
        this.pending.delete(event.data.requestId);
        pending.resolve(event.data.result);
      } else if (event.data.type === 'semantic-progress') {
        this.semanticPending.get(event.data.requestId)?.onProgress(event.data.progress);
      } else if (event.data.type === 'semantic-ready') {
        const pending = this.semanticPending.get(event.data.requestId);
        if (!pending) return;
        this.semanticPending.delete(event.data.requestId);
        pending.resolve();
      } else if (event.data.type === 'error' && event.data.requestId != null) {
        const pending = this.pending.get(event.data.requestId);
        if (pending) {
          this.pending.delete(event.data.requestId);
          pending.reject(new Error(event.data.message));
        }
        const semantic = this.semanticPending.get(event.data.requestId);
        if (semantic) {
          this.semanticPending.delete(event.data.requestId);
          semantic.reject(new Error(event.data.message));
        }
      }
    });
    worker.addEventListener('error', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('The matching worker stopped'));
      this.pending.clear();
      for (const pending of this.semanticPending.values()) pending.reject(new Error('The matching worker stopped'));
      this.semanticPending.clear();
    });
  }

  match(input: ProjectMatchInput, semantic = false): Promise<BrowserMatchResult> {
    const requestId = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ type: 'match', requestId, input, semantic });
    });
  }

  loadSemantic(onProgress: (progress: number) => void): Promise<void> {
    const requestId = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.semanticPending.set(requestId, { resolve, reject, onProgress });
      this.worker.postMessage({ type: 'semantic-load', requestId });
    });
  }

  cancelSemantic(): void {
    for (const pending of this.semanticPending.values()) pending.reject(new Error('Local AI loading was cancelled'));
    this.semanticPending.clear();
    this.worker.postMessage({ type: 'semantic-cancel' });
  }
}

function validIndex(value: unknown): value is BrowserMatchIndex {
  if (!value || typeof value !== 'object') return false;
  const index = value as Record<string, unknown>;
  return (
    (index.schemaVersion === 1 || index.schemaVersion === 2) &&
    typeof index.indexVersion === 'string' &&
    Array.isArray(index.projects) &&
    Array.isArray(index.funds) &&
    Array.isArray(index.relationships)
  );
}

async function createMatcher(): Promise<BrowserMatcher> {
  let response = await fetch('/match/index.v2.json', {
    cache: 'no-cache',
    headers: { Accept: 'application/json' },
  });
  if (response.status === 404 || response.status === 503) {
    response = await fetch('/match/index.json', {
      cache: 'no-cache',
      headers: { Accept: 'application/json' },
    });
  }
  if (!response.ok) throw new Error('The public matching catalog is not available yet');
  const value: unknown = await response.json();
  if (!validIndex(value)) throw new Error('The public matching catalog could not be read');

  const worker = new Worker('/assets/match-worker.js', { type: 'module', name: 'artizen-fund-matcher' });
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('The matching engine took too long to start')), 15_000);
    const onMessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.type === 'ready') {
        window.clearTimeout(timeout);
        worker.removeEventListener('message', onMessage);
        resolve();
      } else if (event.data.type === 'error' && event.data.requestId == null) {
        window.clearTimeout(timeout);
        worker.removeEventListener('message', onMessage);
        reject(new Error(event.data.message));
      }
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ type: 'init', index: value });
  });
  return new BrowserMatcher(value, worker);
}

let matcherPromise: Promise<BrowserMatcher> | undefined;

function matcher(): Promise<BrowserMatcher> {
  matcherPromise ||= createMatcher();
  return matcherPromise;
}

function find<T extends Element>(root: ParentNode, selector: string): T | null {
  return root.querySelector<T>(selector);
}

function setStatus(root: Element, message: string): void {
  const status = find<HTMLElement>(root, '[data-match-status]');
  if (status) status.textContent = message;
}

function readyMessage(index: BrowserMatchIndex): string {
  const base = `Ready to compare with ${index.funds.length} funds.`;
  if (index.schemaVersion === 2 && index.source.kind === 'fixture') {
    return `${base} QA fixture data is loaded; these are not production recommendations.`;
  }
  if (!isMatchIndexStale(index)) return base;
  const generated = new Date(index.generatedAt);
  const date = Number.isFinite(generated.getTime())
    ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(generated)
    : 'an unknown date';
  return `${base} The catalog was last refreshed on ${date} and may be out of date.`;
}

function money(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

function badge(label: string, className: string): HTMLElement {
  const element = document.createElement('span');
  element.className = `badge ${className}`;
  element.textContent = label;
  return element;
}

function recommendationCard(fund: BrowserFund, recommendation: BrowserRecommendation): HTMLElement {
  const article = document.createElement('article');
  article.className = 'artizen-match-card';

  const header = document.createElement('div');
  header.className = 'artizen-match-card-head';
  const title = document.createElement('h3');
  const link = document.createElement('a');
  link.href = `/funds/${encodeURIComponent(fund.slug)}`;
  link.textContent = fund.name;
  title.append(link);
  header.append(title);
  header.append(
    badge(
      recommendation.fit === 'strong'
        ? 'Strong fit'
        : recommendation.fit === 'good'
          ? 'Good fit'
          : recommendation.fit === 'limited'
            ? 'Limited evidence'
            : 'Explore',
      `artizen-fit-${recommendation.fit}`,
    ),
  );
  article.append(header);

  if (fund.subtitle) {
    const subtitle = document.createElement('p');
    subtitle.className = 'artizen-match-card-subtitle';
    subtitle.textContent = fund.subtitle;
    article.append(subtitle);
  }

  const meta = document.createElement('div');
  meta.className = 'artizen-match-card-meta';
  if (!recommendation.active) meta.append(badge('Inactive', 'text-bg-secondary'));
  else if ((recommendation.available || 0) > 0) meta.append(badge('Open now', 'text-bg-primary'));
  else meta.append(badge('Active', 'text-bg-light'));
  if (recommendation.knownRelationship) {
    const labels = {
      submitted: 'Already submitted',
      curated: 'Previously curated',
      funded: 'Previously funded',
    } as const;
    meta.append(badge(labels[recommendation.knownRelationship], 'artizen-known-relationship'));
  }
  article.append(meta);

  if (recommendation.available != null && recommendation.available > 0) {
    const available = document.createElement('p');
    available.className = 'artizen-match-available';
    available.textContent = `${money(recommendation.available)} currently available`;
    article.append(available);
  }

  if (recommendation.reasons.length) {
    const list = document.createElement('ul');
    list.className = 'artizen-match-reasons';
    for (const reason of recommendation.reasons) {
      const item = document.createElement('li');
      item.textContent = reason.label;
      list.append(item);
    }
    article.append(list);
  }
  return article;
}

function installResults(root: Element, index: BrowserMatchIndex) {
  const results = find<HTMLElement>(root, '[data-match-results]');
  const controls = find<HTMLElement>(root, '[data-match-controls]');
  const openOnly = find<HTMLInputElement>(root, '[data-open-only]');
  const more = find<HTMLButtonElement>(root, '[data-match-more]');
  const fundsById = new Map(index.funds.map((fund) => [fund.id, fund]));
  let recommendations: BrowserRecommendation[] = [];
  let catalogOpen = false;

  function render(): void {
    if (!results || !more) return;
    results.replaceChildren();
    const evidenceBacked = recommendations.filter(
      (recommendation) => recommendation.fit === 'strong' || recommendation.fit === 'good',
    );
    const source = catalogOpen ? recommendations : evidenceBacked;
    const filtered = openOnly?.checked
      ? source.filter((recommendation) => recommendation.active && (recommendation.available || 0) > 0)
      : source;
    const shown = catalogOpen ? filtered : filtered.slice(0, INITIAL_RESULTS);
    for (const recommendation of shown) {
      const fund = fundsById.get(recommendation.fundId);
      if (fund) results.append(recommendationCard(fund, recommendation));
    }
    more.hidden = recommendations.length === 0 || (!catalogOpen && recommendations.length === evidenceBacked.length);
    more.textContent = catalogOpen
      ? 'Back to recommendations'
      : `View full fund catalog (${recommendations.length})`;
    if (recommendations.length && filtered.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'artizen-match-empty';
      empty.textContent = openOnly?.checked
        ? 'No currently open funds appear in these results. Turn off “Open now” to see the alignment list.'
        : 'No funds clear the recommendation threshold. Review the full catalog or add more project detail.';
      results.append(empty);
    }
    if (recommendations.length) {
      setStatus(
        root,
        catalogOpen
          ? `Showing ${shown.length} funds ranked by alignment, including limited-evidence results.`
          : evidenceBacked.length
            ? `Showing ${shown.length} evidence-backed recommendation${shown.length === 1 ? '' : 's'}.`
            : 'No funds clear the recommendation threshold yet. You can still review the full catalog.',
      );
    }
  }

  more?.addEventListener('click', () => {
    catalogOpen = !catalogOpen;
    render();
    if (!catalogOpen) {
      const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
      results?.scrollIntoView({ behavior, block: 'start' });
    }
  });
  openOnly?.addEventListener('change', () => {
    catalogOpen = false;
    render();
  });

  return (result: BrowserMatchResult): void => {
    recommendations = result.recommendations;
    catalogOpen = false;
    if (controls) controls.hidden = recommendations.length === 0;
    if (!result.sufficient) {
      results?.replaceChildren();
      if (more) more.hidden = true;
      setStatus(root, 'Add a little more about the project or choose an impact tag before matching.');
      return;
    }
    if (recommendations.length === 0) {
      results?.replaceChildren();
      if (more) more.hidden = true;
      setStatus(root, 'No evidence-backed fund matches were found for this description. Try adding more detail or an impact tag.');
      return;
    }
    render();
  };
}

function modelDownloadLabel(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(2)} MB model download`;
}

function installSemanticControl(
  root: Element,
  engine: BrowserMatcher,
  render: (result: BrowserMatchResult) => void,
): { setInput(input: ProjectMatchInput): void } {
  const controls = find<HTMLElement>(root, '[data-semantic-controls]');
  const button = find<HTMLButtonElement>(root, '[data-semantic-button]');
  const progress = find<HTMLProgressElement>(root, '[data-semantic-progress]');
  const status = find<HTMLElement>(root, '[data-semantic-status]');
  const manifest = engine.index.schemaVersion === 2 ? engine.index.semantic : undefined;
  let input: ProjectMatchInput | undefined;
  let loading = false;
  if (!controls || !button || !manifest) return { setInput(value) { input = value; } };
  controls.hidden = false;
  const idleLabel = `Improve with local AI (${modelDownloadLabel(manifest.weightsBytes)})`;
  button.textContent = idleLabel;
  button.addEventListener('click', async () => {
    if (loading) {
      engine.cancelSemantic();
      loading = false;
      button.textContent = idleLabel;
      if (progress) progress.hidden = true;
      if (status) status.textContent = 'Local AI loading cancelled. Baseline recommendations are unchanged.';
      return;
    }
    if (!input) {
      if (status) status.textContent = 'Match a project first, then improve those results locally.';
      return;
    }
    loading = true;
    button.textContent = 'Cancel local AI download';
    if (progress) {
      progress.hidden = false;
      progress.value = 0;
    }
    if (status) status.textContent = 'Loading the private on-device model…';
    try {
      await engine.loadSemantic((value) => {
        if (progress) progress.value = value;
        if (status) status.textContent = `Loading local AI… ${Math.round(value * 100)}%`;
      });
      const result = await engine.match(input, true);
      if ('mode' in result && result.mode === 'semantic') {
        render(result);
        button.disabled = true;
        button.textContent = 'Local AI applied';
        if (status) status.textContent = 'Recommendations now include private on-device semantic similarity.';
      } else {
        throw new Error('The local model could not score this project');
      }
    } catch {
      button.textContent = 'Retry local AI';
      if (status) status.textContent = 'Local AI could not load. Baseline recommendations are unchanged.';
    } finally {
      loading = false;
      if (progress) progress.hidden = true;
    }
  });
  return { setInput(value) { input = value; } };
}

class TagPicker {
  private tags: string[] = [];
  private readonly input: HTMLInputElement | null;
  private readonly list: HTMLElement | null;

  constructor(
    private readonly root: Element,
    private readonly limit: number | null = 8,
  ) {
    this.input = find(root, '[data-tag-input]');
    this.list = find(root, '[data-selected-tags]');
    find<HTMLButtonElement>(root, '[data-tag-add]')?.addEventListener('click', () => this.addInput());
    this.input?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.addInput();
    });
  }

  values(): string[] {
    return [...this.tags];
  }

  set(values: string[]): void {
    this.tags = [];
    const selected = this.limit == null ? values : values.slice(0, this.limit);
    for (const value of selected) this.add(value, false);
    this.render();
  }

  private addInput(): void {
    if (!this.input) return;
    this.add(this.input.value, true);
  }

  private add(value: string, focus: boolean): void {
    const tag = value.trim();
    if (!tag || this.tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      if (this.input) this.input.value = '';
      return;
    }
    if (this.limit != null && this.tags.length >= this.limit) {
      this.input?.setCustomValidity(`Choose no more than ${this.limit} impact tags.`);
      this.input?.reportValidity();
      return;
    }
    this.input?.setCustomValidity('');
    this.tags.push(tag);
    if (this.input) this.input.value = '';
    this.render();
    if (focus) this.input?.focus();
  }

  private render(): void {
    if (!this.list) return;
    this.list.replaceChildren();
    this.tags.forEach((tag, index) => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = tag;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${tag}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        this.tags.splice(index, 1);
        this.input?.setCustomValidity('');
        this.render();
        this.input?.focus();
      });
      item.append(label, remove);
      this.list?.append(item);
    });
  }
}

function fillTagCatalog(root: Element, index: BrowserMatchIndex): void {
  const tagOptions = find<HTMLDataListElement>(root, '[data-tag-options]');
  const tags = [...new Set(index.projects.flatMap((project) => project.tags))].sort((a, b) => a.localeCompare(b));
  for (const tag of tags) {
    const option = document.createElement('option');
    option.value = tag;
    tagOptions?.append(option);
  }
}

async function initializeDetail(root: Element, engine: BrowserMatcher): Promise<void> {
  const id = (root as HTMLElement).dataset.projectId;
  const slug = (root as HTMLElement).dataset.projectSlug || decodeURIComponent(location.pathname.split('/').pop() || '');
  const project = engine.index.projects.find((candidate) => (id && candidate.id === id) || candidate.slug === slug);
  if (!project) {
    setStatus(root, 'This project is not in the current matching catalog yet. Try the project description tool instead.');
    return;
  }
  const render = installResults(root, engine.index);
  const semantic = installSemanticControl(root, engine, render);
  const input = matchInputForProject(project);
  semantic.setInput(input);
  const result = await engine.match(input);
  render(result);
}

function initializeForm(root: Element, engine: BrowserMatcher): void {
  const form = find<HTMLFormElement>(root, '[data-match-form]');
  const projectInput = find<HTMLInputElement>(root, '[data-project-input]');
  const projectOptions = find<HTMLElement>(root, '[data-project-options]');
  const projectSearchStatus = find<HTMLElement>(root, '[data-project-search-status]');
  const description = find<HTMLTextAreaElement>(root, '[data-project-description]');
  const existingDescription = find<HTMLTextAreaElement>(root, '[data-existing-description]');
  const title = find<HTMLInputElement>(root, '[data-project-title]');
  const preview = find<HTMLElement>(root, '[data-project-preview]');
  const submit = find<HTMLButtonElement>(root, '[type="submit"]');
  const projects = [...engine.index.projects].sort((a, b) => a.name.localeCompare(b.name));
  fillTagCatalog(root, engine.index);
  const existingPickerRoot = find(root, '[data-tag-picker="existing"]');
  const describePickerRoot = find(root, '[data-tag-picker="describe"]');
  const existingTags = existingPickerRoot ? new TagPicker(existingPickerRoot, null) : undefined;
  const describeTags = describePickerRoot ? new TagPicker(describePickerRoot) : undefined;
  const render = installResults(root, engine.index);
  const semantic = installSemanticControl(root, engine, render);
  let source = 'existing';
  let chosenProject: ProjectProfile | undefined;
  let visibleProjects: ProjectProfile[] = [];
  let activeProject = -1;

  function selectedProject(): ProjectProfile | undefined {
    if (!projectInput) return undefined;
    return chosenProject || findExactProject(projects, projectInput.value);
  }

  function showProject(project: ProjectProfile | undefined): void {
    if (!preview) return;
    preview.replaceChildren();
    preview.hidden = !project;
    if (!project) {
      if (existingDescription) existingDescription.value = '';
      existingTags?.set([]);
      return;
    }
    const name = document.createElement('strong');
    name.textContent = project.name;
    const detail = document.createElement('span');
    detail.textContent = project.description || 'No public project description';
    preview.append(name, detail);
    if (existingDescription) existingDescription.value = project.description;
    existingTags?.set(project.tags);
  }

  function closeProjectOptions(): void {
    if (!projectInput || !projectOptions) return;
    projectOptions.hidden = true;
    projectInput.setAttribute('aria-expanded', 'false');
    projectInput.removeAttribute('aria-activedescendant');
    activeProject = -1;
  }

  function setActiveProject(index: number): void {
    if (!projectInput || !projectOptions || visibleProjects.length === 0) return;
    activeProject = Math.max(0, Math.min(index, visibleProjects.length - 1));
    projectOptions.querySelectorAll<HTMLElement>('[role="option"]').forEach((option, optionIndex) => {
      const active = optionIndex === activeProject;
      option.setAttribute('aria-selected', String(active));
      if (active) {
        projectInput.setAttribute('aria-activedescendant', option.id);
        option.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function chooseProject(project: ProjectProfile): void {
    if (!projectInput) return;
    chosenProject = project;
    projectInput.value = projectLabel(project);
    projectInput.setCustomValidity('');
    showProject(project);
    closeProjectOptions();
    if (projectSearchStatus) projectSearchStatus.textContent = `${project.name} selected.`;
  }

  function renderProjectOptions(): void {
    if (!projectInput || !projectOptions) return;
    visibleProjects = searchProjects(projects, projectInput.value);
    activeProject = -1;
    projectOptions.replaceChildren();
    if (visibleProjects.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'artizen-project-option-empty';
      empty.textContent = 'No projects match that search.';
      projectOptions.append(empty);
    } else {
      visibleProjects.forEach((project, index) => {
        const option = document.createElement('li');
        option.id = `match-project-option-${index}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        const name = document.createElement('strong');
        name.textContent = project.name;
        const detail = document.createElement('span');
        detail.textContent = project.tags.length ? project.tags.join(' · ') : project.description || project.slug;
        option.append(name, detail);
        option.addEventListener('pointerdown', (event) => event.preventDefault());
        option.addEventListener('click', () => chooseProject(project));
        projectOptions.append(option);
      });
    }
    projectOptions.hidden = false;
    projectInput.setAttribute('aria-expanded', 'true');
    if (projectSearchStatus) {
      projectSearchStatus.textContent = visibleProjects.length
        ? `${visibleProjects.length} project${visibleProjects.length === 1 ? '' : 's'} available.`
        : 'No projects match that search.';
    }
  }

  function syncMode(next: string): void {
    source = next;
    root.querySelectorAll<HTMLElement>('[data-source-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.sourcePanel !== source;
    });
    if (projectInput) projectInput.required = source === 'existing';
    if (source !== 'existing') projectInput?.setCustomValidity('');
    if (description) description.required = source === 'describe';
  }

  root.querySelectorAll<HTMLInputElement>('[name="match-source"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) syncMode(radio.value);
    });
  });
  projectInput?.addEventListener('focus', renderProjectOptions);
  projectInput?.addEventListener('input', () => {
    chosenProject = undefined;
    const project = findExactProject(projects, projectInput.value);
    projectInput.setCustomValidity('');
    showProject(project);
    if (project) {
      chooseProject(project);
    } else renderProjectOptions();
  });
  projectInput?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (projectOptions?.hidden) renderProjectOptions();
      setActiveProject(
        event.key === 'ArrowDown'
          ? activeProject + 1
          : activeProject < 0
            ? visibleProjects.length - 1
            : activeProject - 1,
      );
    } else if (event.key === 'Enter' && activeProject >= 0 && visibleProjects[activeProject]) {
      event.preventDefault();
      chooseProject(visibleProjects[activeProject]);
    } else if (event.key === 'Enter' && selectedProject()) {
      event.preventDefault();
      form?.requestSubmit();
    } else if (event.key === 'Escape') {
      closeProjectOptions();
    }
  });
  projectInput?.addEventListener('blur', () => window.setTimeout(closeProjectOptions, 120));

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    let input: ProjectMatchInput;
    if (source === 'existing') {
      const project = selectedProject();
      if (!project) {
        projectInput?.setCustomValidity('Choose a project from the search results.');
        projectInput?.reportValidity();
        setStatus(root, 'Choose a project from the search results before matching.');
        return;
      }
      projectInput?.setCustomValidity('');
      const refinedTags = existingTags?.values() || [];
      input = matchInputForProject(
        project,
        existingDescription?.value.trim() || project.description,
        refinedTags.length ? refinedTags : project.tags,
      );
    } else {
      input = {
        title: title?.value.trim() || undefined,
        description: description?.value.trim() || '',
        tags: describeTags?.values() || [],
      };
    }
    if (submit) submit.disabled = true;
    setStatus(root, 'Comparing this project with the fund catalog…');
    try {
      semantic.setInput(input);
      render(await engine.match(input));
    } catch {
      setStatus(root, 'The matching engine could not finish. Reload the page and try again.');
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  const requestedSlug = new URL(location.href).searchParams.get('project');
  const requested = requestedSlug && engine.index.projects.find((project) => project.slug === requestedSlug);
  if (requested && projectInput) {
    chooseProject(requested);
  }
  syncMode('existing');
  setStatus(root, readyMessage(engine.index));
}

async function initialize(root: Element): Promise<void> {
  if (initialized.has(root)) return;
  initialized.add(root);
  try {
    const engine = await matcher();
    if ((root as HTMLElement).dataset.matchMode === 'detail') await initializeDetail(root, engine);
    else initializeForm(root, engine);
  } catch {
    setStatus(root, 'Fund matching is temporarily unavailable. The rest of this page still works normally.');
  }
}

function initializeAll(): void {
  document.querySelectorAll('[data-match-root]').forEach((root) => void initialize(root));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeAll);
else initializeAll();
document.addEventListener('artizen:content', initializeAll);
