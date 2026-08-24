import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const inputPath = process.argv[2];
const query = process.argv.slice(3).join(' ');
if (!inputPath || !query) {
  console.error('Usage: node scripts/inspect-match.mjs <match-index.json> <project name>');
  process.exitCode = 1;
} else {
  const source = JSON.parse(await readFile(inputPath, 'utf8'));
  const temp = await mkdtemp(join(tmpdir(), 'artizen-matching-inspect-'));
  const outfile = join(temp, 'inspect.mjs');
  try {
    await build({
      stdin: {
        contents: `
          export { prepareMatchIndex, matchFunds } from ${JSON.stringify(join(process.cwd(), 'src/matching/engine.ts'))};
        `,
        resolveDir: process.cwd(),
        sourcefile: 'inspect-entry.ts',
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
    const lower = query.toLowerCase();
    const project = index.projects.find(
      (candidate) => candidate.name.toLowerCase() === lower || candidate.name.toLowerCase().includes(lower),
    );
    const matchInput = project
      ? { projectId: project.id, title: project.name, description: project.description, tags: project.tags }
      : { description: query, tags: [] };
    const result = matchFunds(prepareMatchIndex(index), {
      ...matchInput,
    });
    const anonymousResult = project
      ? matchFunds(prepareMatchIndex(index), { title: project.name, description: project.description, tags: project.tags })
      : result;
    const projectIdInvariant = result.recommendations.every((row, rank) => {
      const anonymous = anonymousResult.recommendations[rank];
      return anonymous?.fundId === row.fundId && anonymous.score === row.score && anonymous.fit === row.fit;
    });
    console.log(
      JSON.stringify(
        {
          source: index.source,
          project: project || matchInput,
          projectIdInvariant,
          recommendations: result.recommendations.map((row, rank) => ({ rank: rank + 1, ...row })),
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
