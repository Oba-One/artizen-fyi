import { describe, expect, it } from 'vitest';
import { normalizeTerms } from '../src/matching/terms';

describe('term normalisation', () => {
  it('lowercases, strips punctuation, stems, and drops stop words', () => {
    expect(normalizeTerms("The Artists' stories, creating FILMS")).toEqual(['artist', 'story', 'creat', 'film']);
    expect(normalizeTerms('Shared infrastructure')).toEqual(['infrastructure']);
  });

  it('keeps accented text by folding it rather than dropping it', () => {
    expect(normalizeTerms('Café Comunidad')).toEqual(['cafe', 'comunidad']);
  });
});
