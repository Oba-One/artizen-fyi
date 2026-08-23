import type {
  FundProfileV2,
  FundRecommendation,
  FundRecommendationV2,
  MatchIndexV1,
  MatchIndexV2,
  MatchResultV2,
  ProjectMatchInput,
} from '../artizen/types';
import type { MatchResult } from '../matching/engine';

const REVIEW_VERSION = 'cross-domain-review-2026-08-23.1';
const POOL_TOP = 12;

type Result = MatchResult | MatchResultV2;
type WorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; requestId: number; result: Result }
  | { type: 'semantic-progress'; requestId: number; progress: number }
  | { type: 'semantic-ready'; requestId: number }
  | { type: 'error'; requestId?: number; message: string };
type PendingResult = { resolve(value: Result): void; reject(error: Error): void };
type PendingLoad = { resolve(): void; reject(error: Error): void; progress(value: number): void };
type Rating = {
  projectId: string;
  fundId: string;
  grade: 0 | 1 | 2 | 3;
  note?: string;
  baseline?: FundRecommendationV2;
  semantic?: FundRecommendationV2;
  v1?: FundRecommendation;
};
type CandidateEvidence = {
  fund: FundProfileV2;
  v1?: { rank: number; recommendation: FundRecommendation };
  baseline: { rank: number; recommendation: FundRecommendationV2 };
  semantic?: { rank: number; recommendation: FundRecommendationV2 };
};

class ReviewWorker {
  private nextId = 0;
  private results = new Map<number, PendingResult>();
  private loads = new Map<number, PendingLoad>();

  private constructor(private readonly worker: Worker) {
    worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
      const data = event.data;
      if (data.type === 'result') {
        const pending = this.results.get(data.requestId);
        if (!pending) return;
        this.results.delete(data.requestId);
        pending.resolve(data.result);
      } else if (data.type === 'semantic-progress') {
        this.loads.get(data.requestId)?.progress(data.progress);
      } else if (data.type === 'semantic-ready') {
        const pending = this.loads.get(data.requestId);
        if (!pending) return;
        this.loads.delete(data.requestId);
        pending.resolve();
      } else if (data.type === 'error' && data.requestId != null) {
        this.results.get(data.requestId)?.reject(new Error(data.message));
        this.results.delete(data.requestId);
        this.loads.get(data.requestId)?.reject(new Error(data.message));
        this.loads.delete(data.requestId);
      }
    });
  }

  static async create(index: MatchIndexV1 | MatchIndexV2): Promise<ReviewWorker> {
    const worker = new Worker('/assets/match-worker.js', { type: 'module' });
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Review worker startup timed out')), 15_000);
      const listener = (event: MessageEvent<WorkerMessage>) => {
        if (event.data.type === 'ready') {
          clearTimeout(timeout);
          worker.removeEventListener('message', listener);
          resolve();
        }
      };
      worker.addEventListener('message', listener);
      worker.addEventListener('error', () => reject(new Error('Review worker failed')),
        { once: true });
      worker.postMessage({ type: 'init', index });
    });
    return new ReviewWorker(worker);
  }

  match(input: ProjectMatchInput, semantic = false): Promise<Result> {
    const requestId = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.results.set(requestId, { resolve, reject });
      this.worker.postMessage({ type: 'match', requestId, input, semantic });
    });
  }

  loadSemantic(progress: (value: number) => void): Promise<void> {
    const requestId = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.loads.set(requestId, { resolve, reject, progress });
      this.worker.postMessage({ type: 'semantic-load', requestId });
    });
  }
}

