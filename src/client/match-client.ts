import type {
  FundProfile,
  FundRecommendation,
  MatchIndex,
  MatchResult,
  ProjectMatchInput,
  ProjectProfile,
  SemanticCatalogManifest,
} from '../artizen/types';
import { isMatchIndexStale } from '../matching/engine';
import { moveActive, pickerState } from '../matching/project-picker';
import { semanticManifest } from '../matching/semantic-config';
import { matchInputForProject } from '../matching/project-search';

const INITIAL_RESULTS = 12;
const PROJECTS_URL = '/match/projects.json';
const initialized = new WeakSet<Element>();

type BrowserMatchIndex = MatchIndex;
type BrowserFund = FundProfile;
type BrowserRecommendation = FundRecommendation;
type BrowserMatchResult = MatchResult;

type WorkerResponse =
  | { type: 'ready'; indexVersion: string }
  | {
      type: 'result';
      requestId: number;
      result: BrowserMatchResult;
      semanticFallback?: string;
      semanticSource?: 'precomputed' | 'on-device';
      semanticDowngrade?: 'edited';
    }
  | { type: 'semantic-progress'; requestId: number; progress: number }
  | { type: 'semantic-ready'; requestId: number }
  | { type: 'error'; requestId?: number; message: string };

type MatchOutcome = {
  result: BrowserMatchResult;
  semanticFallback?: string;
  semanticSource?: 'precomputed' | 'on-device';
  /** Set when a prepared comparison existed but this input no longer matches the embedded text. */
  semanticDowngrade?: 'edited';
};

