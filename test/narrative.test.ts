import { describe, expect, it } from 'vitest';
import { splitEligibility } from '../src/matching/narrative';

describe('eligibility narrative splitting', () => {
  it('keeps bullets under an exclusion heading out of positive criteria', () => {
    expect(splitEligibility('Applicants should build public tools.\n\nWe do not fund:\n- Weapons research\n- Private surveillance')).toMatchObject({
      criteria: ['Applicants should build public tools.'],
      exclusions: ['Weapons research', 'Private surveillance'],
    });
  });

  it('preserves exclusion list membership through BBCode cleanup', () => {
    expect(splitEligibility('We do not fund:[ul][li]Weapons research[/li][li]Private surveillance[/li][/ul]')).toMatchObject({
      criteria: [],
      exclusions: ['Weapons research', 'Private surveillance'],
    });
  });

  it.each([
    [
      'Applicants must be nonprofits but cannot conduct weapons research.',
      ['Applicants must be nonprofits'],
      ['cannot conduct weapons research.'],
    ],
    [
      "Teams should publish their work and can't operate private surveillance systems.",
      ['Teams should publish their work'],
      ["can't operate private surveillance systems."],
    ],
    [
      'We cannot fund weapons research; private surveillance.',
      [],
      ['We cannot fund weapons research', 'private surveillance.'],
    ],
  ])('separates positive and negative requirements in one sentence', (text, criteria, exclusions) => {
    expect(splitEligibility(text)).toMatchObject({ criteria, exclusions });
  });
});
