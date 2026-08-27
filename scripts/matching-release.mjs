/**
 * Git-push auto-deploy runs `wrangler deploy` from a clone that has no `public/` (gitignored).
 * Wrangler also runs this custom build on every `wrangler dev` watch, which must stay a fast
 * client rebuild — it cannot crawl Artizen. `WRANGLER_COMMAND` is how Wrangler tells those apart.
 */
export function shouldPrepareMatchingRelease(env = process.env) {
  if (env.ARTIZEN_SKIP_MATCHING_RELEASE === '1') return false;
  if (env.ARTIZEN_RELEASE === '1' || env.WORKERS_CI === '1') return true;
  return env.WRANGLER_COMMAND === 'deploy' || env.WRANGLER_COMMAND === 'versions upload';
}
