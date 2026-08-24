/// <reference lib="webworker" />

import type { MatchIndex, ProjectMatchInput, ProjectProfile } from '../artizen/types';
import { semanticManifest } from '../matching/semantic-config';
import { matchInputVectorText, projectVectorText, vectorBucket, vectorFingerprint } from '../matching/semantic-text';
import { parseVectorCatalog, scoreAgainstFunds } from './vector-catalog';

/**
 * Why the prepared comparison did not apply, when the caller can do something about it.
 *
 * `edited` means the project exists and was embedded, but the description or tags on this request
 * are not the text that was embedded - the one case worth telling the user about, because turning
 * on the model gets the semantic reading back.
 */
export type PrecomputedOutcome = {
  scores?: Map<string, number>;
  downgrade?: 'edited';
};

/**
 * Semantic scoring for projects that already exist in the public catalog.
 *
 * Both sides of the comparison are known when the catalog is built, so the embeddings are computed
 * once at build time and the browser only takes a dot product. That is roughly a megabyte of
 * vectors instead of the ~50 MB of model weights and ONNX runtime the on-device path needs, with
 * identical results: same model, same embeddings, computed earlier.
 *
 * The model is still required for freeform descriptions, which by definition do not exist until
 * someone types them.
 */
export class PrecomputedSemanticScorer {
  private funds: Map<string, Float32Array> | undefined;
  /**
   * One entry per shard the page has actually needed. Keyed by shard rather than by project so two
   * projects that land in the same file share a fetch, and memoised as the promise so two matches
   * racing for the same shard do not both download it.
   */
  private readonly shards = new Map<number, Promise<Map<string, Float32Array> | undefined>>();

  constructor(private readonly index: MatchIndex) {}

  /**
   * Only the fund vectors, which every comparison needs. Project vectors are fetched a shard at a
   * time once there is a project to score - a project page used to pull all 3 MB of them to read
   * one project's kilobyte.
   */
  async load(): Promise<boolean> {
    const manifest = semanticManifest(this.index);
    if (!manifest) return false;
    const fingerprints = new Map(this.index.funds.map((fund) => [fund.id, vectorFingerprint(fund.profileText)]));
    this.funds = await this.fetchCatalog(manifest, manifest.vectorsUrl, fingerprints);
    return Boolean(this.funds?.size);
  }

  /** Scores against funds when this input is an unedited catalog project, and nothing otherwise. */
  async score(input: ProjectMatchInput): Promise<PrecomputedOutcome> {
    const manifest = semanticManifest(this.index);
    if (!this.funds || !manifest || !input.projectId) return {};
    const project = this.index.projects.find((candidate) => candidate.id === input.projectId);
    if (!project) return {};
    // Checked before the shard is fetched, not after: an edited project is never going to match a
    // stored vector, so there is nothing to download.
    if (matchInputVectorText(input) !== projectVectorText(project)) return { downgrade: 'edited' };
    const vectors = await this.shard(manifest, project);
    const vector = vectors?.get(project.id);
    if (!vector) return {};
    return { scores: scoreAgainstFunds(vector, this.funds, this.index.funds.map((fund) => fund.id)) };
  }

  private shard(
    manifest: { vectorVersion: string; dimensions: number; projectVectorPrefix: string; projectVectorBuckets: number },
    project: ProjectProfile,
  ): Promise<Map<string, Float32Array> | undefined> {
    const bucket = vectorBucket(project.id, manifest.projectVectorBuckets);
    let pending = this.shards.get(bucket);
    if (!pending) {
      // Every known project that lands in this shard, so the parsed result serves all of them. The
      // page either knows the whole catalog (the picker) or exactly the one project it is about.
      const expected = new Map(
        this.index.projects
          .filter((candidate) => vectorBucket(candidate.id, manifest.projectVectorBuckets) === bucket)
          .map((candidate) => [candidate.id, vectorFingerprint(projectVectorText(candidate))]),
      );
      pending = this.fetchCatalog(manifest, `${manifest.projectVectorPrefix}${bucket}.bin`, expected);
      this.shards.set(bucket, pending);
    }
    return pending;
  }

  private async fetchCatalog(
    manifest: { vectorVersion: string; dimensions: number },
    url: string,
    expected: Map<string, string>,
  ): Promise<Map<string, Float32Array> | undefined> {
    try {
      // Rebuilt with every catalog refresh under a stable filename, so it must revalidate.
      const response = await fetch(url, { cache: 'no-cache' });
      if (!response.ok) return undefined;
      return parseVectorCatalog(await response.arrayBuffer(), manifest, expected);
    } catch {
      return undefined;
    }
  }
}