type Pending = {
  resolve: (outcome: MatchOutcome) => void;
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
  private projectList: ProjectProfile[];
  private projectsPromise: Promise<ProjectProfile[]> | undefined;

  constructor(
    readonly index: BrowserMatchIndex,
    private readonly worker: Worker,
  ) {
    // Empty for the split catalog and populated for the combined one, so both shapes work.
    this.projectList = index.projects;
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      if (event.data.type === 'result') {
        const pending = this.pending.get(event.data.requestId);
        if (!pending) return;
        this.pending.delete(event.data.requestId);
        pending.resolve({
          result: event.data.result,
          semanticFallback: event.data.semanticFallback,
          semanticSource: event.data.semanticSource,
          semanticDowngrade: event.data.semanticDowngrade,
        });
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

  match(input: ProjectMatchInput, semantic = false): Promise<MatchOutcome> {
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

  /** Whatever project records this page has fetched so far; empty until `loadProjects` resolves. */
  get projects(): ProjectProfile[] {
    return this.projectList;
  }

  /**
   * The project list is the bulk of the catalog and nothing on a first paint needs it, so it is
   * fetched on demand: the whole list when the picker opens, one record on a project page. The
   * worker is told either way, because relationships and embedding fingerprints are derived from
   * whichever projects are known.
   */
  loadProjects(url = PROJECTS_URL): Promise<ProjectProfile[]> {
    // Cleared on failure: this fetch happens mid-interaction now, so a network blip must not
    // leave the picker permanently broken until someone thinks to reload the page.
    this.projectsPromise ||= this.fetchProjects(url).catch((error: unknown) => {
      this.projectsPromise = undefined;
      throw error;
    });
    return this.projectsPromise;
  }

  private async fetchProjects(url: string): Promise<ProjectProfile[]> {
    if (this.projectList.length) return this.projectList;
    const response = await fetch(url, { cache: 'no-cache', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('The project list is not available yet');
    const value = (await response.json()) as { indexVersion?: unknown; projects?: unknown };
    if (value.indexVersion !== this.index.indexVersion) {
      throw new Error('The project list changed while this page was open. Reload and try again.');
    }
    const projects = Array.isArray(value.projects) ? (value.projects as ProjectProfile[]) : [];
    if (projects.length === 0) throw new Error('The project list is empty');
    this.projectList = projects;
    this.worker.postMessage({ type: 'projects', projects });
    return projects;
  }
}

function validIndex(value: unknown): value is BrowserMatchIndex {
  if (!value || typeof value !== 'object') return false;
  const index = value as Record<string, unknown>;
  return (
    index.schemaVersion === 2 &&
    typeof index.indexVersion === 'string' &&
    Array.isArray(index.projects) &&
    Array.isArray(index.funds) &&
    Array.isArray(index.relationships)
  );
}

/**
 * Fund-only first. The combined document is 3 MB and a first paint uses roughly 250 KB of it, so
 * the browser starts from the deployment-coupled core document and fetches projects separately.
 */
async function createMatcher(): Promise<BrowserMatcher> {
  const response = await fetch('/match/core.json', { cache: 'no-cache', headers: { Accept: 'application/json' } });
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
  if (index.source.kind === 'fixture') {
    return `${base} QA fixture data is loaded; these are not production recommendations.`;
  }
  if (!isMatchIndexStale(index)) return base;
  const generated = new Date(index.generatedAt);
  const date = Number.isFinite(generated.getTime())
    ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(generated)
    : 'an unknown date';
  return `${base} This deployment's matching catalog was built on ${date} and may not include newer Artizen changes.`;
}

function money(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

function badge(label: string, className: string, title?: string): HTMLElement {
  const element = document.createElement('span');
  element.className = `badge ${className}`;
  element.textContent = label;
  if (title) element.title = title;
  return element;
}

const RELATIONSHIP_LABELS = {
  submitted: 'Applied',
  curated: '\u2713 Curated',
  funded: '\u2713 Funded',
} as const;

const RELATIONSHIP_TITLES = {
  submitted: 'This project has already applied to this fund',
  curated: 'This project has already been curated in this fund',
  funded: 'This project has already been funded by this fund',
} as const;

/**
 * The median project gets five evidence-backed matches and a quarter get none, so most cards in a
 * typical list carry the third band. "Explore" read as a consolation prize on results that are
 * often the honest best answer; "Worth a look" says the same thing without the shrug.
 */
const FIT_LABELS = {
  strong: 'Strong fit',
  good: 'Good fit',
  exploratory: 'Worth a look',
  limited: 'Limited evidence',
} as const;

/**
 * Raw scores top out well below 1, so `score * 100` reads as a failing percentage even for the
 * best match a catalog can produce. Map the score piecewise onto the band thresholds instead, so
 * the number and the label always agree: exploratory starts at 30, good at 65, strong at 85.
 *
 * The top anchor is the practical ceiling, not 1.0. Measured across the catalog, rank-1 scores
 * reach p90 0.54 and max 0.78 in both baseline and semantic modes; anchoring at 1.0 squeezed every
 * strong match into 85-89, so a well-matched project saw ten identical-looking cards.
 */
const FIT_CEILING = 0.6;

function fitIndex(score: number, index: BrowserMatchIndex): number {
  const scoring = index.scoring;
  const strong = scoring?.strongThreshold ?? 0.44;
  const stops: Array<[number, number]> = [
    [0, 0],
    [scoring?.exploratoryThreshold ?? 0.1, 30],
    [scoring?.goodThreshold ?? 0.38, 65],
    [strong, 85],
    [Math.max(strong + 0.05, FIT_CEILING), 99],
  ];
  for (let step = 1; step < stops.length; step += 1) {
    const [fromScore, fromIndex] = stops[step - 1];
    const [toScore, toIndex] = stops[step];
    if (score > toScore) continue;
    const span = toScore - fromScore;
    return Math.round(span > 0 ? fromIndex + ((score - fromScore) / span) * (toIndex - fromIndex) : toIndex);
  }
  return 99;
}

function facetLabels(index: BrowserMatchIndex): Map<string, string> {
  if (index.schemaVersion !== 2) return new Map();
  return new Map(index.facets.map((facet) => [facet.id, facet.label]));
}

function tagChips(tags: string[], limit: number): HTMLElement {
  // Plain spans, not a list: these render inside `role="option"` rows, where a nested
  // list/listitem subtree is not permitted content and screen readers announce it on every
  // arrow-key move through the picker.
  const group = document.createElement('span');
  group.className = 'artizen-tag-chips';
  for (const tag of tags.slice(0, limit)) {
    const item = document.createElement('span');
    item.textContent = tag;
    group.append(item);
  }
  if (tags.length > limit) {
    const rest = document.createElement('span');
    rest.className = 'artizen-tag-chips-rest';
    rest.textContent = `+${tags.length - limit}`;
    group.append(rest);
  }
  return group;
}

function emptyThumbnail(className: string): HTMLElement {
  const empty = document.createElement('span');
  empty.className = `${className} ${className}-empty`;
  empty.setAttribute('aria-hidden', 'true');
  return empty;
}

function thumbnail(image: string | undefined, className: string): HTMLElement {
  if (!image) return emptyThumbnail(className);
  const picture = document.createElement('img');
  picture.className = className;
  picture.src = image;
  picture.alt = '';
  picture.loading = 'lazy';
  picture.referrerPolicy = 'no-referrer';
  // A quarter of project media fields hold something that is not an image. Degrade to the same
  // neutral tile a missing image gets, rather than a browser broken-image glyph.
  picture.addEventListener('error', () => picture.replaceWith(emptyThumbnail(className)), { once: true });
  return picture;
}

function fitMeter(recommendation: BrowserRecommendation, index: BrowserMatchIndex): HTMLElement {
  const value = fitIndex(recommendation.score, index);
  const meter = document.createElement('div');
  meter.className = 'artizen-match-fit';
  const track = document.createElement('span');
  track.className = 'artizen-match-fit-track';
  const fill = document.createElement('span');
  fill.className = `artizen-match-fit-fill artizen-fit-fill-${recommendation.fit}`;
  fill.style.width = `${value}%`;
  track.append(fill);
  const readout = document.createElement('span');
  readout.className = 'artizen-match-fit-value';
  readout.textContent = String(value);
  meter.append(track, readout);
  meter.setAttribute('role', 'img');
  meter.setAttribute('aria-label', `${FIT_LABELS[recommendation.fit]}, fit index ${value} of 100`);
  return meter;
}

function availabilityBadge(recommendation: BrowserRecommendation): HTMLElement | undefined {
  if (!((recommendation.available || 0) > 0)) return undefined;
  return badge(`${money(recommendation.available || 0)} available`, 'artizen-status-available');
}

function relationshipBadge(kind: keyof typeof RELATIONSHIP_LABELS): HTMLElement {
  const element = document.createElement('span');
  element.className = 'badge artizen-known-relationship';
  element.title = RELATIONSHIP_TITLES[kind];
  if (kind === 'submitted') {
    const icon = document.createElement('i');
    icon.className = 'bi bi-send';
    icon.setAttribute('aria-hidden', 'true');
    element.append(icon, document.createTextNode(RELATIONSHIP_LABELS[kind]));
  } else {
    element.textContent = RELATIONSHIP_LABELS[kind];
  }
  return element;
}

function statusBadges(recommendation: BrowserRecommendation, withAvailability = true): HTMLElement[] {
  const badges: HTMLElement[] = [];
  if (!recommendation.active) {
    badges.push(badge('Not curating new projects', 'artizen-status-inactive'));
  }
  const available = withAvailability ? availabilityBadge(recommendation) : undefined;
  if (available) badges.push(available);
  if (recommendation.knownRelationship) badges.push(relationshipBadge(recommendation.knownRelationship));
  return badges;
}

type CardExtras = {
  shortlisted: boolean;
  onShortlist: () => void;
  /** How this fund moved when the semantic reading replaced the baseline one. */
  movement?: 'up' | 'new';
};

const MOVEMENT_LABELS = {
  up: { text: '\u2191 Moved up', title: 'Local AI ranked this fund higher than the baseline reading did' },
  new: { text: 'New', title: 'Local AI brought this fund into the top matches' },
} as const;

function shortlistButton(fund: BrowserFund, extras: CardExtras): HTMLButtonElement {
  const star = document.createElement('button');
  star.type = 'button';
  star.className = 'artizen-match-card-star';
  star.setAttribute('aria-pressed', String(extras.shortlisted));
  star.setAttribute('aria-label', `${extras.shortlisted ? 'Remove' : 'Add'} ${fund.name} ${extras.shortlisted ? 'from' : 'to'} your shortlist`);
  star.title = extras.shortlisted ? 'On your shortlist' : 'Add to your shortlist';
  const icon = document.createElement('i');
  icon.className = extras.shortlisted ? 'bi bi-star-fill' : 'bi bi-star';
  icon.setAttribute('aria-hidden', 'true');
  star.append(icon);
  star.addEventListener('click', () => extras.onShortlist());
  return star;
}

function recommendationCard(
  fund: BrowserFund,
  recommendation: BrowserRecommendation,
  index: BrowserMatchIndex,
  openDetail: (fund: BrowserFund, recommendation: BrowserRecommendation) => void,
  extras: CardExtras,
): HTMLElement {
  const article = document.createElement('article');
  article.className = 'artizen-match-card';
  article.dataset.fund = fund.id;
  if (!recommendation.active) article.classList.add('artizen-match-card-inactive');

  const header = document.createElement('div');
  header.className = 'artizen-match-card-head';
  header.append(thumbnail(fund.image, 'artizen-match-thumb'));
  const heading = document.createElement('div');
  heading.className = 'artizen-match-card-title';
  const title = document.createElement('h3');
  const link = document.createElement('a');
  link.href = `/funds/${encodeURIComponent(fund.slug)}`;
  link.textContent = fund.name;
  title.append(link);
  // Fit, money, history, and inactivity sit together under the title.
  const marks = document.createElement('div');
  marks.className = 'artizen-match-card-marks';
  marks.append(badge(FIT_LABELS[recommendation.fit], `artizen-fit-${recommendation.fit}`));
  if (extras.movement) {
    const moved = MOVEMENT_LABELS[extras.movement];
    marks.append(badge(moved.text, 'artizen-match-moved', moved.title));
  }
  const available = availabilityBadge(recommendation);
  if (available) marks.append(available);
  marks.append(...statusBadges(recommendation, false));
  heading.append(title, marks);
  header.append(heading);
  article.append(header);

  const subtitle = document.createElement('p');
  subtitle.className = 'artizen-match-card-subtitle';
  subtitle.textContent = fund.subtitle || '';
  article.append(subtitle);

  article.append(fitMeter(recommendation, index));

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

  // Always the last subgrid row, so Fund details and the star sit at the bottom
  // of every card even when reasons are missing.
  const actions = document.createElement('div');
  actions.className = 'artizen-match-card-actions';
  const open = document.createElement('button');
  open.className = 'artizen-match-card-open';
  open.type = 'button';
  open.textContent = 'Fund details';
  open.setAttribute('aria-label', `Fund details for ${fund.name}`);
  open.addEventListener('click', () => openDetail(fund, recommendation));
  actions.append(open, shortlistButton(fund, extras));
  article.append(actions);
  return article;
}

function detailRow(label: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'artizen-fund-dialog-row';
  const name = document.createElement('dt');
  name.textContent = label;
  const detail = document.createElement('dd');
  detail.textContent = value;
  row.append(name, detail);
  return row;
}

function breakdownList(recommendation: BrowserRecommendation): HTMLElement | undefined {
  if (!('breakdown' in recommendation)) return undefined;
  const parts: Array<[string, number | undefined]> = [
    ['Shared language', recommendation.breakdown.lexical],
    ['Shared focus', recommendation.breakdown.facets],
    ['Distinctive concepts', recommendation.breakdown.coreCoverage],
    ['On-device similarity', recommendation.breakdown.semantic],
  ];
  const list = document.createElement('div');
  list.className = 'artizen-fund-dialog-breakdown';
  for (const [label, value] of parts) {
    if (value == null) continue;
    const row = document.createElement('div');
    const name = document.createElement('span');
    name.textContent = label;
    const track = document.createElement('span');
    track.className = 'artizen-match-fit-track';
    const fill = document.createElement('span');
    fill.className = 'artizen-match-fit-fill artizen-fit-fill-good';
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
    track.append(fill);
    row.append(name, track);
    list.append(row);
  }
  return list.childElementCount ? list : undefined;
}

function fundDetailNodes(
  fund: BrowserFund,
  recommendation: BrowserRecommendation,
  index: BrowserMatchIndex,
  semantic?: SemanticControl,
): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  const image = fund.image;
  if (image) {
    const banner = document.createElement('div');
    banner.className = 'artizen-fund-dialog-banner';
    const picture = document.createElement('img');
    picture.src = image;
    picture.alt = '';
    picture.loading = 'lazy';
    picture.referrerPolicy = 'no-referrer';
    picture.addEventListener('error', () => banner.remove(), { once: true });
    banner.append(picture);
    nodes.push(banner);
  }
  const title = document.createElement('h2');
  title.className = 'artizen-fund-dialog-title';
  title.textContent = fund.name;
  nodes.push(title);
  if (fund.subtitle) {
    const subtitle = document.createElement('p');
    subtitle.className = 'artizen-fund-dialog-subtitle';
    subtitle.textContent = fund.subtitle;
    nodes.push(subtitle);
  }

  const meta = document.createElement('div');
  meta.className = 'artizen-match-card-meta';
  meta.append(badge(FIT_LABELS[recommendation.fit], `artizen-fit-${recommendation.fit}`), ...statusBadges(recommendation));
  nodes.push(meta);
  nodes.push(fitMeter(recommendation, index));

  const breakdown = breakdownList(recommendation);
  if (breakdown) nodes.push(breakdown);

  const facts = document.createElement('dl');
  facts.className = 'artizen-fund-dialog-facts';
  if (fund.forTitle) facts.append(detailRow('For', fund.forTitle));
  if (recommendation.knownRelationship) {
    facts.append(detailRow('History', RELATIONSHIP_TITLES[recommendation.knownRelationship]));
  }
  const labels = facetLabels(index);
  const facets = fund.facets;
  if (facets.length) facts.append(detailRow('Focus', facets.map((facetId) => labels.get(facetId) || facetId).join(' · ')));
  if (facts.childElementCount) nodes.push(facts);

  if (recommendation.reasons.length) {
    const reasons = document.createElement('ul');
    reasons.className = 'artizen-match-reasons';
    for (const reason of recommendation.reasons) {
      const item = document.createElement('li');
      item.textContent = reason.label;
      reasons.append(item);
    }
    nodes.push(reasons);
  }

  if (semantic?.state() === 'available') {
    const upgrade = document.createElement('button');
    upgrade.type = 'button';
    upgrade.className = 'artizen-fund-dialog-ai';
    upgrade.innerHTML = '<i class="bi bi-stars" aria-hidden="true"></i>';
    const label = document.createElement('span');
    label.textContent = 'Sharpen this match with local AI';
    upgrade.append(label);
    const hint = document.createElement('span');
    hint.className = 'artizen-fund-dialog-ai-hint';
    hint.textContent = 'Compares meaning rather than words, for this fund and every other. Runs on your device.';
    upgrade.addEventListener('click', () => semantic.enable());
    nodes.push(upgrade, hint);
  }

  const actions = document.createElement('div');
  actions.className = 'artizen-fund-dialog-actions';
  const link = document.createElement('a');
  link.className = 'btn btn-dark';
  link.href = `/funds/${encodeURIComponent(fund.slug)}`;
  link.textContent = 'Open fund page';
  actions.append(link);
  nodes.push(actions);

  const note = document.createElement('p');
  note.className = 'artizen-match-note';
  note.textContent = 'Alignment describes thematic fit. It is not a guarantee of eligibility, an open application, or a current deadline.';
  nodes.push(note);
  return nodes;
}

type SemanticControl = {
  setInput(input: ProjectMatchInput): void;
  setSource(source: MatchOutcome['semanticSource'], downgrade?: MatchOutcome['semanticDowngrade']): void;
  /** 'available' when the on-device model could still be switched on for these results. */
  state(): 'available' | 'applied' | 'unavailable';
  enable(): void;
  /** Restores the project's stored description and tags. Only the form has anything to restore. */
  onUndo(handler: () => void): void;
};

function infoParagraphs(source: MatchOutcome['semanticSource']): string[] {
  const shared = [
    'Every fund is scored on how closely its own published wording matches your project: the words it uses, the focus areas it names, and the ideas that make it distinctive.',
    'Nothing about your history counts. Whether a fund has backed you before, whether it is curating, and how much money it holds are shown on the card but never change the ranking.',
  ];
  if (source === 'precomputed') {
    return [
      'These matches use meaning, not just matching words. A project about “regenerative farming” will find a fund that talks about “soil stewardship”, even though they share no vocabulary.',
      ...shared,
      'For projects already in the Artizen catalog this comparison is prepared in advance, so it costs nothing extra to run and works on any device.',
    ];
  }
  return [
    ...shared,
    'Turning on local AI adds a second reading that compares meaning rather than words, so a fund can match your project even when the two describe the same idea differently. It downloads a small model and runs entirely on your device. Your description never leaves this browser.',
  ];
}

function installInfoDialog(root: Element): (source: MatchOutcome['semanticSource']) => void {
  const dialog = find<HTMLDialogElement>(root, '[data-match-info-dialog]');
  const body = find<HTMLElement>(root, '[data-match-info-body]');
  const trigger = find<HTMLButtonElement>(root, '[data-match-info]');
  find<HTMLButtonElement>(root, '[data-match-info-close]')?.addEventListener('click', () => dialog?.close());
  let source: MatchOutcome['semanticSource'];

  function place(): void {
    if (!dialog || !trigger) return;
    // Wide viewports anchor the panel under the button like a popover; the stylesheet takes over
    // below the breakpoint and lays it out as a bottom sheet instead.
    if (!window.matchMedia('(min-width: 701px)').matches) {
      dialog.style.removeProperty('top');
      dialog.style.removeProperty('left');
      return;
    }
    const box = trigger.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 32);
    dialog.style.top = `${Math.round(box.bottom + 8)}px`;
    dialog.style.left = `${Math.round(Math.min(Math.max(16, box.right - width), window.innerWidth - width - 16))}px`;
  }

  trigger?.addEventListener('click', () => {
    if (!dialog || !body) return;
    body.replaceChildren(
      ...infoParagraphs(source).map((text) => {
        const paragraph = document.createElement('p');
        paragraph.textContent = text;
        return paragraph;
      }),
    );
    place();
    window.addEventListener('resize', reposition);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  });
  if (dialog && !('closedBy' in HTMLDialogElement.prototype)) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      const inside =
        event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (!inside) dialog.close();
    });
  }
  const reposition = () => {
    if (dialog?.open) place();
  };
  // Bound to the open lifetime: the results region is re-initialised on soft navigation, and a
  // document-lifetime listener would pin every detached dialog it ever built.
  dialog?.addEventListener('close', () => window.removeEventListener('resize', reposition));
  return (next) => {
    source = next;
  };
}

type FundDialog = {
  open(fund: BrowserFund, recommendation: BrowserRecommendation): void;
  /** Re-renders the panel in place when the scores behind it change. */
  refresh(recommendations: BrowserRecommendation[]): void;
};

function installFundDialog(
  root: Element,
  index: BrowserMatchIndex,
  semanticRef: { control?: SemanticControl },
): FundDialog {
  const dialog = find<HTMLDialogElement>(root, '[data-fund-dialog]');
  const body = find<HTMLElement>(root, '[data-fund-dialog-body]');
  find<HTMLButtonElement>(root, '[data-fund-dialog-close]')?.addEventListener('click', () => dialog?.close());
  // `closedby="any"` handles light dismiss natively where it is supported. Elsewhere, fall back to
  // a coordinate check: a click on the dialog's own padding also reports the dialog as its target,
  // so target-matching alone would close the panel when the user clicks just inside it.
  if (dialog && !('closedBy' in HTMLDialogElement.prototype)) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      const insidePanel =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom;
      if (!insidePanel) dialog.close();
    });
  }
  let shown: BrowserFund | undefined;

  function paint(fund: BrowserFund, recommendation: BrowserRecommendation): void {
    if (!body) return;
    body.replaceChildren(...fundDetailNodes(fund, recommendation, index, semanticRef.control));
  }

  return {
    open(fund, recommendation) {
      if (!dialog || !body) return;
      shown = fund;
      paint(fund, recommendation);
      dialog.setAttribute('aria-label', `${fund.name} details`);
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    },
    refresh(recommendations) {
      // Turning on the model from inside the dialog rescores every fund, including this one.
      if (!dialog?.open || !shown) return;
      const updated = recommendations.find((row) => row.fundId === shown!.id);
      if (!updated) return;
      const hadFocus = body ? body.contains(document.activeElement) : false;
      paint(shown, updated);
      // Repainting removes the button the user was standing on; without this, focus falls to the
      // inert body behind the modal and there is nothing to restore to on close.
      if (hadFocus) find<HTMLButtonElement>(root, '[data-fund-dialog-close]')?.focus();
    },
  };
}

