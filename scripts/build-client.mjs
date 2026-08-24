import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { build } from 'esbuild';

await mkdir('public/assets', { recursive: true });

await build({
  entryPoints: {
    'match-client': 'src/client/match-client.ts',
    'match-review': 'src/client/match-review.ts',
    'match-worker': 'src/client/match-worker.ts',
  },
  outdir: 'public/assets',
  entryNames: '[name]',
  bundle: true,
  format: 'esm',
  splitting: true,
  chunkNames: 'lazy-[name]-[hash]',
  minify: true,
  sourcemap: false,
  target: ['es2022'],
  logLevel: 'info',
});

// The wasm shipped here has to come from the version the bundle will load. They are the same
// package today only because transformers happens to ask for the identical build; a bump that
// changes its mind would leave a nested copy under transformers while this still copies from the
// top level, shipping wasm from one version to a runtime from another. `overrides` in package.json
// prevents that, and this asserts the prevention actually held.
const ortPin = JSON.parse(await readFile('package.json', 'utf8')).dependencies['onnxruntime-web'];
const ortInstalled = JSON.parse(await readFile('node_modules/onnxruntime-web/package.json', 'utf8')).version;
if (ortInstalled !== ortPin) {
  throw new Error(`onnxruntime-web is pinned to ${ortPin} but ${ortInstalled} is installed`);
}

/**
 * Copy the ONNX Runtime binaries the built bundle can actually ask for, and only those.
 *
 * Each ORT entry point hardcodes one wasm variant rather than choosing at runtime, so which of the
 * four gets fetched is decided by which entry point transformers imports - not by the browser. The
 * bundle it imports names `asyncify`, which is how WebGPU is served in this version too; `jsep` and
 * `jspi` are 40 MB that no code path here can reach.
 *
 * Reading the names out of the bundle rather than listing them keeps that true through an upgrade:
 * if transformers switches entry points, the copy list follows it in the same build.
 */
const ortSource = 'node_modules/onnxruntime-web/dist';
const ortTarget = 'public/assets/ort';
await mkdir(ortTarget, { recursive: true });
const bundleText = (
  await Promise.all(
    (await readdir('public/assets'))
      .filter((name) => /\.js$/.test(name))
      .map((name) => readFile(join('public/assets', name), 'utf8')),
  )
).join('');
const wanted = new Set([...bundleText.matchAll(/ort-wasm-simd-threaded[a-z.]*\.wasm/g)].map((match) => match[0]));
if (wanted.size === 0) {
  throw new Error('no ONNX Runtime wasm filenames found in the built bundles; the copy list would ship nothing');
}
const available = await readdir(ortSource);
for (const wasm of wanted) {
  // Each wasm needs its loader beside it, and ORT derives that name by extension alone.
  for (const filename of [wasm, wasm.replace(/\.wasm$/, '.mjs')]) {
    if (!available.includes(filename)) throw new Error(`the bundle asks for ${filename}, which onnxruntime-web does not ship`);
    await copyFile(join(ortSource, filename), join(ortTarget, basename(filename)));
  }
}
// Variants a previous build copied but this one does not need would otherwise linger and deploy.
for (const filename of await readdir(ortTarget)) {
  const wasm = filename.replace(/\.mjs$/, '.wasm');
  if (!wanted.has(wasm)) await rm(join(ortTarget, filename));
}
console.log(`ONNX Runtime: shipping ${[...wanted].join(', ')}`);

// Bundles must revalidate on every load. The pinned model and runtime are content-addressed by
// revision and SHA and run to tens of megabytes, so re-downloading them hourly is pure waste.
await writeFile(
  'public/_headers',
  [
    '/assets/*',
    '  X-Content-Type-Options: nosniff',
    '/assets/*.js',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '/assets/*.bin',
    '  Cache-Control: public, no-cache',
    '/assets/ort/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '/assets/models/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  ].join('\n'),
);

const browserBundles = await Promise.all([
  readFile('public/assets/match-client.js'),
  readFile('public/assets/match-worker.js'),
]);
const gzipBytes = browserBundles.reduce((total, source) => total + gzipSync(source).byteLength, 0);
if (gzipBytes > 60 * 1024) throw new Error(`matching browser bundles exceed 60 KB gzip (${gzipBytes} bytes)`);
const maxStaticFileBytes = 25 * 1024 * 1024;
async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
// Warn before it is a wall, not after. The largest ONNX Runtime binary sits above 99% of the cap,
// so the difference between "fine" and "the deploy is blocked" is one upstream release; a build
// that only speaks up at 100% gives no chance to plan for it.
const assetWarnRatio = 0.9;
for (const path of await filesBelow('public/assets')) {
  const bytes = (await stat(path)).size;
  const name = relative('public/assets', path);
  if (bytes > maxStaticFileBytes) {
    throw new Error(`${name} exceeds Cloudflare's 25 MiB static-asset limit (${bytes} bytes)`);
  }
  if (bytes > maxStaticFileBytes * assetWarnRatio) {
    const used = ((bytes / maxStaticFileBytes) * 100).toFixed(1);
    const spare = maxStaticFileBytes - bytes;
    console.warn(`NOTE: ${name} is at ${used}% of Cloudflare's 25 MiB asset limit (${spare} bytes spare).`);
  }
}

const semanticModelDir = 'public/assets/models/mixedbread-ai/mxbai-embed-xsmall-v1';
const semanticManifestPath = join(semanticModelDir, 'asset-manifest.json');
let semanticModelReady = false;
try {
  const manifest = JSON.parse(await readFile(semanticManifestPath, 'utf8'));
  for (const asset of manifest.files) {
    const path = join(semanticModelDir, asset.filename);
    const contents = await readFile(path);
    const hash = createHash('sha256').update(contents).digest('hex');
    if (contents.byteLength !== asset.bytes || hash !== asset.sha256) {
      throw new Error(`Pinned semantic asset integrity check failed: ${asset.filename}`);
    }
  }
  semanticModelReady = true;
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

// public/ is gitignored, so a fresh clone and a plain deploy both ship without these. Saying so
// here is the difference between a known gap and an "Improve with local AI" button that 404s.
if (!semanticModelReady) {
  console.warn(
    [
      '',
      'WARNING: on-device AI is disabled - the pinned model is missing from public/assets/models.',
      '  Fix with: npm run prepare:semantic',
      '  Without it the "Improve with local AI" control stays hidden for every visitor.',
      '',
    ].join('\n'),
  );
}

try {
  const funds = await stat('public/assets/match-fund-vectors-v2.bin');
  // Shard zero stands in for all of them: they are written in one pass, so if it is there they are.
  const shard = await stat('public/assets/match-project-vectors-v2-0.bin');
  console.log(`Vector catalogs ready: ${funds.size} bytes funds / ${shard.size} bytes per project shard`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  console.warn(
    [
      '',
      'WARNING: precomputed vector catalogs are missing from public/assets.',
      '  Fix with: npm run build:semantic-vectors -- <match-index.v2.json | url>',
      '  Without them, choosing a catalog project falls back to keyword matching for every visitor.',
      '',
    ].join('\n'),
  );
}
console.log(`Matching browser bundles: ${gzipBytes} bytes gzip`);
