const EXCLUSION_MARKER =
  /\b(?:not eligible|ineligible|do not fund|don't fund|does not fund|will not fund|must not|should not|can't|cannot|out of scope|not what this fund is for|does not qualify|do not qualify|excluded)\b/i;

/** Converts Artizen's BBCode-rich narrative fields into stable text for scoring and display. */
export function cleanNarrative(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\[\/(?:li|ul|ol|ml|p)\]/gi, '\n')
    .replace(/\[(?:li|ul|ol|ml|p)(?:\s[^\]]*)?\]/gi, '\n')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/<\/(?:p|li|ul|ol|div|h[1-6])>/gi, '\n')
    .replace(/<(?:p|li|ul|ol|div|h[1-6])(?:\s[^>]*)?>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clauses(value: string): string[] {
  return value
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function splitEligibility(value: unknown): {
  text: string;
  criteria: string[];
  exclusions: string[];
} {
  const text = cleanNarrative(value);
  const criteria: string[] = [];
  const exclusions: string[] = [];
  for (const clause of clauses(text)) {
    (EXCLUSION_MARKER.test(clause) ? exclusions : criteria).push(clause);
  }
  return { text, criteria, exclusions };
}
