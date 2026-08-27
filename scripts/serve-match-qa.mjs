import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const indexPath = resolve(process.argv[2] || 'test/fixtures/match-index.json');
const port = Number(process.argv[3] || 8787);
const sourceText = await readFile(indexPath, 'utf8');
const index = JSON.parse(sourceText);
if (index.schemaVersion !== 2 || !Array.isArray(index.funds) || index.funds.length === 0) {
  throw new Error(`Invalid matching index file: ${indexPath}`);
}
const indexText = JSON.stringify(index);

const temp = await mkdtemp(join(tmpdir(), 'artizen-fyi-match-qa-'));
const bundlePath = join(temp, 'worker.mjs');
await build({
  entryPoints: ['src/index.ts'],
  outfile: bundlePath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  loader: {
    '.css': 'text',
    '.svg': 'text',
    '.ico': 'dataurl',
    '.png': 'dataurl',
  },
});
const worker = (await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`)).default;

const kv = {
  async get(key) {
    if (key === 'artizen/matching/v2') return indexText;
    return null;
  },
  async put() {},
  async delete() {},
  async list() {
    return { keys: [], list_complete: true };
  },
};

const assetTypes = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
};

function contentType(pathname) {
  const extension = pathname.slice(pathname.lastIndexOf('.'));
  return assetTypes[extension] || 'application/octet-stream';
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const requestUrl = new URL(incoming.url || '/', `http://${incoming.headers.host || `localhost:${port}`}`);
    const method = incoming.method || 'GET';
    if (requestUrl.pathname.startsWith('/assets/')) {
      console.log(`[QA request] ${method} ${requestUrl.pathname}${requestUrl.search} body=0`);
      const assetPath = resolve('public', `.${requestUrl.pathname}`);
      const body = await readFile(assetPath).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (!body) {
        outgoing.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        outgoing.end('QA asset not available');
        return;
      }
      outgoing.writeHead(200, { 'content-type': contentType(requestUrl.pathname), 'cache-control': 'no-store' });
      outgoing.end(body);
      return;
    }

    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks);
    console.log(`[QA request] ${method} ${requestUrl.pathname}${requestUrl.search} body=${body?.byteLength || 0}`);
    const request = new Request(requestUrl, { method, headers: incoming.headers, body });
    const response = await worker.fetch(request, { CACHE: kv });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    outgoing.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    outgoing.end('QA server error');
  }
});

server.on('close', () => void rm(temp, { recursive: true, force: true }));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

server.listen(port, '127.0.0.1', () => {
  console.log(`Artizen match QA ready at http://localhost:${port}/match`);
  console.log(`${index.projects.length} projects, ${index.funds.length} funds, ${index.relationships.length} relationships`);
  console.log(`V${index.schemaVersion} index ${index.indexVersion} from ${index.generatedAt} (${index.source?.kind || 'legacy'})`);
});
