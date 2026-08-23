import type { SemanticCatalogManifest } from '../artizen/types';
import { MATCH_TAXONOMY_VERSION } from './taxonomy';

export const SEMANTIC_MODEL_REVISION = 'b0561d9a97e6b298da39f0ef3e7d3cf153b1b29a';
export const SEMANTIC_MODEL_SHA256 = '952f996d8cf46c311ee8654a750fa942b71c8b94aabe69d043dbb2bcaff5528e';
export const SEMANTIC_MODEL_BYTES = 24_448_010;

export const SEMANTIC_CATALOG: SemanticCatalogManifest = {
  modelId: 'mixedbread-ai/mxbai-embed-xsmall-v1',
  modelRevision: SEMANTIC_MODEL_REVISION,
  dtype: 'q8',
  dimensions: 256,
  weightsBytes: SEMANTIC_MODEL_BYTES,
  modelPath: '/assets/models/',
  wasmPath: '/assets/ort/',
  vectorsUrl: '/assets/match-fund-vectors-v1.bin',
  vectorVersion: `${SEMANTIC_MODEL_REVISION.slice(0, 12)}-${MATCH_TAXONOMY_VERSION}-256`,
};
