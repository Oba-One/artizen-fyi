import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const source = process.argv[2];
const outputRoot = resolve(process.argv[3] || 'public/match');

async function liveIndex() {
  const temp = await mkdtemp(join(tmpdir(), 'artizen-match-catalog-'));
  const outfile = join(temp, 'builder.mjs');
  try {
    await build({
      stdin: {
        contents: `
          import { Bubble } from ${JSON.stringify(join(process.cwd(), 'src/artizen/bubble.ts'))};
          import { buildMatchIndex } from ${JSON.stringify(join(process.cwd(), 'src/matching/index.ts'))};
          export async function buildLiveIndex(previous) { return buildMatchIndex(new Bubble(), { previous }); }
        `,
        resolveDir: process.cwd(),
        sourcefile: 'match-catalog-entry.ts',
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'silent',
    });
    let previous = null;
    const deployed = await fetch('https://artizen.fyi/match/index.json', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (deployed.ok) previous = await deployed.json();
    else if (deployed.status !== 404) {
      throw new Error(`Could not read the deployed matching index (${deployed.status})`);
    }
    return await (await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)).buildLiveIndex(previous);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function readIndex() {
  if (!source) return liveIndex();
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Could not fetch the matching index (${response.status}): ${source}`);
    return response.json();
  }
  return JSON.parse(await readFile(source, 'utf8'));
}

const index = await readIndex();
if (
  index?.schemaVersion !== 2 ||
  index?.source?.kind !== 'artizen-api' ||
  !index.indexVersion ||
  !Array.isArray(index.projects) ||
  !Array.isArray(index.funds) ||
  !Array.isArray(index.relationships)
) {
  throw new Error('A non-fixture MatchIndex with projects, funds, and relationships is required');
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(join(outputRoot, 'project'), { recursive: true });

const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`);
await Promise.all([
  writeJson(join(outputRoot, 'index.json'), index),
  writeJson(join(outputRoot, 'core.json'), { ...index, projects: [], relationships: [] }),
  writeJson(join(outputRoot, 'projects.json'), { indexVersion: index.indexVersion, projects: index.projects }),
]);

for (let start = 0; start < index.projects.length; start += 100) {
  await Promise.all(
    index.projects.slice(start, start + 100).map((project) => {
      const key = createHash('sha256').update(String(project.id)).digest('hex');
      return writeJson(join(outputRoot, 'project', `${key}.json`), {
        indexVersion: index.indexVersion,
        projects: [project],
      });
    }),
  );
}

console.log(
  `Deploy catalog ${index.indexVersion}: ${index.projects.length} projects, ${index.funds.length} funds, ` +
    `${index.relationships.length} relationships`,
);