function find<T extends Element>(root: ParentNode, selector: string): T | null {
  return root.querySelector<T>(selector);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function splitFor(projectId: string): 'tuning' | 'holdout' {
  return stableHash(`${REVIEW_VERSION}:${projectId}`) % 4 === 0 ? 'holdout' : 'tuning';
}

function inputFor(index: MatchIndexV2, projectId: string): ProjectMatchInput {
  const project = index.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error('Project is missing from V2');
  return { projectId, title: project.name, description: project.description, tags: project.tags };
}

function ranked<T extends FundRecommendation>(recommendations: T[]): Map<string, { rank: number; recommendation: T }> {
  return new Map(recommendations.map((recommendation, index) => [recommendation.fundId, { rank: index + 1, recommendation }]));
}

function buildPool(
  index: MatchIndexV2,
  projectId: string,
  baseline: MatchResultV2,
  v1?: MatchResult,
  semantic?: MatchResultV2,
): CandidateEvidence[] {
  const baselineRanks = ranked(baseline.recommendations);
  const v1Ranks = v1 ? ranked(v1.recommendations) : new Map();
  const semanticRanks = semantic ? ranked(semantic.recommendations) : new Map();
  const ids = new Set<string>();
  baseline.recommendations.slice(0, POOL_TOP).forEach((row) => ids.add(row.fundId));
  v1?.recommendations.slice(0, POOL_TOP).forEach((row) => ids.add(row.fundId));
  semantic?.recommendations.slice(0, POOL_TOP).forEach((row) => ids.add(row.fundId));
  const project = index.projects.find((candidate) => candidate.id === projectId)!;
  index.funds
    .filter((fund) => fund.focusFacets.length > 0 && !fund.focusFacets.some((facet) => project.facets.includes(facet)))
    .sort((a, b) => stableHash(`${REVIEW_VERSION}:niche:${projectId}:${a.id}`) - stableHash(`${REVIEW_VERSION}:niche:${projectId}:${b.id}`))
    .slice(0, 6)
    .forEach((fund) => ids.add(fund.id));
  index.funds
    .filter((fund) => !ids.has(fund.id))
    .sort((a, b) => stableHash(`${REVIEW_VERSION}:negative:${projectId}:${a.id}`) - stableHash(`${REVIEW_VERSION}:negative:${projectId}:${b.id}`))
    .slice(0, 6)
    .forEach((fund) => ids.add(fund.id));
  const funds = new Map(index.funds.map((fund) => [fund.id, fund]));
  return [...ids]
    .flatMap((fundId) => {
      const fund = funds.get(fundId);
      const baselineRow = baselineRanks.get(fundId);
      if (!fund || !baselineRow) return [];
      return [{ fund, baseline: baselineRow, v1: v1Ranks.get(fundId), semantic: semanticRanks.get(fundId) }];
    })
    .sort(
      (a, b) =>
        stableHash(`${REVIEW_VERSION}:blind:${projectId}:${a.fund.id}`) -
          stableHash(`${REVIEW_VERSION}:blind:${projectId}:${b.fund.id}`) || a.fund.name.localeCompare(b.fund.name),
    );
}

function algorithmLine(label: string, row?: { rank: number; recommendation: FundRecommendation | FundRecommendationV2 }): string {
  if (!row) return `${label}: not in this review index`;
  const recommendation = row.recommendation;
  const breakdown = 'breakdown' in recommendation
    ? ` | lexical ${recommendation.breakdown.lexical.toFixed(3)}, facets ${recommendation.breakdown.facets.toFixed(3)}, core ${recommendation.breakdown.coreCoverage.toFixed(3)}${recommendation.breakdown.semantic == null ? '' : `, semantic ${recommendation.breakdown.semantic.toFixed(3)}`}`
    : '';
  return `${label}: rank ${row.rank}, score ${recommendation.score.toFixed(4)}, ${recommendation.fit}${breakdown}`;
}

async function initialize(root: HTMLElement): Promise<void> {
  const status = find<HTMLElement>(root, '[data-review-status]');
  const provenance = find<HTMLElement>(root, '[data-review-provenance]');
  const select = find<HTMLSelectElement>(root, '[data-review-project]');
  const candidateRoot = find<HTMLElement>(root, '[data-review-candidate]');
  const startButton = find<HTMLButtonElement>(root, '[data-review-start]');
  const aiButton = find<HTMLButtonElement>(root, '[data-review-ai]');
  const exportButton = find<HTMLButtonElement>(root, '[data-review-export]');
  const importInput = find<HTMLInputElement>(root, '[data-review-import]');
  const response = await fetch('/match/index.v2.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error('V2 review index is unavailable');
  const index = (await response.json()) as MatchIndexV2;
  const v1Response = await fetch('/match/index.json', { cache: 'no-cache' });
  const v1Index = v1Response.ok ? ((await v1Response.json()) as MatchIndexV1) : undefined;
  const v2Worker = await ReviewWorker.create(index);
  const v1Worker = v1Index ? await ReviewWorker.create(v1Index) : undefined;
  const ratings = new Map<string, Rating>();
  let pool: CandidateEvidence[] = [];
  let currentInput: ProjectMatchInput | undefined;
  let baselineResult: MatchResultV2 | undefined;
  let v1Result: MatchResult | undefined;
  let semanticResult: MatchResultV2 | undefined;

  const domainGroups = new Set(index.projects.flatMap((project) => project.facets.filter((facet) => /^(domain|medium):/.test(facet))));
  const coverageWarning = index.projects.length < 24 || domainGroups.size < 8;
  if (provenance) {
    provenance.replaceChildren();
    const fields = [
      ['Source', index.source.kind],
      ['Index', `V2 ${index.indexVersion}`],
      ['Generated', index.generatedAt],
      ['Records', `${index.source.projects} projects, ${index.source.funds} funds, ${index.source.relationships} display-only relationships`],
      ['Taxonomy', `${index.taxonomyVersion}; ${domainGroups.size} represented domain groups`],
      ['Split', `${REVIEW_VERSION}; deterministic tuning/locked holdout`],
    ];
    for (const [term, description] of fields) {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = term;
      dd.textContent = description;
      row.append(dt, dd);
      provenance.append(row);
    }
    if (coverageWarning) {
      const warning = document.createElement('p');
      warning.className = 'alert alert-warning';
      warning.textContent = `This QA index does not meet the 24-project / 8-domain review gate. It has ${index.projects.length} projects and ${domainGroups.size} domain groups.`;
      provenance.after(warning);
    }
  }
  if (select) {
    for (const project of [...index.projects].sort((a, b) => a.name.localeCompare(b.name))) {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = `${project.name} — ${splitFor(project.id)}`;
      select.append(option);
    }
  }
  if (aiButton && index.semantic) {
    aiButton.hidden = false;
    aiButton.textContent = `Include local AI candidates (${(index.semantic.weightsBytes / 1_000_000).toFixed(2)} MB model)`;
  }

  function ratingKey(projectId: string, fundId: string): string {
    return `${projectId}\0${fundId}`;
  }

  function renderCandidate(): void {
    if (!candidateRoot || !currentInput?.projectId) return;
    const candidate = pool.find((row) => !ratings.has(ratingKey(currentInput!.projectId!, row.fund.id)));
    candidateRoot.replaceChildren();
    candidateRoot.hidden = false;
    if (!candidate) {
      const done = document.createElement('p');
      done.className = 'alert alert-success';
      done.textContent = `Review complete for this pool. ${pool.length} candidates rated.`;
      candidateRoot.append(done);
      return;
    }
    const progress = document.createElement('p');
    const ratedCount = pool.filter((row) => ratings.has(ratingKey(currentInput!.projectId!, row.fund.id))).length;
    progress.className = 'text-muted';
    progress.textContent = `Candidate ${ratedCount + 1} of ${pool.length} · ${splitFor(currentInput.projectId)} split`;
    const title = document.createElement('h2');
    title.textContent = candidate.fund.name;
    const description = document.createElement('p');
    description.className = 'lead';
    description.textContent = candidate.fund.forTitle || candidate.fund.subtitle || candidate.fund.profileText;
    const prompt = document.createElement('p');
    prompt.textContent = 'How well does this fund align with the project?';
    const gradeRow = document.createElement('div');
    gradeRow.className = 'artizen-review-grades';
    const note = document.createElement('textarea');
    note.className = 'form-control';
    note.rows = 3;
    note.placeholder = 'Optional note';
    [
      [0, '0 · Mismatch'],
      [1, '1 · Weak'],
      [2, '2 · Good'],
      [3, '3 · Strong'],
    ].forEach(([grade, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-outline-dark';
      button.textContent = String(label);
      button.addEventListener('click', () => {
        ratings.set(ratingKey(currentInput!.projectId!, candidate.fund.id), {
          projectId: currentInput!.projectId!,
          fundId: candidate.fund.id,
          grade: grade as 0 | 1 | 2 | 3,
          note: note.value.trim() || undefined,
          baseline: candidate.baseline.recommendation,
          semantic: candidate.semantic?.recommendation,
          v1: candidate.v1?.recommendation,
        });
        const reveal = document.createElement('div');
        reveal.className = 'artizen-review-reveal';
        const heading = document.createElement('h3');
        heading.textContent = 'Ranking evidence revealed';
        const lines = document.createElement('ul');
        [
          algorithmLine('V1', candidate.v1),
          algorithmLine('V2 baseline', candidate.baseline),
          algorithmLine('V2 local AI', candidate.semantic),
          `Facets: ${candidate.fund.facets.join(', ') || 'none'}`,
          `Focus facets: ${candidate.fund.focusFacets.join(', ') || 'none'}`,
          `Core concepts: ${candidate.fund.coreConcepts.join(', ') || 'none'}`,
          `Relationship badge: ${candidate.baseline.recommendation.knownRelationship || 'none'}`,
        ].forEach((line) => {
          const item = document.createElement('li');
          item.textContent = line;
          lines.append(item);
        });
        const next = document.createElement('button');
        next.type = 'button';
        next.className = 'btn btn-dark';
        next.textContent = 'Next candidate';
        next.addEventListener('click', renderCandidate);
        reveal.append(heading, lines, next);
        gradeRow.replaceChildren(reveal);
        note.hidden = true;
      });
      gradeRow.append(button);
    });
    candidateRoot.append(progress, title, description, prompt, gradeRow, note);
  }

  async function start(includeSemantic = false): Promise<void> {
    if (!select?.value) return;
    currentInput = inputFor(index, select.value);
    if (status) status.textContent = 'Building a stable blind candidate pool…';
    baselineResult = (await v2Worker.match(currentInput)) as MatchResultV2;
    v1Result = v1Worker ? ((await v1Worker.match(currentInput)) as MatchResult) : undefined;
    if (includeSemantic) semanticResult = (await v2Worker.match(currentInput, true)) as MatchResultV2;
    else semanticResult = undefined;
    pool = buildPool(index, select.value, baselineResult, v1Result, semanticResult);
    if (status) status.textContent = `${pool.length} candidates ready in a stable blind order. Ratings are held in memory only.`;
    renderCandidate();
  }

  startButton?.addEventListener('click', () => void start(false));
  aiButton?.addEventListener('click', async () => {
    if (!aiButton) return;
    aiButton.disabled = true;
    try {
      await v2Worker.loadSemantic((value) => {
        if (status) status.textContent = `Loading local AI candidate source… ${Math.round(value * 100)}%`;
      });
      await start(true);
      aiButton.textContent = 'Local AI candidates included';
    } catch {
      aiButton.disabled = false;
      aiButton.textContent = 'Retry local AI candidates';
      if (status) status.textContent = 'Local AI was unavailable. The V1 and V2 baseline review pool is unchanged.';
    }
  });
  exportButton?.addEventListener('click', () => {
    const payload = {
      reviewVersion: REVIEW_VERSION,
      indexVersion: index.indexVersion,
      exportedAt: new Date().toISOString(),
      ratings: [...ratings.values()],
    };
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `artizen-match-review-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  });
  importInput?.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text()) as { reviewVersion?: string; ratings?: Rating[] };
      if (payload.reviewVersion !== REVIEW_VERSION || !Array.isArray(payload.ratings)) throw new Error('Wrong review version');
      payload.ratings.forEach((rating) => ratings.set(ratingKey(rating.projectId, rating.fundId), rating));
      if (status) status.textContent = `Imported ${payload.ratings.length} ratings into memory.`;
      renderCandidate();
    } catch {
      if (status) status.textContent = 'That ratings file is invalid or belongs to another review version.';
    }
    importInput.value = '';
  });
  if (status) status.textContent = 'Choose a project to begin. No ratings are persisted automatically.';
}

const root = document.querySelector<HTMLElement>('[data-review-root]');
if (root) void initialize(root).catch(() => {
  const status = find<HTMLElement>(root, '[data-review-status]');
  if (status) status.textContent = 'The local review runner could not initialize.';
});
