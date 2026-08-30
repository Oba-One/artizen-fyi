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
    '<h3>Exclusions</h3><ul><li>Weapons research</li><li>Private surveillance</li></ul>',
    '[h3]Exclusions[/h3][ul][li]Weapons research[/li][li]Private surveillance[/li][/ul]',
    '<h3>We do not fund</h3><ul><li>Weapons research</li><li>Private surveillance</li></ul>',
  ])('recognizes colon-less exclusion headings after markup cleanup', (text) => {
    expect(splitEligibility(text)).toMatchObject({
      criteria: [],
      exclusions: ['Weapons research', 'Private surveillance'],
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
    'Not-for-profit organizations may apply.',
    'Projects are not limited to film, XR, or performance.',
    'Prior funding is not required.',
    'A prototype is not mandatory.',
    'The work is not yet their primary income.',
    'Projects can be not fully mature or scaled.',
    'No more than ten team members.',
    'No application fee is required.',
    'No project needs to address every dimension.',
    'No practitioner is excluded by geography or financial position.',
    'Nonprofit organizations may apply.',
    'Applicants must be not-for-profit.',
  ])('keeps positive criteria that use no/not wording', (text) => {
    expect(splitEligibility(text)).toMatchObject({ criteria: [text], exclusions: [] });
  });

  it('keeps a bullet that only says Not eligible as exclusion content, not a heading', () => {
    expect(splitEligibility('- Not eligible')).toMatchObject({ criteria: [], exclusions: ['Not eligible'] });
  });

  it('does not treat people excluded elsewhere as a fund exclusion', () => {
    const text = 'Applicants must champion artists excluded from commercial circuits.';
    expect(splitEligibility(text)).toMatchObject({ criteria: [text], exclusions: [] });
  });

  it('keeps an exclusion bullet and its explanation together for scoring', () => {
    const text = 'Exclusions\n- No VC-backed startups. Public-good money stays in public hands.';
    expect(splitEligibility(text)).toMatchObject({
      criteria: [],
      exclusions: ['No VC-backed startups. Public-good money stays in public hands.'],
    });
  });

  it('does not carry an inline exclusion into its positive rationale', () => {
    expect(
      splitEligibility(
        'Eligibility\n- No VC-backed startups; public-good money stays in public hands.',
      ),
    ).toMatchObject({
      criteria: ['public-good money stays in public hands.'],
      exclusions: ['No VC-backed startups'],
    });
  });

  it('keeps nested may-not descriptions inside welcomed criteria', () => {
    const text = 'We welcome projects that may not fit traditional venture capital frameworks.';
    expect(splitEligibility(text)).toMatchObject({ criteria: [text], exclusions: [] });
  });

  it('recognizes a clause-leading may-not prohibition', () => {
    const text = 'Projects may not involve weapons research.';
    expect(splitEligibility(text)).toMatchObject({ criteria: [], exclusions: [text] });
  });

  it('keeps semicolon-separated items after an inline exclusion heading negative', () => {
    expect(
      splitEligibility(
        'Not eligible: partisan electoral work; speculative token launches; projects whose output is critique without construction.',
      ),
    ).toMatchObject({
      criteria: [],
      exclusions: [
        'Not eligible: partisan electoral work',
        'speculative token launches',
        'projects whose output is critique without construction.',
      ],
    });
  });

  it('recognizes a colon-less Not this round heading and contracted exclusions', () => {
    expect(splitEligibility("Not this round\nEvents and media projects aren't eligible this season.")).toMatchObject({
      criteria: [],
      exclusions: ["Events and media projects aren't eligible this season."],
    });
  });

  it.each([
    'We do not support fabricated or AI-generated documentation.',
    'We do not accept AI-generated stories.',
    'Multiple project entries will not be accepted.',
    "Projects seeking personal expenses won't be approved.",
    "Applications without answers to these questions won't fly.",
    'A three-month-old project without users does not.',
    'Neither does work that only promotes peace as a message.',
  ])('recognizes additional live-catalog exclusion wording', (text) => {
    expect(splitEligibility(text)).toMatchObject({ criteria: [], exclusions: [text] });
  });

  it.each([
    "We don't put a premium on commercial viability.",
    "You don't need Hollywood credits.",
    'It does not have to be finished.',
  ])('does not broaden support and acceptance exclusions into ordinary negation', (text) => {
    expect(splitEligibility(text)).toMatchObject({ criteria: [text], exclusions: [] });
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
