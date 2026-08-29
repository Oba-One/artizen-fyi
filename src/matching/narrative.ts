const EXCLUSION_MARKER_SOURCE =
  String.raw`\b(?:not eligible|ineligible|do not fund|don't fund|does not fund|will not fund|must not|should not|can't|cannot|out of scope|not what this fund is for|isn't what this fund is for|does not qualify|do not qualify|excluded)\b`;
const EXCLUSION_MARKER = new RegExp(EXCLUSION_MARKER_SOURCE, 'i');
const EXCLUSION_AFTER_AND = new RegExp(
  String.raw`\s+and\s+(?=(?:(?:projects?|applicants?|teams?|organizations?|organisations?)\s+)?(?:${EXCLUSION_MARKER_SOURCE}|(?:not|no)\b))`,
  'i',
);
const BULLET_MARKER = /^(?:[-*•]|\d+[.)])\s+/;
const EXCLUSION_HEADING =
  /^(?:exclusions?|ineligible|not eligible|who (?:cannot|can't) apply|what we (?:do not|don't) fund|we (?:do not|don't) fund)\s*:$/i;
const CRITERIA_HEADING =
  /^(?:eligibility|requirements?|eligible (?:projects?|applicants?)|who (?:can|may|should) apply|what we fund|we fund|we support)\s*:$/i;
const CRITERIA_MARKER =
  /\b(?:eligible|eligibility|may|can|must|should|required?|requirements?|we fund|we support)\b/i;
const CLAUSE_LEADING_EXCLUSION = /^(?:not|no)\b/i;
const CLAUSE_TRAILING_EXCLUSION = /\b(?:is|are|was|were)\s+not[.!?]?$/i;

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

function sentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function polarityClauses(value: string): string[] {
  return value
    .split(/\s*(?:;|\b(?:but|however|whereas)\b)\s*/i)
    .flatMap((part) => part.split(EXCLUSION_AFTER_AND))
    .map((part) => part.trim())
    .filter(Boolean);
}

function isExclusionClause(value: string): boolean {
  return (
    EXCLUSION_MARKER.test(value) ||
    CLAUSE_LEADING_EXCLUSION.test(value) ||
    CLAUSE_TRAILING_EXCLUSION.test(value)
  );
}

function eligibilityNarrative(value: unknown): string {
  if (typeof value !== 'string') return cleanNarrative(value);
  // Preserve list membership through the generic markup cleaner so an exclusion heading can
  // govern its bullets without leaking into a later ordinary paragraph.
  return cleanNarrative(
    value
      .replace(/\[(?:li)(?:\s[^\]]*)?\]/gi, '\n- ')
      .replace(/<(?:li)(?:\s[^>]*)?>/gi, '\n- '),
  );
}

export function splitEligibility(value: unknown): {
  text: string;
  criteria: string[];
  exclusions: string[];
} {
  const text = eligibilityNarrative(value);
  const criteria: string[] = [];
  const exclusions: string[] = [];
  let section: 'criteria' | 'exclusions' | undefined;
  for (const rawLine of text.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    const bullet = BULLET_MARKER.test(trimmed);
    const line = trimmed.replace(BULLET_MARKER, '').trim();
    if (EXCLUSION_HEADING.test(line) || (EXCLUSION_MARKER.test(line) && /:\s*$/.test(line))) {
      section = 'exclusions';
      continue;
    }
    if (CRITERIA_HEADING.test(line)) {
      section = 'criteria';
      continue;
    }
    if (!bullet) section = undefined;
    for (const sentence of sentences(line)) {
      let polarity = section;
      for (const clause of polarityClauses(sentence)) {
        if (isExclusionClause(clause)) polarity = 'exclusions';
        // An exclusion heading owns every bullet in its section. Modal verbs inside those bullets
        // describe the excluded subject; they do not turn the text back into positive criteria.
        else if (section !== 'exclusions' && CRITERIA_MARKER.test(clause)) polarity = 'criteria';
        (polarity === 'exclusions' ? exclusions : criteria).push(clause);
      }
    }
  }
  return { text, criteria, exclusions };
}
