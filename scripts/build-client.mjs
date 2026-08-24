import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
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

// Every ort-wasm-simd-threaded variant is copied on purpose. ONNX Runtime picks the binary at
// runtime from the backend and the browser's capabilities, so pruning "unused" variants trades
// ~37 MB of deploy size for a 404 on exactly the path this feature depends on.
const ortSource = 'node_modules/onnxruntime-web/dist';
const ortTarget = 'public/assets/ort';
await mkdir(ortTarget, { recursive: true });
for (const filename of await readdir(ortSource)) {
  if (!/^ort-wasm-simd-threaded.*\.(mjs|wasm)$/.test(filename)) continue;
  await copyFile(join(ortSource, filename), join(ortTarget, basename(filename)));
}

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
for (const path of await filesBelow('public/assets')) {
  const bytes = (await stat(path)).size;
  if (bytes > maxStaticFileBytes) {
    throw new Error(`${relative('public/assets', path)} exceeds Cloudflare's 25 MiB static-asset limit`);
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
  const projects = await stat('public/assets/match-project-vectors-v2.bin');
  console.log(`Vector catalogs ready: ${funds.size} bytes funds / ${projects.size} bytes projects`);
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
