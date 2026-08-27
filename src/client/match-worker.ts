/// <reference lib="webworker" />

import type { MatchIndex, ProjectMatchInput, ProjectProfile } from '../artizen/types';
import { matchFunds, prepareMatchIndex, type PreparedMatchIndex } from '../matching/engine';
import { mergeProjectProfiles } from '../matching/project-search';
import { PrecomputedSemanticScorer, type PrecomputedOutcome } from './precomputed-scorer';

type WorkerRequest =
  | { type: 'init'; index: MatchIndex }
  | { type: 'projects'; projects: ProjectProfile[] }
  | { type: 'match'; requestId: number; input: ProjectMatchInput; semantic?: boolean }
  | { type: 'semantic-load'; requestId: number }
  | { type: 'semantic-cancel' };

let prepared: PreparedMatchIndex | undefined;
let semanticScorer: import('./semantic-scorer').LocalSemanticScorer | undefined;
let semanticLoad: Promise<void> | undefined;
let semanticEpoch = 0;
let precomputed: PrecomputedSemanticScorer | undefined;

/** Initializes the release-scoped state. Subsequent project hydration preserves vector caches. */
function initializeIndex(index: MatchIndex): void {
  prepared = prepareMatchIndex(index);
  precomputed = index.semantic ? new PrecomputedSemanticScorer(index) : undefined;
}

/**
 * Catalog projects are embedded at build time, so semantic scoring for them costs a megabyte of
 * vectors rather than the model download. Try that first and only fall back to the on-device model
 * for freeform text or a project whose description has been edited.
 *
 * The catalogs are fetched on the first match that could use them rather than at init, so a
 * visitor reading a project page never pays for megabytes of vectors they do not need.
 */
async function precomputedScores(input: ProjectMatchInput): Promise<PrecomputedOutcome> {
  if (!precomputed || !input.projectId) return {};
  if (!(await precomputed.load())) return {};
  return precomputed.score(input);
}

/**
 * Semantic and baseline scores come from different weight profiles, so a fund missing from the
 * semantic map would be ranked by a different formula than its neighbours and could leap up the
 * list on its lexical overlap alone. Partial coverage means no semantic scoring at all.
 */
function coversEveryFund(scores: Map<string, number>, prepared: PreparedMatchIndex): boolean {
  return prepared.index.funds.every((fund) => scores.has(fund.id));
}

self.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  try {
    if (event.data.type === 'init') {
      initializeIndex(event.data.index);
      self.postMessage({ type: 'ready', indexVersion: event.data.index.indexVersion });
      return;
    }
    // The project list arrives separately from the core catalog - on the first use of the picker,
    // or as a single hydrated record on a project page. Messages can overlap, so merge by id
    // instead of replacing the list and keep the scorer's fund and shard caches intact.
    if (event.data.type === 'projects') {
      if (!prepared) return;
      const projects = mergeProjectProfiles(prepared.index.projects, event.data.projects);
      const nextIndex = { ...prepared.index, projects };
      prepared = prepareMatchIndex(nextIndex);
      precomputed?.updateProjects(projects);
      return;
    }
    if (event.data.type === 'semantic-cancel') {
      semanticEpoch += 1;
      semanticScorer?.dispose();
      semanticScorer = undefined;
      semanticLoad = undefined;
      return;
    }
    if (event.data.type === 'semantic-load') {
      if (!prepared || !prepared.index.semantic) throw new Error('Local AI is not available for this catalog');
      const requestId = event.data.requestId;
      const epoch = semanticEpoch;
      if (!semanticScorer) {
        const { LocalSemanticScorer } = await import('./semantic-scorer');
        // Cancellation can be handled by another message event while this chunk is importing.
        // Do not construct a fresh scorer and start the transformers import after that cancel.
        if (epoch !== semanticEpoch) return;
        semanticScorer = new LocalSemanticScorer(prepared.index);
      }
      if (!semanticLoad) {
        // A rejected promise memoised here can never recover, so "Retry local AI" used to replay
        // the original failure forever. Clear it on the way out so a retry actually retries - but
        // only if this scorer is still the current one, or a cancelled load would tear down the
        // load that replaced it.
        const scorer = semanticScorer;
        semanticLoad = scorer.load((progress) => {
          if (epoch === semanticEpoch) self.postMessage({ type: 'semantic-progress', requestId, progress });
        }).catch((error: unknown) => {
          scorer.dispose();
          if (semanticScorer === scorer) {
            semanticLoad = undefined;
            semanticScorer = undefined;
          }
          throw error;
        });
      }
      await semanticLoad;
      if (epoch !== semanticEpoch) throw new Error('Local AI loading was cancelled');
      self.postMessage({ type: 'semantic-ready', requestId });
      return;
    }
    if (!prepared) throw new Error('Matching index is not ready');
    let result;
    let semanticFallback: string | undefined;
    let semanticSource: 'precomputed' | 'on-device' | undefined;
    let semanticDowngrade: 'edited' | undefined;
    const ready = await precomputedScores(event.data.input);
    semanticDowngrade = ready.downgrade;
    if (ready.scores && coversEveryFund(ready.scores, prepared)) {
      result = matchFunds(prepared, event.data.input, ready.scores);
      semanticSource = 'precomputed';
    }
    if (!result && event.data.semantic) {
      try {
        if (!semanticScorer || !semanticLoad) throw new Error('Local AI is not loaded');
        await semanticLoad;
        const scores = await semanticScorer.score(
          event.data.input,
          prepared.index.funds.map((fund) => fund.id),
        );
        if (!coversEveryFund(scores, prepared)) throw new Error('The local model could not score every fund');
        result = matchFunds(prepared, event.data.input, scores);
        semanticSource = 'on-device';
      } catch (error) {
        result = matchFunds(prepared, event.data.input);
        semanticFallback = error instanceof Error ? error.message : String(error);
      }
    }
    if (!result) result = matchFunds(prepared, event.data.input);
    self.postMessage({
      type: 'result',
      requestId: event.data.requestId,
      result,
      semanticFallback,
      semanticSource,
      // Only worth reporting when nothing replaced it; an on-device run already covers the gap.
      semanticDowngrade: semanticSource ? undefined : semanticDowngrade,
    });
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId: 'requestId' in event.data ? event.data.requestId : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export {};
