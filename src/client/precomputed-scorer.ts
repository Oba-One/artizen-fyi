/// <reference lib="webworker" />

import type { MatchIndexV2, ProjectMatchInput } from '../artizen/types';
import { semanticManifest } from '../matching/semantic-config';
import { matchInputVectorText, projectVectorText, vectorFingerprint } from '../matching/semantic-text';
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
  private projects: Map<string, Float32Array> | undefined;

  constructor(private readonly index: MatchIndexV2) {}

  async load(): Promise<boolean> {
    const manifest = semanticManifest(this.index);
    if (!manifest) return false;
    const fingerprints = new Map(
      this.index.projects.map((project) => [project.id, vectorFingerprint(projectVectorText(project))]),
    );
    const fundFingerprints = new Map(
      this.index.funds.map((fund) => [fund.id, vectorFingerprint(fund.profileText)]),
    );
    const [funds, projects] = await Promise.all([
      this.fetchCatalog(manifest, manifest.vectorsUrl, fundFingerprints),
      this.fetchCatalog(manifest, manifest.projectVectorsUrl, fingerprints),
    ]);
    this.funds = funds;
    this.projects = projects;
    return Boolean(funds?.size && projects?.size);
  }

  /** Scores against funds when this input is an unedited catalog project, and nothing otherwise. */
  score(input: ProjectMatchInput): PrecomputedOutcome {
    if (!this.funds || !this.projects || !input.projectId) return {};
    const vector = this.projects.get(input.projectId);
    if (!vector) return {};
    const project = this.index.projects.find((candidate) => candidate.id === input.projectId);
    if (!project) return {};
    // A refined description or an edited tag list no longer matches the text that was embedded.
    if (matchInputVectorText(input) !== projectVectorText(project)) return { downgrade: 'edited' };
    return { scores: scoreAgainstFunds(vector, this.funds, this.index.funds.map((fund) => fund.id)) };
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
