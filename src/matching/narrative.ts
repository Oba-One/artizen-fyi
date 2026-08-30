const EXCLUSION_MARKER_SOURCE =
  String.raw`\b(?:not eligible|isn't eligible|aren't eligible|ineligible|(?:do not|don't|does not|doesn't) (?:accept|allow|fund|support)|(?:will not|won't) (?:accept|allow|fund|support)|(?:will not|won't) be (?:accepted|allowed|approved|considered|funded|supported)|must not|should not|can't|cannot|out of scope|also out|not what this fund is for|isn't what this fund is for|does not qualify|do not qualify|does not apply|do not apply|won't fly)\b`;
const EXCLUSION_MARKER = new RegExp(EXCLUSION_MARKER_SOURCE, 'i');
const EXCLUSION_AFTER_AND = new RegExp(
  String.raw`\s+and\s+(?=(?:(?:projects?|applicants?|teams?|organizations?|organisations?)\s+)?(?:${EXCLUSION_MARKER_SOURCE}|(?:not|no)\b))`,
  'i',
);
const BULLET_MARKER = /^(?:[-*•]|\d+[.)])\s+/;
const EXCLUSION_HEADING =
  /^(?:exclusions?|excluded|ineligible|not eligible|not this round|who (?:cannot|can't) apply|what we (?:do not|don't) fund|we (?:do not|don't) fund)\s*:?$/i;
const INLINE_EXCLUSION_HEADING = /^(?:exclusions?|ineligible|not eligible|also out)\s*:/i;
const CRITERIA_HEADING =
  /^(?:eligibility|requirements?|eligible (?:projects?|applicants?)|who (?:can|may|should) apply|what we fund|we fund|we support)\s*:?$/i;
const CRITERIA_MARKER =
  /\b(?:eligible|eligibility|may|can|must|should|required?|requirements?|we fund|we support)\b/i;
const CLAUSE_LEADING_EXCLUSION = /^(?:not|no|neither)\b/i;
const CLAUSE_LEADING_CRITERIA =
  /^(?:not[- ]for[- ]profits?\b|not\s+(?:limited\b|mandatory\b|required\b|yet\b|fully\s+(?:mature|scaled)\b)|no\s+(?:more|less)\s+than\b|no\b.*\brequired\b|no\s+(?:projects?|applicants?|teams?|organizations?|organisations?|practitioners?)\s+(?:needs?\b|(?:is|are)\s+excluded\b))/i;
const CLAUSE_LEADING_NEGATIVE_MODAL = /^(?:(?:projects?|applicants?|teams?)\s+)?may not\b/i;
const CLAUSE_TRAILING_EXCLUSION =
  /\b(?:(?:is|are|was|were|do|does|did|will|would)\s+not|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|won't|wouldn't)[.!?]?$/i;
const CLAUSE_POSITIVE_SENTENCE =
  /^(?:i|we|they|this|that|it)\b|\b(?:is|are|was|were|does|has|have|stays?|supports?|welcomes?|aims?|ensures?)\b/i;

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

function polarityClauses(value: string): Array<{ text: string; reset: boolean }> {
  return value
    .split(/\s*\b(?:but|however|whereas)\b\s*/i)
    .flatMap((contrast, contrastIndex) =>
      contrast
        .split(/\s*;\s*/)
        .flatMap((part) => part.split(EXCLUSION_AFTER_AND))
        .map((part, partIndex) => ({
          text: part.trim(),
          reset: contrastIndex > 0 && partIndex === 0,
        })),
    )
    .filter((part) => Boolean(part.text));
}

function isExclusionClause(value: string): boolean {
  if (
    CLAUSE_LEADING_CRITERIA.test(value) &&
    !EXCLUSION_MARKER.test(value) &&
    !CLAUSE_TRAILING_EXCLUSION.test(value)
  ) {
    return false;
  }
  return (
    EXCLUSION_MARKER.test(value) ||
    CLAUSE_LEADING_EXCLUSION.test(value) ||
    CLAUSE_LEADING_NEGATIVE_MODAL.test(value) ||
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
    if (
      (!bullet && EXCLUSION_HEADING.test(line)) ||
      (EXCLUSION_MARKER.test(line) && /:\s*$/.test(line))
    ) {
      section = 'exclusions';
      continue;
    }
    if (!bullet && CRITERIA_HEADING.test(line)) {
      section = 'criteria';
      continue;
    }
    if (!bullet) section = undefined;
    const sentenceParts = section === 'exclusions' && bullet ? [line] : sentences(line);
    for (const sentence of sentenceParts) {
      let polarity = section;
      let exclusionList = false;
      for (const part of polarityClauses(sentence)) {
        const clause = part.text;
        if (part.reset) {
          polarity = section;
          exclusionList = false;
        }
        if (INLINE_EXCLUSION_HEADING.test(clause)) exclusionList = true;
        if (isExclusionClause(clause)) polarity = 'exclusions';
        // An exclusion heading owns every bullet in its section. Modal verbs inside those bullets
        // describe the excluded subject; they do not turn the text back into positive criteria.
        else if (section !== 'exclusions' && CRITERIA_MARKER.test(clause)) polarity = 'criteria';
        else if (
          !exclusionList &&
          polarity === 'exclusions' &&
          CLAUSE_POSITIVE_SENTENCE.test(clause)
        ) {
          polarity = section;
        }
        (polarity === 'exclusions' ? exclusions : criteria).push(clause);
      }
    }
  }
  return { text, criteria, exclusions };
}
