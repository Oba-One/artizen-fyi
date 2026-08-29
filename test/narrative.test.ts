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

  it('recognizes a plain Exclusions heading and keeps modal bullets negative', () => {
    expect(
      splitEligibility(
        'Eligibility:\n\n- Applicants should publish their work\n\nExclusions:\n\n- Teams may build weapons\n- Applicants must use private surveillance',
      ),
    ).toMatchObject({
      criteria: ['Applicants should publish their work'],
      exclusions: ['Teams may build weapons', 'Applicants must use private surveillance'],
    });
  });

  it.each([
    ['No weapons research or private surveillance.', ['No weapons research or private surveillance.']],
    ['Not for speculative token launches.', ['Not for speculative token launches.']],
    ['Early stage is fine; vaporware is not.', ['vaporware is not.']],
  ])('recognizes clause-leading no/not exclusions', (text, exclusions) => {
    const result = splitEligibility(text);
    expect(result.exclusions).toEqual(exclusions);
    expect(result.criteria).not.toEqual(expect.arrayContaining(exclusions));
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
