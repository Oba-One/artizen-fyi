/// <reference lib="webworker" />

import type { MatchIndexV1, MatchIndexV2, ProjectMatchInput, ProjectProfileV2 } from '../artizen/types';
import { matchFunds, prepareMatchIndex, type PreparedMatchIndex } from '../matching/engine';
import { matchFundsV2, prepareMatchIndexV2, type PreparedMatchIndexV2 } from '../matching/engine-v2';
import { PrecomputedSemanticScorer, type PrecomputedOutcome } from './precomputed-scorer';

type WorkerRequest =
  | { type: 'init'; index: MatchIndexV1 | MatchIndexV2 }
  | { type: 'projects'; projects: ProjectProfileV2[] }
  | { type: 'match'; requestId: number; input: ProjectMatchInput; semantic?: boolean }
  | { type: 'semantic-load'; requestId: number }
  | { type: 'semantic-cancel' };

let prepared: PreparedMatchIndex | undefined;
let preparedV2: PreparedMatchIndexV2 | undefined;
let semanticScorer: import('./semantic-scorer').LocalSemanticScorer | undefined;
let semanticLoad: Promise<void> | undefined;
let semanticEpoch = 0;
let precomputed: PrecomputedSemanticScorer | undefined;
let precomputedReady: Promise<boolean> | undefined;

/** Rebuilt whenever the project list changes, because both depend on which projects are known. */
function refreshProjectState(index: MatchIndexV2): void {
  preparedV2 = prepareMatchIndexV2(index);
  precomputed = index.semantic ? new PrecomputedSemanticScorer(index) : undefined;
  precomputedReady = undefined;
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
  precomputedReady ||= precomputed.load().catch(() => false);
  await precomputedReady;
  return precomputed.score(input);
}

/**
 * Semantic and baseline scores come from different weight profiles, so a fund missing from the
 * semantic map would be ranked by a different formula than its neighbours and could leap up the
 * list on its lexical overlap alone. Partial coverage means no semantic scoring at all.
 */
function coversEveryFund(scores: Map<string, number>, prepared: PreparedMatchIndexV2): boolean {
  return prepared.index.funds.every((fund) => scores.has(fund.id));
}

self.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  try {
    if (event.data.type === 'init') {
      if (event.data.index.schemaVersion === 2) {
        refreshProjectState(event.data.index);
        prepared = undefined;
      } else {
        prepared = prepareMatchIndex(event.data.index);
        preparedV2 = undefined;
        precomputed = undefined;
        precomputedReady = undefined;
      }
      self.postMessage({ type: 'ready', indexVersion: event.data.index.indexVersion });
      return;
    }
    // The project list arrives separately from the core catalog - on the first use of the picker,
    // or as a single record on a project page - so relationships and embedding fingerprints are
    // rebuilt when it lands rather than at init.
    if (event.data.type === 'projects') {
      if (!preparedV2) return;
      refreshProjectState({ ...preparedV2.index, projects: event.data.projects });
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
      if (!preparedV2 || !preparedV2.index.semantic) throw new Error('Local AI is not available for this catalog');
      const requestId = event.data.requestId;
      const epoch = semanticEpoch;
      if (!semanticScorer) {
        const { LocalSemanticScorer } = await import('./semantic-scorer');
        semanticScorer = new LocalSemanticScorer(preparedV2.index);
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
    if (!prepared && !preparedV2) throw new Error('Matching index is not ready');
    let result;
    let semanticFallback: string | undefined;
    let semanticSource: 'precomputed' | 'on-device' | undefined;
    let semanticDowngrade: 'edited' | undefined;
    if (preparedV2) {
      const ready = await precomputedScores(event.data.input);
      semanticDowngrade = ready.downgrade;
      if (ready.scores && coversEveryFund(ready.scores, preparedV2)) {
        result = matchFundsV2(preparedV2, event.data.input, ready.scores);
        semanticSource = 'precomputed';
      }
    }
    if (!result && preparedV2 && event.data.semantic) {
      try {
        if (!semanticScorer || !semanticLoad) throw new Error('Local AI is not loaded');
        await semanticLoad;
        const scores = await semanticScorer.score(
          event.data.input,
          preparedV2.index.funds.map((fund) => fund.id),
        );
        if (!coversEveryFund(scores, preparedV2)) throw new Error('The local model could not score every fund');
        result = matchFundsV2(preparedV2, event.data.input, scores);
        semanticSource = 'on-device';
      } catch (error) {
        result = matchFundsV2(preparedV2, event.data.input);
        semanticFallback = error instanceof Error ? error.message : String(error);
      }
    }
    if (!result) {
      result = preparedV2 ? matchFundsV2(preparedV2, event.data.input) : matchFunds(prepared!, event.data.input);
    }
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
