import type { ProjectMatchInput, ProjectProfile } from '../artizen/types';

/**
 * The exact string a project's embedding is computed from. The build script and the browser must
 * agree on it character for character, or a precomputed vector would silently describe different
 * text than the one being matched.
 */
export function projectVectorText(project: Pick<ProjectProfile, 'name' | 'description' | 'tags' | 'context'>): string {
  return [
    project.name,
    project.description,
    ...project.tags,
    project.context?.description,
    project.context?.impact,
    project.context?.progress,
    project.context?.team,
  ].filter(Boolean).join('. ');
}

export function matchInputVectorText(input: ProjectMatchInput): string {
  return [
    input.title,
    input.description,
    ...input.tags,
    input.context?.description,
    input.context?.impact,
    input.context?.progress,
    input.context?.team,
  ].filter(Boolean).join('. ');
}

/** The canonical fingerprint still travels with compact picker rows whose context was removed. */
export function projectVectorFingerprint(
  project: Pick<ProjectProfile, 'name' | 'description' | 'tags' | 'context' | 'semanticFingerprint'>,
): string {
  return project.semanticFingerprint || vectorFingerprint(projectVectorText(project));
}

/**
 * Context is not editable in the matcher and may be absent from a compact picker row. The fields
 * a visitor can refine must still match exactly; supplied context is compared when both sides have
 * it so a genuinely different full input cannot borrow the catalog vector.
 */
export function matchesPreparedProjectInput(input: ProjectMatchInput, project: ProjectProfile): boolean {
  if (input.title !== project.name || input.description !== project.description) return false;
  if (input.tags.length !== project.tags.length || input.tags.some((tag, index) => tag !== project.tags[index])) {
    return false;
  }
  return !input.context || !project.context || matchInputVectorText(input) === projectVectorText(project);
}

/**
 * A short non-cryptographic fingerprint of that text, stored beside each precomputed vector.
 * It exists to detect staleness, not to resist tampering: when a project's name, description, or
 * tags change, the fingerprint stops matching and the browser falls back to computing the vector
 * itself instead of scoring against text the project no longer has. 64 bits keeps the collision
 * chance across a few thousand projects negligible.
 */
export function vectorFingerprint(text: string): string {
  let low = 2166136261;
  let high = 2166136261 ^ 0x5bf03635;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    low = Math.imul(low ^ code, 16777619) >>> 0;
    high = Math.imul(high ^ (code + index), 16777639) >>> 0;
  }
  return low.toString(16).padStart(8, '0') + high.toString(16).padStart(8, '0');
}

/**
 * Which shard of the project vector catalog holds a project.
 *
 * The catalog is 3 MB and a page needs one project's 1 KB of it, so it is written as a fixed set
 * of shards and the browser fetches only the one it needs. The builder and the browser must agree
 * on this function exactly, or a project's vector would be looked for in a file it is not in.
 */
export function vectorBucket(id: string, buckets: number): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16777619) >>> 0;
  }
  return hash % buckets;
}
