/**
 * Text normalisation shared by the scoring engine and the taxonomy.
 *
 * It lives in its own module because both of its callers need it and one imports the other:
 * `engine` pulls facets from `taxonomy`, so putting these in `engine` would make the pair
 * circular. A leaf module with no imports of its own is what breaks that.
 */

const STOP_WORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'fund',
  'has',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'our',
  'project',
  'projects',
  'shared',
  'shar',
  'that',
  'the',
  'their',
  'this',
  'through',
  'to',
  'we',
  'with',
  'work',
  'works',
  'led',
]);

function stem(term: string): string {
  if (term.length <= 3) return term;
  if (term.endsWith('ies') && term.length > 4) return `${term.slice(0, -3)}y`;
  if (term.endsWith('ing') && term.length > 6) return term.slice(0, -3);
  if (term.endsWith('ed') && term.length > 5) return term.slice(0, -2);
  if (term.endsWith('es') && term.length > 5) return term.slice(0, -2);
  if (term.endsWith('s') && !term.endsWith('ss') && term.length > 4) return term.slice(0, -1);
  return term;
}

export function normalizeTerms(value: string): string[] {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[’']/g, '')
    .match(/[\p{L}\p{N}]+/gu)
    ?.map(stem)
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term)) || [];
}
