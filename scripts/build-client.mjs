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

const ortSource = 'node_modules/onnxruntime-web/dist';
const ortTarget = 'public/assets/ort';
await mkdir(ortTarget, { recursive: true });
for (const filename of await readdir(ortSource)) {
  if (!/^ort-wasm-simd-threaded.*\.(mjs|wasm)$/.test(filename)) continue;
  await copyFile(join(ortSource, filename), join(ortTarget, basename(filename)));
}

await writeFile(
  'public/_headers',
  '/assets/*\n  Cache-Control: public, max-age=0, must-revalidate\n  X-Content-Type-Options: nosniff\n',
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

const semanticManifestPath = 'public/assets/models/mixedbread-ai/mxbai-embed-xsmall-v1/asset-manifest.json';
try {
  const manifest = JSON.parse(await readFile(semanticManifestPath, 'utf8'));
  for (const asset of manifest.files) {
    const path = join('public/assets/models/mixedbread-ai/mxbai-embed-xsmall-v1', asset.filename);
    const contents = await readFile(path);
    const hash = createHash('sha256').update(contents).digest('hex');
    if (contents.byteLength !== asset.bytes || hash !== asset.sha256) {
      throw new Error(`Pinned semantic asset integrity check failed: ${asset.filename}`);
    }
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
console.log(`Matching browser bundles: ${gzipBytes} bytes gzip`);
