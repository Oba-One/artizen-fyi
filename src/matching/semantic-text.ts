import type { ProjectMatchInput, ProjectProfile } from '../artizen/types';

/**
 * The exact string a project's embedding is computed from. The build script and the browser must
 * agree on it character for character, or a precomputed vector would silently describe different
 * text than the one being matched.
 */
export function projectVectorText(project: Pick<ProjectProfile, 'name' | 'description' | 'tags'>): string {
  return [project.name, project.description, ...project.tags].filter(Boolean).join('. ');
}

export function matchInputVectorText(input: ProjectMatchInput): string {
  return [input.title, input.description, ...input.tags].filter(Boolean).join('. ');
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
