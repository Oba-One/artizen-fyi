import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shouldPrepareMatchingRelease } from '../scripts/matching-release.mjs';

describe('shouldPrepareMatchingRelease', () => {
  it('rebuilds the catalog for wrangler deploy and versions upload', () => {
    expect(shouldPrepareMatchingRelease({ WRANGLER_COMMAND: 'deploy' })).toBe(true);
    expect(shouldPrepareMatchingRelease({ WRANGLER_COMMAND: 'versions upload' })).toBe(true);
  });

  it('skips the crawl during wrangler dev and types', () => {
    expect(shouldPrepareMatchingRelease({ WRANGLER_COMMAND: 'dev' })).toBe(false);
    expect(shouldPrepareMatchingRelease({ WRANGLER_COMMAND: 'types' })).toBe(false);
    expect(shouldPrepareMatchingRelease({})).toBe(false);
  });

  it('rebuilds on Workers Builds even if WRANGLER_COMMAND is missing', () => {
    expect(shouldPrepareMatchingRelease({ WORKERS_CI: '1' })).toBe(true);
  });

  it('lets ARTIZEN_RELEASE force a rebuild and ARTIZEN_SKIP_MATCHING_RELEASE suppress one', () => {
    expect(shouldPrepareMatchingRelease({ ARTIZEN_RELEASE: '1', WRANGLER_COMMAND: 'dev' })).toBe(true);
    expect(shouldPrepareMatchingRelease({ ARTIZEN_SKIP_MATCHING_RELEASE: '1', WRANGLER_COMMAND: 'deploy' })).toBe(
      false,
    );
  });

  it('verifies generic prepared parity and the live ranking regression after rebuilding vectors', () => {
    const source = readFileSync('scripts/prepare-release.mjs', 'utf8');
    const catalog = source.indexOf("run('build-match-catalog.mjs')");
    const vectors = source.indexOf("run('build-semantic-vectors.mjs'");
    const parity = source.indexOf("run('verify-prepared-parity.mjs'");
    const ranking = source.indexOf("run('verify-live-ranking.mjs'");
    const client = source.indexOf("run('build-client.mjs')");

    expect(catalog).toBeGreaterThan(0);
    expect(vectors).toBeGreaterThan(catalog);
    expect(parity).toBeGreaterThan(vectors);
    expect(ranking).toBeGreaterThan(parity);
    expect(client).toBeGreaterThan(ranking);
    expect(source).not.toContain("'Green Goods'");

    const paritySource = readFileSync('scripts/verify-prepared-parity.mjs', 'utf8');
    expect(paritySource).not.toContain("targetNames.push('Green Goods')");

    const regressionSource = readFileSync('scripts/verify-live-ranking.mjs', 'utf8');
    expect(regressionSource).toContain('1770869215335x984989015863722000');
    expect(regressionSource).toContain('1787275976116x317304465147527700');
    expect(regressionSource).toContain('maxRank: 12');
  });
});
