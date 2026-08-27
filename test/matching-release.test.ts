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
});
