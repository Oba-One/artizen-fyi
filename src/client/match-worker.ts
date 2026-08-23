/// <reference lib="webworker" />

import type { MatchIndexV1, MatchIndexV2, ProjectMatchInput } from '../artizen/types';
import { matchFunds, prepareMatchIndex, type PreparedMatchIndex } from '../matching/engine';
import { matchFundsV2, prepareMatchIndexV2, type PreparedMatchIndexV2 } from '../matching/engine-v2';

type WorkerRequest =
  | { type: 'init'; index: MatchIndexV1 | MatchIndexV2 }
  | { type: 'match'; requestId: number; input: ProjectMatchInput; semantic?: boolean }
  | { type: 'semantic-load'; requestId: number }
  | { type: 'semantic-cancel' };

let prepared: PreparedMatchIndex | undefined;
let preparedV2: PreparedMatchIndexV2 | undefined;
let semanticScorer: import('./semantic-scorer').LocalSemanticScorer | undefined;
let semanticLoad: Promise<void> | undefined;
let semanticEpoch = 0;

self.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  try {
    if (event.data.type === 'init') {
      if (event.data.index.schemaVersion === 2) {
        preparedV2 = prepareMatchIndexV2(event.data.index);
        prepared = undefined;
      } else {
        prepared = prepareMatchIndex(event.data.index);
        preparedV2 = undefined;
      }
      self.postMessage({ type: 'ready', indexVersion: event.data.index.indexVersion });
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
      semanticLoad ||= semanticScorer.load((progress) => {
        if (epoch === semanticEpoch) self.postMessage({ type: 'semantic-progress', requestId, progress });
      });
      await semanticLoad;
      if (epoch !== semanticEpoch) throw new Error('Local AI loading was cancelled');
      self.postMessage({ type: 'semantic-ready', requestId });
      return;
    }
    if (!prepared && !preparedV2) throw new Error('Matching index is not ready');
    let result;
    let semanticFallback: string | undefined;
    if (preparedV2 && event.data.semantic) {
      try {
        if (!semanticScorer || !semanticLoad) throw new Error('Local AI is not loaded');
        await semanticLoad;
        const scores = await semanticScorer.score(
          event.data.input,
          preparedV2.index.funds.map((fund) => fund.id),
        );
        result = matchFundsV2(preparedV2, event.data.input, scores);
      } catch (error) {
        result = matchFundsV2(preparedV2, event.data.input);
        semanticFallback = error instanceof Error ? error.message : String(error);
      }
    } else {
      result = preparedV2 ? matchFundsV2(preparedV2, event.data.input) : matchFunds(prepared!, event.data.input);
    }
    self.postMessage({
      type: 'result',
      requestId: event.data.requestId,
      result,
      semanticFallback,
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
