/// <reference lib="webworker" />

import type { MatchIndex, ProjectMatchInput, ProjectProfile } from '../artizen/types';
import { semanticManifest } from '../matching/semantic-config';
import {
  matchesPreparedProjectInput,
  projectVectorFingerprint,
  vectorBucket,
  vectorFingerprint,
} from '../matching/semantic-text';
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
  fallback?: PrecomputedFallback;
};

/** Why an untouched catalog project could not use the semantic assets prepared for this release. */
export type PrecomputedFallback =
  | 'assets-unavailable'
  | 'assets-stale'
  | 'project-vector-unavailable'
  | 'assets-incomplete';

type CatalogLoad = {
  vectors?: Map<string, Float32Array>;
  fallback?: Exclude<PrecomputedFallback, 'assets-incomplete'>;
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
  private fundLoad: Promise<boolean> | undefined;
  private fundFallback: PrecomputedFallback | undefined;
  /**
   * One entry per shard the page has actually needed. Keyed by shard rather than by project so two
   * projects that land in the same file share a fetch, and memoised as the promise so two matches
   * racing for the same shard do not both download it.
   */
  private readonly shards = new Map<number, Promise<CatalogLoad>>();

  constructor(private index: MatchIndex) {}

  /**
   * Keeps loaded fund vectors and unaffected shards when compact or hydrated project records
   * arrive. A shard is invalidated only when the canonical fingerprints it should contain change.
   */
  updateProjects(projects: ProjectProfile[]): void {
    const manifest = semanticManifest(this.index);
    if (manifest) {
      const before = this.projectFingerprintsByBucket(this.index.projects, manifest.projectVectorBuckets);
      const after = this.projectFingerprintsByBucket(projects, manifest.projectVectorBuckets);
      for (const bucket of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(bucket) !== after.get(bucket)) this.shards.delete(bucket);
      }
    }
    this.index = { ...this.index, projects };
  }

  /**
   * Only the fund vectors, which every comparison needs. Project vectors are fetched a shard at a
   * time once there is a project to score - a project page used to pull all 3 MB of them to read
   * one project's kilobyte.
   */
  async load(): Promise<boolean> {
    if (this.funds?.size) return true;
    if (this.fundLoad) return this.fundLoad;
    const manifest = semanticManifest(this.index);
    if (!manifest) return false;
    const pending = this.loadFunds(manifest);
    this.fundLoad = pending;
    try {
      return await pending;
    } finally {
      // Successful vectors stay in `funds`; failures clear the in-flight promise so the next
      // match can recover from a transient response without requiring a page reload.
      if (this.fundLoad === pending) this.fundLoad = undefined;
    }
  }

  private async loadFunds(
    manifest: { vectorVersion: string; dimensions: number; vectorsUrl: string },
  ): Promise<boolean> {
    const fingerprints = new Map(this.index.funds.map((fund) => [fund.id, vectorFingerprint(fund.profileText)]));
    const loaded = await this.fetchCatalog(manifest, manifest.vectorsUrl, fingerprints);
    this.funds = loaded.vectors;
    this.fundFallback = loaded.fallback;
    return Boolean(this.funds?.size);
  }

  /** Preserved across the boolean load API so the worker can distinguish baseline from success. */
  get loadFallback(): PrecomputedFallback | undefined {
    return this.fundFallback;
  }

  /** Scores against funds when this input is an unedited catalog project, and nothing otherwise. */
  async score(input: ProjectMatchInput): Promise<PrecomputedOutcome> {
    const manifest = semanticManifest(this.index);
    if (!this.funds || !manifest || !input.projectId) return {};
    const project = this.index.projects.find((candidate) => candidate.id === input.projectId);
    if (!project) return {};
    // Checked before the shard is fetched, not after: an edited project is never going to match a
    // stored vector, so there is nothing to download.
    if (!matchesPreparedProjectInput(input, project)) return { downgrade: 'edited' };
    const loaded = await this.shard(manifest, project);
    const vector = loaded.vectors?.get(project.id);
    if (!vector) return { fallback: loaded.fallback || 'project-vector-unavailable' };
    return { scores: scoreAgainstFunds(vector, this.funds, this.index.funds.map((fund) => fund.id)) };
  }

  private shard(
    manifest: { vectorVersion: string; dimensions: number; projectVectorPrefix: string; projectVectorBuckets: number },
    project: ProjectProfile,
  ): Promise<CatalogLoad> {
    const bucket = vectorBucket(project.id, manifest.projectVectorBuckets);
    let pending = this.shards.get(bucket);
    if (!pending) {
      // Every known project that lands in this shard, so the parsed result serves all of them. The
      // page either knows the whole catalog (the picker) or exactly the one project it is about.
      const expected = new Map(
        this.index.projects
          .filter((candidate) => vectorBucket(candidate.id, manifest.projectVectorBuckets) === bucket)
          .map((candidate) => [candidate.id, projectVectorFingerprint(candidate)]),
      );
      const load = this.fetchCatalog(manifest, `${manifest.projectVectorPrefix}${bucket}.bin`, expected);
      pending = load.then((result) => {
        // Keep successful shards, including empty but valid ones. A failed request is `undefined`
        // and must be retried by the next comparison rather than memoised for the whole session.
        if (!result.vectors && this.shards.get(bucket) === pending) this.shards.delete(bucket);
        return result;
      });
      this.shards.set(bucket, pending);
    }
    return pending;
  }

  private projectFingerprintsByBucket(projects: ProjectProfile[], buckets: number): Map<number, string> {
    const grouped = new Map<number, string[]>();
    for (const project of projects) {
      const bucket = vectorBucket(project.id, buckets);
      const fingerprints = grouped.get(bucket) || [];
      fingerprints.push(`${project.id}:${projectVectorFingerprint(project)}`);
      grouped.set(bucket, fingerprints);
    }
    return new Map([...grouped].map(([bucket, fingerprints]) => [bucket, fingerprints.sort().join('|')]));
  }

  private async fetchCatalog(
    manifest: { vectorVersion: string; dimensions: number },
    url: string,
    expected: Map<string, string>,
  ): Promise<CatalogLoad> {
    try {
      // Rebuilt with every catalog deployment under a stable filename, so it must revalidate.
      const response = await fetch(url, { cache: 'no-cache' });
      if (!response.ok) return { fallback: 'assets-unavailable' };
      const vectors = parseVectorCatalog(await response.arrayBuffer(), manifest, expected);
      return { vectors, fallback: vectors.size < expected.size ? 'assets-stale' : undefined };
    } catch (error) {
      return {
        fallback:
          error instanceof Error && /stale|invalid semantic vector catalog/i.test(error.message)
            ? 'assets-stale'
            : 'assets-unavailable',
      };
    }
  }
}
