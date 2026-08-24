import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';

const inputPath = process.argv[2];
const iterations = Number(process.argv[3] || 200);

if (!inputPath) {
  console.error('Usage: node scripts/benchmark-match.mjs <match-index.json> [iterations]');
  process.exitCode = 1;
} else if (!Number.isInteger(iterations) || iterations < 10) {
  console.error('Iterations must be an integer of at least 10.');
  process.exitCode = 1;
} else {
  const source = JSON.parse(await readFile(inputPath, 'utf8'));
  const temp = await mkdtemp(join(tmpdir(), 'artizen-matching-benchmark-'));
  const outfile = join(temp, 'benchmark.mjs');
  try {
    await build({
      stdin: {
        contents: `
          export { prepareMatchIndex, matchFunds } from ${JSON.stringify(join(process.cwd(), 'src/matching/engine.ts'))};
        `,
        resolveDir: process.cwd(),
        sourcefile: 'benchmark-entry.ts',
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'silent',
    });
    const { prepareMatchIndex, matchFunds } = await import(
      `${pathToFileURL(outfile).href}?v=${Date.now()}`
    );
    const index = source;
    if (index.schemaVersion !== 2) throw new Error('A schema-2 matching index is required');
    const prepared = prepareMatchIndex(index);
    const projects = index.projects.map((project) => ({
      projectId: project.id,
      title: project.name,
      description: project.description,
      tags: project.tags,
    }));
    if (projects.length === 0) throw new Error('The benchmark index has no projects.');

    for (let warmup = 0; warmup < 10; warmup += 1) {
      matchFunds(prepared, projects[warmup % projects.length]);
    }

    const timings = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const startedAt = performance.now();
      matchFunds(prepared, projects[iteration % projects.length]);
      timings.push(performance.now() - startedAt);
    }
    timings.sort((left, right) => left - right);
    const percentile = (value) => timings[Math.min(timings.length - 1, Math.ceil(timings.length * value) - 1)];
    const indexBytes = Buffer.byteLength(JSON.stringify(index));
    const brotliBytes = brotliCompressSync(JSON.stringify(index), {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength;

    console.log(
      JSON.stringify(
        {
          source: index.source,
          iterations,
          fundsScoredPerMatch: index.funds.length,
          indexBytes,
          indexBrotliBytes: brotliBytes,
          matchingMs: {
            min: Number(timings[0].toFixed(3)),
            p50: Number(percentile(0.5).toFixed(3)),
            p75: Number(percentile(0.75).toFixed(3)),
            p95: Number(percentile(0.95).toFixed(3)),
            max: Number(timings.at(-1).toFixed(3)),
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
