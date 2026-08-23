import { brotliCompressSync } from 'node:zlib';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npm run evaluate:matching -- <match-index.json>');
  process.exitCode = 1;
} else {
  const source = await readFile(inputPath);
  const index = JSON.parse(source.toString('utf8'));
  const compressedBytes = brotliCompressSync(source).byteLength;
  const temp = await mkdtemp(join(tmpdir(), 'artizen-matching-eval-'));
  const outfile = join(temp, 'evaluate.mjs');
  try {
    await build({
      entryPoints: ['src/matching/evaluate.ts'],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: ['node22'],
      logLevel: 'silent',
    });
    const { evaluateMatchIndex } = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
    console.log(
      JSON.stringify(
        {
          indexVersion: index.indexVersion,
          projects: index.projects?.length || 0,
          funds: index.funds?.length || 0,
          relationships: index.relationships?.length || 0,
          bytes: source.byteLength,
          brotliBytes: compressedBytes,
          withinIndexBudget: compressedBytes <= 750 * 1024,
          metrics: evaluateMatchIndex(index),
        },
        null,
        2,
      ),
    );
    if (compressedBytes > 750 * 1024) process.exitCode = 1;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