type SortMode = 'fit' | 'available' | 'name';

/** `compare` marks what the on-device model just changed; nothing else claims credit for it. */
type ShowOptions = { compare?: boolean };

type ResultsView = {
  show(result: BrowserMatchResult, options?: ShowOptions): void;
  /** The selected project's own focus areas, shown so the filter vocabulary is legible. */
  setFocus(facets: string[]): void;
  /** Shortlists are per project, so switching projects switches lists. */
  setProject(projectId: string | undefined): void;
};

const SHORTLIST_KEY = 'artizen.match.shortlist';

function readShortlists(): Record<string, string[]> {
  try {
    const stored = JSON.parse(localStorage.getItem(SHORTLIST_KEY) || '{}') as unknown;
    return stored && typeof stored === 'object' ? (stored as Record<string, string[]>) : {};
  } catch {
    // Private browsing and disabled storage both throw here; a shortlist is not worth failing over.
    return {};
  }
}

function writeShortlists(value: Record<string, string[]>): void {
  try {
    localStorage.setItem(SHORTLIST_KEY, JSON.stringify(value));
  } catch {
    /* the in-memory set still works for this visit */
  }
}

function installResults(
  root: Element,
  index: BrowserMatchIndex,
  semanticRef: { control?: SemanticControl },
): ResultsView {
  const results = find<HTMLElement>(root, '[data-match-results]');
  const controls = find<HTMLElement>(root, '[data-match-controls]');
  const activeOnly = find<HTMLButtonElement>(root, '[data-filter-active]');
  const availableOnly = find<HTMLButtonElement>(root, '[data-filter-available]');
  const newOnly = find<HTMLButtonElement>(root, '[data-filter-new]');
  const shortlistOnly = find<HTMLButtonElement>(root, '[data-filter-shortlist]');
  const activeCount = find<HTMLElement>(root, '[data-count-active]');
  const availableCount = find<HTMLElement>(root, '[data-count-available]');
  const newCount = find<HTMLElement>(root, '[data-count-new]');
  const shortlistCount = find<HTMLElement>(root, '[data-count-shortlist]');
  const facetRow = find<HTMLElement>(root, '[data-facet-filters]');
  const facetChips = find<HTMLElement>(root, '[data-facet-chips]');
  const facetClear = find<HTMLButtonElement>(root, '[data-facet-clear]');
  const focusRow = find<HTMLElement>(root, '[data-project-focus]');
  const focusChips = find<HTMLElement>(root, '[data-project-focus-chips]');
  const fundSearch = find<HTMLInputElement>(root, '[data-fund-search]');
  const sortSelect = find<HTMLSelectElement>(root, '[data-match-sort]');
  const more = find<HTMLButtonElement>(root, '[data-match-more]');
  const collapse = find<HTMLButtonElement>(root, '[data-match-collapse]');
  const fundsById = new Map(index.funds.map((fund) => [fund.id, fund]));
  const labels = facetLabels(index);
  const fundDialog = installFundDialog(root, index, semanticRef);
  const selectedFacets = new Set<string>();
  let recommendations: BrowserRecommendation[] = [];
  let catalogOpen = false;
  let catalogLimit = INITIAL_RESULTS * 2;
  let query = '';
  let sort: SortMode = 'fit';
  let projectKey = '';
  let shortlist = new Set<string>();
  let previousOrder: string[] | undefined;
  /** Set by a new result set, cleared by the render that consumes it. */
  let stagger = false;
  const movement = new Map<string, 'up' | 'new'>();

  const pressed = (toggle: HTMLButtonElement | null) => toggle?.getAttribute('aria-pressed') === 'true';

  function persistShortlist(): void {
    const stored = readShortlists();
    if (shortlist.size) stored[projectKey] = [...shortlist];
    else delete stored[projectKey];
    writeShortlists(stored);
  }

  function fundFacets(fundId: string): string[] {
    const fund = fundsById.get(fundId);
    return fund?.facets || [];
  }

  function passesStatus(recommendation: BrowserRecommendation): boolean {
    if (pressed(activeOnly) && !recommendation.active) return false;
    if (pressed(availableOnly) && !((recommendation.available || 0) > 0)) return false;
    // The median project has three fund relationships and one has a hundred and twenty; those
    // funds already know the project, so hiding them turns the list into places left to try.
    if (pressed(newOnly) && recommendation.knownRelationship) return false;
    if (pressed(shortlistOnly) && !shortlist.has(recommendation.fundId)) return false;
    return true;
  }

  function passesQuery(recommendation: BrowserRecommendation): boolean {
    if (!query) return true;
    const fund = fundsById.get(recommendation.fundId);
    if (!fund) return false;
    return `${fund.name} ${fund.subtitle || ''} ${fund.forTitle || ''}`.toLowerCase().includes(query);
  }

  function passesFacets(recommendation: BrowserRecommendation): boolean {
    if (selectedFacets.size === 0) return true;
    return fundFacets(recommendation.fundId).some((facetId) => selectedFacets.has(facetId));
  }

  /**
   * Counts come from the set filtered by everything except facets, so choosing one chip never
   * hides the rest.
   *
   * Two tallies, because they answer different questions. The number on a chip has to be the
   * number of cards pressing it produces, so it counts the whole pool - it read 9 while the filter
   * returned 72 when it was counted over the evidence-backed subset instead. Ordering still uses
   * that subset, so facets with real evidence behind them lead.
   */
  function renderFacetChips(pool: BrowserRecommendation[], ranking: BrowserRecommendation[]): void {
    if (!facetChips || !facetRow) return;
    const tally = (rows: BrowserRecommendation[]) => {
      const into = new Map<string, number>();
      for (const recommendation of rows) {
        for (const facetId of fundFacets(recommendation.fundId)) into.set(facetId, (into.get(facetId) || 0) + 1);
      }
      return into;
    };
    const counts = tally(pool);
    const evidence = tally(ranking);
    for (const facetId of selectedFacets) if (!counts.has(facetId)) counts.set(facetId, 0);
    const ranked = [...counts.entries()].sort(
      (a, b) =>
        (evidence.get(b[0]) || 0) - (evidence.get(a[0]) || 0) ||
        b[1] - a[1] ||
        (labels.get(a[0]) || a[0]).localeCompare(labels.get(b[0]) || b[0]),
    );
    facetRow.hidden = ranked.length === 0;
    facetChips.replaceChildren();
    for (const [facetId, count] of ranked) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'artizen-facet-chip';
      chip.setAttribute('aria-pressed', String(selectedFacets.has(facetId)));
      const name = document.createElement('span');
      name.textContent = labels.get(facetId) || facetId;
      const tally = document.createElement('span');
      tally.className = 'artizen-facet-chip-count';
      tally.textContent = String(count);
      chip.append(name, tally);
      chip.dataset.facet = facetId;
      chip.addEventListener('click', () => {
        if (selectedFacets.has(facetId)) selectedFacets.delete(facetId);
        else selectedFacets.add(facetId);
        render();
        // The chip row is rebuilt on every render, so a keyboard user would otherwise be dropped
        // back to the top of the document after every toggle.
        find<HTMLButtonElement>(facetChips, `[data-facet="${CSS.escape(facetId)}"]`)?.focus();
      });
      facetChips.append(chip);
    }
    if (facetClear) facetClear.hidden = selectedFacets.size === 0;
  }

  function isEvidenceBacked(recommendation: BrowserRecommendation): boolean {
    return recommendation.fit === 'strong' || recommendation.fit === 'good';
  }

  /** Sorting reorders what is on screen; it never changes which funds were selected to be there. */
  function sortShown(rows: BrowserRecommendation[]): BrowserRecommendation[] {
    if (sort === 'fit') return rows;
    const named = (row: BrowserRecommendation) => fundsById.get(row.fundId)?.name || '';
    return [...rows].sort((a, b) =>
      sort === 'available'
        ? (b.available || 0) - (a.available || 0) || named(a).localeCompare(named(b))
        : named(a).localeCompare(named(b)),
    );
  }

  function toggleShortlist(fundId: string): void {
    if (shortlist.has(fundId)) shortlist.delete(fundId);
    else shortlist.add(fundId);
    persistShortlist();
    render();
    // Every card is rebuilt on render, so without this a keyboard user loses their place in the
    // grid the moment they star something.
    results?.querySelector<HTMLButtonElement>(`[data-fund="${CSS.escape(fundId)}"] .artizen-match-card-star`)?.focus();
  }

  function render(): void {
    if (!results || !more) return;
    results.replaceChildren();
    const source = recommendations;
    if (activeCount) activeCount.textContent = `${source.filter((row) => row.active).length}`;
    if (availableCount) availableCount.textContent = `${source.filter((row) => (row.available || 0) > 0).length}`;
    if (newCount) newCount.textContent = `${source.filter((row) => !row.knownRelationship).length}`;
    if (shortlistCount) shortlistCount.textContent = `${source.filter((row) => shortlist.has(row.fundId)).length}`;
    const statusPassed = source.filter(passesStatus).filter(passesQuery);
    // Chips are ordered by the funds worth narrowing between, so the no-evidence tail does not
    // push a facet up the row - but they are counted over everything the filter will return.
    const meaningful = statusPassed.filter((row) => row.fit !== 'limited');
    renderFacetChips(statusPassed, meaningful);
    const filtered = statusPassed.filter(passesFacets);
    // Half of all projects have fewer than ten evidence-backed matches, and some - those with no
    // taxonomy facets and a thin description - have none at all. Fill down through the bands
    // rather than showing an empty list; every card still carries the badge that says how thin
    // its evidence is.
    const evidence = filtered.filter(isEvidenceBacked);
    const explore = filtered.filter((row) => row.fit === 'exploratory');
    const thin = filtered.filter((row) => row.fit === 'limited');
    // Opening the catalog used to paint all 244 cards at once. Page it instead, in the same
    // twelves the recommendation list uses.
    //
    // Where the sort applies differs by view, and both readings are the honest one. Browsing the
    // catalog sorts everything and then pages, so page two continues page one. The recommendation
    // list picks its twelve by fit first and only then arranges them, because sorting the whole
    // catalog by name and taking twelve would just be the alphabet.
    const ranked = catalogOpen ? sortShown(filtered) : [...evidence, ...explore, ...thin];
    const shown = catalogOpen
      ? ranked.slice(0, catalogLimit)
      : sortShown(ranked.slice(0, INITIAL_RESULTS));
    shown.forEach((recommendation, position) => {
      const fund = fundsById.get(recommendation.fundId);
      if (!fund) return;
      const card = recommendationCard(fund, recommendation, index, fundDialog.open, {
        shortlisted: shortlist.has(recommendation.fundId),
        onShortlist: () => toggleShortlist(recommendation.fundId),
        movement: movement.get(recommendation.fundId),
      });
      // A new list arrives in sequence; narrowing an existing one just settles, because replaying
      // the stagger on every keystroke in the fund search would be a shimmer, not a signal.
      if (stagger) card.style.setProperty('--card-index', String(position));
      results.append(card);
    });
    stagger = false;
    // `filtered` is exactly what opening the catalog would render, so promise that number and
    // not the unfiltered total.
    const remaining = ranked.length - shown.length;
    more.hidden = recommendations.length === 0 || remaining <= 0;
    more.textContent = catalogOpen
      ? `Show ${Math.min(INITIAL_RESULTS, remaining)} more`
      : `View full fund catalog (${filtered.length})`;
    if (collapse) collapse.hidden = !catalogOpen;
    if (recommendations.length && filtered.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'artizen-match-empty';
      empty.textContent = emptyMessage(source, statusPassed);
      results.append(empty);
    }
    fundDialog.refresh(recommendations);
    if (recommendations.length === 0) return;
    // A filter or a search emptying the list is not the catalog failing to align, so stop blaming
    // the project. The guidance lives in the panel above, which is already on screen; the live
    // region states the fact instead of repeating the same sentence twice.
    if (filtered.length === 0) {
      setStatus(root, `No funds match the current filters. ${source.length} were ranked.`);
      return;
    }
    const hiddenByFacets = statusPassed.length - filtered.length;
    const facetNote = selectedFacets.size && hiddenByFacets > 0 ? ` ${hiddenByFacets} hidden by the focus filter.` : '';
    const backed = shown.filter(isEvidenceBacked).length;
    const moved = shown.filter((row) => movement.has(row.fundId)).length;
    const movedNote = moved ? ` Local AI moved ${moved} of them.` : '';
    // Filling down through the bands means the list can hold three kinds of card at once, so name
    // each kind rather than leaving the count short of what is on screen.
    const extras: Array<[number, string]> = [
      [shown.filter((row) => row.fit === 'exploratory').length, 'worth a look'],
      [shown.filter((row) => row.fit === 'limited').length, 'with limited evidence'],
    ];
    const tail = extras
      .filter(([count]) => count > 0)
      .map(([count, label]) => `${count} ${label}`)
      .join(' and ');
    setStatus(root, catalogOpen
      ? `Showing ${shown.length} of ${filtered.length} funds ranked by alignment, including limited-evidence results.${facetNote}`
      : backed
        ? `${backed} evidence-backed match${backed === 1 ? '' : 'es'}${tail ? `, plus ${tail}` : ''}.${facetNote}${movedNote}`
        : tail
          ? `No fund clears the evidence bar. Showing ${tail}.${facetNote}${movedNote}`
          : `No fund in the catalog aligns clearly with this project.${facetNote}`);
  }

  function emptyMessage(source: BrowserRecommendation[], statusPassed: BrowserRecommendation[]): string {
    if (statusPassed.length === 0 && source.length > 0) {
      if (query) return `No fund in these results is called “${query}”. Clear the search to see them all.`;
      if (pressed(shortlistOnly)) return 'Nothing is on your shortlist yet. Star a fund to add it.';
      return 'No funds match those filters. Turn off a filter to see the full alignment list.';
    }
    if (selectedFacets.size) {
      const unclassified = statusPassed.filter((row) => fundFacets(row.fundId).length === 0).length;
      const caveat = unclassified
        ? ` ${unclassified} fund${unclassified === 1 ? ' carries' : 's carry'} no focus tags and never match a focus filter.`
        : '';
      return `No funds match that focus.${caveat} Clear the focus filter to see the full list.`;
    }
    return 'No funds match the current filters.';
  }

  more?.addEventListener('click', () => {
    if (catalogOpen) catalogLimit += INITIAL_RESULTS;
    else {
      catalogOpen = true;
      catalogLimit = INITIAL_RESULTS * 2;
    }
    render();
  });
  collapse?.addEventListener('click', () => {
    catalogOpen = false;
    catalogLimit = INITIAL_RESULTS * 2;
    render();
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    results?.scrollIntoView({ behavior, block: 'start' });
  });
  for (const toggle of [activeOnly, availableOnly, newOnly, shortlistOnly]) {
    toggle?.addEventListener('click', () => {
      toggle.setAttribute('aria-pressed', String(!pressed(toggle)));
      catalogOpen = false;
      catalogLimit = INITIAL_RESULTS * 2;
      render();
    });
  }
  facetClear?.addEventListener('click', () => {
    selectedFacets.clear();
    render();
  });
  fundSearch?.addEventListener('input', () => {
    query = fundSearch.value.trim().toLowerCase();
    render();
  });
  sortSelect?.addEventListener('change', () => {
    sort = (sortSelect.value as SortMode) || 'fit';
    render();
  });

  /**
   * Local AI changes roughly a third of a list and the top match more often than not, but until
   * now nothing on screen said so - the cards simply reordered. Comparing the ranking before and
   * after marks what actually moved, which is the only evidence the download was worth it.
   *
   * Only the on-device run gets to claim this. Restoring a refinement also swaps a baseline list
   * for a semantic one, and calling that "local AI" would credit a download that never happened.
   */
  function markMovement(result: BrowserMatchResult, compare: boolean): void {
    const order = result.recommendations.map((row) => row.fundId);
    movement.clear();
    if (compare && previousOrder) {
      const before = new Map(previousOrder.map((fundId, rank) => [fundId, rank]));
      order.forEach((fundId, rank) => {
        const was = before.get(fundId);
        if (was == null) return;
        if (was >= INITIAL_RESULTS && rank < INITIAL_RESULTS) movement.set(fundId, 'new');
        else if (was - rank > 2) movement.set(fundId, 'up');
      });
    }
    previousOrder = order;
  }

  return {
    setFocus(facets) {
      if (!focusRow || !focusChips) return;
      focusRow.hidden = facets.length === 0;
      focusChips.replaceChildren();
      for (const facetId of facets) {
        const chip = document.createElement('span');
        chip.className = 'artizen-project-focus-chip';
        chip.setAttribute('role', 'listitem');
        chip.textContent = labels.get(facetId) || facetId;
        focusChips.append(chip);
      }
    },
    setProject(projectId) {
      projectKey = projectId || '';
      const stored = readShortlists()[projectKey];
      shortlist = new Set(Array.isArray(stored) ? stored : []);
    },
    show(result, options) {
      markMovement(result, options?.compare === true);
      stagger = true;
      recommendations = result.recommendations;
      catalogOpen = false;
      catalogLimit = INITIAL_RESULTS * 2;
      selectedFacets.clear();
      if (controls) controls.hidden = recommendations.length === 0;
      if (!result.sufficient) {
        results?.replaceChildren();
        if (more) more.hidden = true;
        if (collapse) collapse.hidden = true;
        setStatus(root, 'Add a little more about the project or choose an impact tag before matching.');
        return;
      }
      if (recommendations.length === 0) {
        results?.replaceChildren();
        if (more) more.hidden = true;
        if (collapse) collapse.hidden = true;
        setStatus(root, 'No evidence-backed fund matches were found for this description. Try adding more detail or an impact tag.');
        return;
      }
      render();
    },
  };
}

