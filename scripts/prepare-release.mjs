import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldPrepareMatchingRelease } from './matching-release.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts', script), ...args], {
      stdio: 'inherit',
      cwd: root,
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited ${code ?? 'null'}`));
    });
  });
}

if (shouldPrepareMatchingRelease(process.env)) {
  console.log('Matching release: pinned model, live Artizen catalog, then vectors');
  await run('fetch-semantic-assets.mjs');
  await run('build-match-catalog.mjs');
  await run('build-semantic-vectors.mjs', ['public/match/index.json']);
  await run('verify-prepared-parity.mjs', ['public/match/index.json']);
  await run('verify-live-ranking.mjs', ['public/match/index.json']);
} else {
  console.log('Matching release skipped (not a deploy). Catalog, model, and vectors are left as they are.');
}

await run('build-client.mjs');