function modelDownloadLabel(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function modelWeightsUrl(manifest: SemanticCatalogManifest): string {
  return `${manifest.modelPath}${manifest.modelId}/onnx/model_quantized.onnx`;
}

/**
 * The pinned weights are generated by `npm run prepare:semantic` and are not checked in, so a
 * deployment can easily be missing them. Offering a button that is guaranteed to fail is worse
 * than not offering it, so confirm the weights are served before revealing the control.
 */
async function modelAvailable(manifest: SemanticCatalogManifest): Promise<boolean> {
  try {
    const response = await fetch(modelWeightsUrl(manifest), { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || 'the model could not be loaded';
}

function installSemanticControl(
  root: Element,
  engine: BrowserMatcher,
  render: (result: BrowserMatchResult, options?: ShowOptions) => void,
): SemanticControl {
  const controls = find<HTMLElement>(root, '[data-semantic-controls]');
  const button = find<HTMLButtonElement>(root, '[data-semantic-button]');
  const label = find<HTMLElement>(root, '[data-semantic-label]');
  const size = find<HTMLElement>(root, '[data-semantic-size]');
  const progress = find<HTMLProgressElement>(root, '[data-semantic-progress]');
  const status = find<HTMLElement>(root, '[data-semantic-status]');
  const undo = find<HTMLButtonElement>(root, '[data-semantic-undo]');
  const manifest = semanticManifest(engine.index);
  let input: ProjectMatchInput | undefined;
  let loading = false;
  let cancelled = false;
  let undoHandler: (() => void) | undefined;
  undo?.addEventListener('click', () => undoHandler?.());
  if (!controls || !button || !manifest) {
    return {
      setInput(value) {
        input = value;
      },
      setSource() {},
      state: () => 'unavailable',
      enable() {},
      onUndo(handler) {
        undoHandler = handler;
      },
    };
  }
  const idleLabel = 'Improve with local AI';
  const download = modelDownloadLabel(manifest.weightsBytes);
  // The size stays a quiet secondary chip rather than 25 characters of button label.
  const setLabel = (text: string, showSize: boolean) => {
    if (label) label.textContent = text;
    if (size) {
      size.textContent = showSize ? download : '';
      size.hidden = !showSize;
    }
  };
  button.title = `Runs a ${download} on this device. Nothing leaves the browser.`;
  setLabel(idleLabel, true);
  let modelReady = false;
  let lastSource: MatchOutcome['semanticSource'];
  let lastDowngrade: MatchOutcome['semanticDowngrade'];
  /**
   * Editing the description or the tags means the input is no longer the text that was embedded at
   * build time, so the prepared comparison silently stops applying and the results drop back to
   * keyword matching. That used to happen with no explanation at all; say it, and offer the two
   * ways out - run the model here, or put the refinements back.
   */
  const applySource = (): void => {
    const precomputed = lastSource === 'precomputed';
    const edited = !lastSource && lastDowngrade === 'edited';
    button.hidden = precomputed;
    if (progress) progress.hidden = progress.hidden || precomputed;
    if (undo) undo.hidden = !edited || !undoHandler;
    // Three reasons there is nothing to offer, and in all of them the control goes rather than
    // sitting there refusing to work: the model is not served, the comparison is already prepared
    // (the button would download 50 MB to reproduce the answer on screen), or nothing has been
    // matched yet so there are no results to improve.
    controls.hidden = precomputed || !modelReady || !input;
    if (!status) return;
    if (edited) {
      status.textContent = modelReady
        ? 'Your edits mean the prepared comparison no longer applies. Turn on local AI to compare meaning again.'
        : 'Your edits mean the prepared comparison no longer applies, so these results compare words rather than meaning.';
    } else if (status.textContent.startsWith('Your edits')) {
      status.textContent = '';
    }
  };

  let availabilityCheck = 0;
  const refreshModelAvailability = async (): Promise<void> => {
    const check = ++availabilityCheck;
    const ready = await modelAvailable(manifest);
    if (check !== availabilityCheck) return;
    modelReady = ready;
    applySource();
  };
  void refreshModelAvailability();
  // A transient HEAD failure at page load should not hide the feature for the whole session.
  // Recheck once after the page settles and whenever the browser reports that it is back online.
  window.setTimeout(() => {
    if (!modelReady) void refreshModelAvailability();
  }, 10_000);
  window.addEventListener('online', () => void refreshModelAvailability());
  button.addEventListener('click', async () => {
    if (!input) return;
    if (loading) {
      cancelled = true;
      engine.cancelSemantic();
      loading = false;
      setLabel(idleLabel, true);
      if (progress) progress.hidden = true;
      if (status) status.textContent = 'Local AI loading cancelled. Baseline recommendations are unchanged.';
      return;
    }
    loading = true;
    cancelled = false;
    setLabel('Cancel download', false);
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
      button.disabled = true;
      setLabel('Applying local AI…', false);
      const outcome = await engine.match(input, true);
      if (outcome.semanticFallback) throw new Error(outcome.semanticFallback);
      if (!('mode' in outcome.result) || outcome.result.mode !== 'semantic') {
        throw new Error('the local model did not score this project');
      }
      button.disabled = true;
      setLabel('Local AI applied', false);
      render(outcome.result, { compare: true });
      if (status) status.textContent = 'Recommendations now include private on-device semantic similarity.';
    } catch (error) {
      // cancelSemantic rejects synchronously, so this catch runs after the cancel branch has
      // already restored the idle state - do not overwrite it with a failure message.
      if (cancelled) return;
      button.disabled = false;
      setLabel('Retry local AI', false);
      if (status) status.textContent = `Local AI could not load: ${errorText(error)}. Baseline recommendations are unchanged.`;
    } finally {
      loading = false;
      if (progress) progress.hidden = true;
    }
  });
  return {
    setInput(value) {
      const first = !input;
      input = value;
      // A new project or description has not been through the model, so the control must stop
      // claiming it has - otherwise it reads "Local AI applied" over baseline results.
      if (loading || !button.disabled) {
        if (first) applySource();
        return;
      }
      button.disabled = false;
      setLabel(idleLabel, true);
      if (status) status.textContent = '';
      applySource();
    },
    state: () => (button.disabled ? 'applied' : controls.hidden || button.hidden ? 'unavailable' : 'available'),
    enable: () => button.click(),
    onUndo(handler) {
      undoHandler = handler;
      applySource();
    },
    // A catalog project is already scored against build-time embeddings, so offering a 50 MB
    // download that would reproduce the same answer would be worse than useless.
    setSource(source, downgrade) {
      lastSource = source;
      lastDowngrade = downgrade;
      applySource();
    },
  };
}

class TagPicker {
  private tags: string[] = [];
  private readonly input: HTMLInputElement | null;
  private readonly list: HTMLElement | null;
  /** Suppresses the change callback while the picker is being filled from a stored project. */
  private silent = false;

  constructor(
    private readonly root: Element,
    private readonly limit: number | null = 8,
    private readonly onChange: () => void = () => {},
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
    this.silent = true;
    try {
      this.tags = [];
      const selected = this.limit == null ? values : values.slice(0, this.limit);
      for (const value of selected) this.add(value, false);
      this.render();
    } finally {
      this.silent = false;
    }
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
    if (this.list) {
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
    if (!this.silent) this.onChange();
  }
}

function fillTagCatalog(root: Element, projects: ProjectProfile[]): void {
  const tagOptions = find<HTMLDataListElement>(root, '[data-tag-options]');
  if (!tagOptions || tagOptions.childElementCount) return;
  const tags = [...new Set(projects.flatMap((project) => project.tags))].sort((a, b) => a.localeCompare(b));
  for (const tag of tags) {
    const option = document.createElement('option');
    option.value = tag;
    tagOptions.append(option);
  }
}

function projectFacets(project: ProjectProfile): string[] {
  return project.facets || [];
}

async function initializeDetail(root: Element, engine: BrowserMatcher): Promise<void> {
  const id = (root as HTMLElement).dataset.projectId;
  const slug = (root as HTMLElement).dataset.projectSlug || decodeURIComponent(location.pathname.split('/').pop() || '');
  const projectReference = id || slug;
  // One record, not the whole list: this page already knows which project it is about.
  const projects = await engine
    .loadProjects(`/match/project/${encodeURIComponent(projectReference)}.json`)
    .catch(() => [] as ProjectProfile[]);
  const project = projects.find((candidate) => (id && candidate.id === id) || candidate.slug === slug);
  if (!project) {
    setStatus(root, 'This project is not in the current matching catalog yet. Try the project description tool instead.');
    return;
  }
  const semanticRef: { control?: SemanticControl } = {};
  const view = installResults(root, engine.index, semanticRef);
  const semantic = installSemanticControl(root, engine, view.show);
  semanticRef.control = semantic;
  const setInfoSource = installInfoDialog(root);
  const input = matchInputForProject(project);
  view.setProject(project.id);
  view.setFocus(projectFacets(project));
  semantic.setInput(input);
  const outcome = await engine.match(input);
  semantic.setSource(outcome.semanticSource, outcome.semanticDowngrade);
  setInfoSource(outcome.semanticSource);
  view.show(outcome.result);
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
  const tagPrompt = find<HTMLElement>(root, '[data-tag-prompt]');
  const refine = find<HTMLDetailsElement>(root, '[data-match-refine]');
  const output = find<HTMLElement>(root, '.artizen-match-output');
  const submit = find<HTMLButtonElement>(root, '[type="submit"]');
  const existingPickerRoot = find(root, '[data-tag-picker="existing"]');
  const describePickerRoot = find(root, '[data-tag-picker="describe"]');
  const existingTags = existingPickerRoot
    ? new TagPicker(existingPickerRoot, null, () => {
        renderTagPrompt();
        refreshSubmitLabel();
      })
    : undefined;
  const describeTags = describePickerRoot ? new TagPicker(describePickerRoot) : undefined;
  const semanticRef: { control?: SemanticControl } = {};
  const view = installResults(root, engine.index, semanticRef);
  const semantic = installSemanticControl(root, engine, view.show);
  semanticRef.control = semantic;
  const setInfoSource = installInfoDialog(root);
  const projectClear = find<HTMLButtonElement>(root, '[data-project-clear]');
  const submitLabel = submit?.textContent || 'Find matching funds';
  let source = 'existing';
  let chosenProject: ProjectProfile | undefined;
  let visibleProjects: ProjectProfile[] = [];
  let activeProject = -1;
  let projects: ProjectProfile[] = engine.projects;
  let projectsState: 'idle' | 'loading' | 'ready' | 'error' = projects.length ? 'ready' : 'idle';
  let projectsLoad: Promise<void> | undefined;
  let matchToken = 0;
  let revealed = false;
  if (projectsState === 'ready') fillTagCatalog(root, projects);

  /**
   * The project list is 1.4 MB and no other part of this page needs it, so it is fetched the first
   * time someone reaches for the picker rather than on load. Memoised as a promise rather than a
   * flag, so a submit that races the picker waits for the same load instead of deciding on its own
   * that the catalog is empty.
   */
  function ensureProjects(): Promise<void> {
    projectsLoad ||= loadProjectsOnce();
    return projectsLoad;
  }

  async function loadProjectsOnce(): Promise<void> {
    if (projectsState === 'ready') return;
    projectsState = 'loading';
    announce('Loading projects…');
    try {
      projects = await engine.loadProjects();
      projectsState = 'ready';
      fillTagCatalog(root, projects);
    } catch {
      projectsState = 'error';
      announce('The project list could not be loaded. Describe the project instead.');
    }
    if (projectOptions && !projectOptions.hidden) renderProjectOptions();
  }

  function announce(message: string): void {
    if (projectSearchStatus) projectSearchStatus.textContent = message;
  }

  function slugLine(slug: string): HTMLElement {
    const handle = document.createElement('span');
    handle.className = 'artizen-match-preview-slug';
    handle.textContent = slug;
    return handle;
  }

  function projectImage(project: ProjectProfile): string | undefined {
    return project.image;
  }

  function selectedProject(): ProjectProfile | undefined {
    if (!projectInput) return undefined;
    return chosenProject || pickerState(projects, projectInput.value, 'commit').committed;
  }

  /**
   * A third of catalog projects carry no impact tags, and tags are the single largest lever on
   * match quality: tagged projects average 7.6 evidence-backed matches against 3.4, and 30% of
   * untagged projects have no evidence-backed match at all. The picker for them was buried in a
   * collapsed disclosure, so say what it is worth and open it on request.
   */
  function renderTagPrompt(): void {
    if (!tagPrompt) return;
    const missing = Boolean(chosenProject) && (existingTags?.values().length || 0) === 0;
    tagPrompt.hidden = !missing;
    if (!missing) {
      tagPrompt.replaceChildren();
      return;
    }
    const icon = document.createElement('i');
    icon.className = 'bi bi-tags artizen-tag-prompt-icon';
    icon.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span');
    const lead = document.createElement('strong');
    lead.textContent = 'This project has no impact tags. ';
    copy.append(lead, document.createTextNode('Projects with tags find about twice as many funds.'));
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'artizen-tag-prompt-action';
    action.textContent = 'Add impact tags';
    action.addEventListener('click', () => {
      if (refine) refine.open = true;
      find<HTMLInputElement>(root, '[data-tag-picker="existing"] [data-tag-input]')?.focus();
    });
    tagPrompt.replaceChildren(icon, copy, action);
  }

  /**
   * The preview is always in the layout, empty or not. It used to be toggled with `hidden`, which
   * pushed the refine block, the submit button, and the whole results section down the moment a
   * project was picked.
   */
  function showProject(project: ProjectProfile | undefined): void {
    if (projectClear) projectClear.hidden = !projectInput?.value;
    if (!preview) return;
    preview.replaceChildren();
    preview.classList.toggle('artizen-match-project-preview-empty', !project);
    if (!project) {
      const icon = document.createElement('i');
      icon.className = 'bi bi-collection artizen-match-preview-icon';
      icon.setAttribute('aria-hidden', 'true');
      const placeholder = document.createElement('span');
      placeholder.textContent = 'Choose a project to compare it with the fund catalog.';
      preview.append(icon, placeholder);
      if (existingDescription) existingDescription.value = '';
      existingTags?.set([]);
      renderTagPrompt();
      refreshSubmitLabel();
      return;
    }
    const name = document.createElement('strong');
    name.className = 'artizen-match-preview-name';
    name.textContent = project.name;
    const detail = document.createElement('span');
    detail.className = 'artizen-match-preview-detail';
    detail.textContent = project.description || 'No public project description';
    preview.append(
      thumbnail(projectImage(project), 'artizen-match-preview-thumb'),
      name,
      detail,
      project.tags.length ? tagChips(project.tags, 4) : slugLine(project.slug),
    );
    const change = document.createElement('button');
    change.type = 'button';
    change.className = 'artizen-match-preview-change';
    change.textContent = 'Change';
    change.addEventListener('click', () => clearProject());
    preview.append(change);
    if (existingDescription) existingDescription.value = project.description;
    existingTags?.set(project.tags);
    renderTagPrompt();
    refreshSubmitLabel();
  }

  function closeProjectOptions(): void {
    if (!projectInput || !projectOptions) return;
    projectOptions.hidden = true;
    projectInput.setAttribute('aria-expanded', 'false');
    projectInput.removeAttribute('aria-activedescendant');
    activeProject = -1;
  }

  function setActiveProject(index: number, scroll = false): void {
    if (!projectInput || !projectOptions) return;
    activeProject = visibleProjects.length === 0 ? -1 : Math.max(-1, Math.min(index, visibleProjects.length - 1));
    if (activeProject < 0) projectInput.removeAttribute('aria-activedescendant');
    projectOptions.querySelectorAll<HTMLElement>('[role="option"]').forEach((option, optionIndex) => {
      const active = optionIndex === activeProject;
      option.setAttribute('aria-selected', String(active));
      if (!active) return;
      projectInput.setAttribute('aria-activedescendant', option.id);
      if (scroll) option.scrollIntoView({ block: 'nearest' });
    });
  }

  function existingInput(project: ProjectProfile): ProjectMatchInput {
    const refinedDescription = existingDescription ? existingDescription.value.trim() : project.description;
    const refinedTags = existingTags ? existingTags.values() : project.tags;
    return matchInputForProject(
      project,
      refinedDescription,
      refinedTags,
    );
  }

  /**
   * Selecting a project already matches it, so the button's only remaining job is applying a
   * refinement. It says so only when there is one: "Update matches" over an untouched project read
   * as though something were pending, and picking a different project left the old label standing.
   */
  function refreshSubmitLabel(): void {
    if (!submit) return;
    const project = source === 'existing' ? chosenProject : undefined;
    if (!project) {
      submit.textContent = submitLabel;
      return;
    }
    // Compared through `existingInput`, so "refined" means exactly what the submit would send,
    // including a deliberately emptied description or an empty tag list.
    const pending = existingInput(project);
    const refined =
      pending.description !== project.description ||
      pending.tags.join('\u0000') !== project.tags.join('\u0000');
    submit.textContent = refined ? 'Update matches' : submitLabel;
  }

  /**
   * Matching a catalog project waits on the vector catalog; matching freeform text does not. Two
   * requests in flight can therefore finish out of order - pick a project, switch to Describe,
   * submit, and the abandoned project's results land on top of the ones asked for second. The
   * token makes the newest request the only one allowed to paint.
   */
  async function runMatch(input: ProjectMatchInput, reveal = true): Promise<void> {
    const token = ++matchToken;
    if (submit) submit.disabled = true;
    setStatus(root, 'Comparing this project with the fund catalog…');
    try {
      semantic.setInput(input);
      const outcome = await engine.match(input);
      if (token !== matchToken) return;
      semantic.setSource(outcome.semanticSource, outcome.semanticDowngrade);
      setInfoSource(outcome.semanticSource);
      view.show(outcome.result);
      if (reveal) revealResults();
    } catch {
      if (token === matchToken) setStatus(root, 'The matching engine could not finish. Reload the page and try again.');
    } finally {
      if (submit && token === matchToken) submit.disabled = false;
    }
  }

  /** Once, and only after a deliberate choice: taking the scroll on page load would be a hijack. */
  function revealResults(): void {
    if (revealed || !output) return;
    revealed = true;
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    output.scrollIntoView({ behavior, block: 'start' });
  }

  function chooseProject(project: ProjectProfile, reveal = true): void {
    if (!projectInput) return;
    chosenProject = project;
    projectInput.value = project.name;
    projectInput.setCustomValidity('');
    showProject(project);
    closeProjectOptions();
    announce(`${project.name} selected.`);
    view.setProject(project.id);
    view.setFocus(projectFacets(project));
    // Scoring a catalog project is a dot product against vectors already in memory, so there is
    // nothing for a separate submit step to buy.
    void runMatch(existingInput(project), reveal);
  }

  function clearProject(): void {
    if (!projectInput) return;
    chosenProject = undefined;
    projectInput.value = '';
    projectInput.setCustomValidity('');
    showProject(undefined);
    closeProjectOptions();
    projectInput.focus();
    announce('Project search cleared.');
  }

  function renderProjectOptions(): void {
    if (!projectInput || !projectOptions) return;
    if (projectsState !== 'ready') {
      const notice = document.createElement('li');
      notice.className = 'artizen-project-option-empty';
      notice.textContent =
        projectsState === 'error' ? 'The project list could not be loaded.' : 'Loading projects…';
      projectOptions.replaceChildren(notice);
      projectOptions.hidden = false;
      projectInput.setAttribute('aria-expanded', 'true');
      visibleProjects = [];
      activeProject = -1;
      return;
    }
    const state = pickerState(projects, projectInput.value, 'typing');
    visibleProjects = state.options;
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
        option.append(thumbnail(projectImage(project), 'artizen-project-option-thumb'));
        const copy = document.createElement('div');
        copy.className = 'artizen-project-option-copy';
        const name = document.createElement('strong');
        name.textContent = project.name;
        copy.append(name);
        if (project.tags.length) {
          copy.append(tagChips(project.tags, 3));
        } else {
          const detail = document.createElement('span');
          detail.className = 'artizen-project-option-detail';
          detail.textContent = project.description || project.slug;
          copy.append(detail);
        }
        option.append(copy);
        option.addEventListener('pointerdown', (event) => event.preventDefault());
        option.addEventListener('click', () => chooseProject(project));
        projectOptions.append(option);
      });
    }
    projectOptions.hidden = false;
    projectInput.setAttribute('aria-expanded', 'true');
    setActiveProject(state.activeIndex);
    // An empty query lists the most fund-engaged projects rather than whatever sorts first, which
    // in this catalog is a run of punctuation-led placeholder names.
    announce(
      visibleProjects.length
        ? projectInput.value.trim()
          ? `${visibleProjects.length} project${visibleProjects.length === 1 ? '' : 's'} available.`
          : `Showing ${visibleProjects.length} projects with the most fund history. Start typing to search all ${projects.length}.`
        : 'No projects match that search.',
    );
  }

  function syncMode(next: string): void {
    source = next;
    root.querySelectorAll<HTMLElement>('[data-source-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.sourcePanel !== source;
    });
    if (projectInput) projectInput.required = source === 'existing';
    if (source !== 'existing') projectInput?.setCustomValidity('');
    if (description) description.required = source === 'describe';
    refreshSubmitLabel();
  }

  // Restoring the stored description and tags puts the input back on the prepared comparison,
  // which is the cheapest way to get semantic matching back after a refinement.
  semantic.onUndo(() => {
    const project = selectedProject();
    if (!project) return;
    if (existingDescription) existingDescription.value = project.description;
    existingTags?.set(project.tags);
    renderTagPrompt();
    refreshSubmitLabel();
    void runMatch(matchInputForProject(project));
  });

  root.querySelectorAll<HTMLInputElement>('[name="match-source"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) syncMode(radio.value);
    });
  });
  projectInput?.addEventListener('focus', () => {
    void ensureProjects();
    renderProjectOptions();
  });
  projectInput?.addEventListener('input', () => {
    // Typing never selects. The catalog contains projects whose whole name or slug is one
    // character ("w" is a real slug), so committing on an exact match mid-word rewrote the field
    // out from under the user and made it impossible to search for anything else.
    chosenProject = undefined;
    projectInput.setCustomValidity('');
    showProject(undefined);
    void ensureProjects();
    renderProjectOptions();
  });
  projectInput?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      // Reopening pre-highlights the first option, so step from "nothing selected" rather than
      // from that highlight - otherwise the first arrow press jumps past the first result.
      const reopened = Boolean(projectOptions?.hidden);
      if (reopened) renderProjectOptions();
      const from = reopened ? -1 : activeProject;
      setActiveProject(moveActive(from, visibleProjects.length, event.key === 'ArrowDown' ? 1 : -1), true);
    } else if (event.key === 'Enter' && !projectOptions?.hidden && activeProject >= 0 && visibleProjects[activeProject]) {
      event.preventDefault();
      chooseProject(visibleProjects[activeProject]);
    } else if (event.key === 'Enter' && selectedProject()) {
      event.preventDefault();
      form?.requestSubmit();
    } else if (event.key === 'Escape') {
      if (projectInput.value && projectOptions?.hidden) clearProject();
      else closeProjectOptions();
    }
  });
  projectInput?.addEventListener('blur', () => {
    window.setTimeout(() => {
      closeProjectOptions();
      // Text typed or pasted in full still selects, but only once the user has stopped typing.
      // Not after switching to Describe, though: the radio's change event fires inside this delay,
      // and committing then would match a project the user just walked away from.
      if (chosenProject || !projectInput || source !== 'existing') return;
      const committed = pickerState(projects, projectInput.value, 'commit').committed;
      if (committed) chooseProject(committed);
    }, 120);
  });
  existingDescription?.addEventListener('input', () => refreshSubmitLabel());
  projectClear?.addEventListener('pointerdown', (event) => event.preventDefault());
  projectClear?.addEventListener('click', () => clearProject());

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (source === 'existing') await ensureProjects();
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
      view.setProject(project.id);
      view.setFocus(projectFacets(project));
      input = existingInput(project);
    } else {
      view.setProject(undefined);
      view.setFocus([]);
      input = {
        title: title?.value.trim() || undefined,
        description: description?.value.trim() || '',
        tags: describeTags?.values() || [],
      };
    }
    await runMatch(input);
  });

  showProject(undefined);
  syncMode('existing');
  setStatus(root, readyMessage(engine.index));
  const requestedSlug = new URL(location.href).searchParams.get('project');
  if (requestedSlug && projectInput) {
    void ensureProjects().then(() => {
      const requested = projects.find((project) => project.slug === requestedSlug);
      // No scroll: the browser is still restoring its own position, and moving the page under
      // someone who has not touched it yet is a hijack whichever of the two wins.
      if (requested && !chosenProject) chooseProject(requested, false);
    });
  }
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
