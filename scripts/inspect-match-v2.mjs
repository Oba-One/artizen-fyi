import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const inputPath = process.argv[2];
const query = process.argv.slice(3).join(' ');
if (!inputPath || !query) {
  console.error('Usage: node scripts/inspect-match-v2.mjs <match-index.json> <project name>');
  process.exitCode = 1;
} else {
  const source = JSON.parse(await readFile(inputPath, 'utf8'));
  const temp = await mkdtemp(join(tmpdir(), 'artizen-matching-v2-inspect-'));
  const outfile = join(temp, 'inspect.mjs');
  try {
    await build({
      stdin: {
        contents: `
          export { upgradeMatchIndexV1 } from ${JSON.stringify(join(process.cwd(), 'src/matching/index-v2.ts'))};
          export { prepareMatchIndexV2, matchFundsV2 } from ${JSON.stringify(join(process.cwd(), 'src/matching/engine-v2.ts'))};
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
    const { upgradeMatchIndexV1, prepareMatchIndexV2, matchFundsV2 } = await import(
      `${pathToFileURL(outfile).href}?v=${Date.now()}`
    );
    const index = source.schemaVersion === 2 ? source : await upgradeMatchIndexV1(source, 'fixture');
    const lower = query.toLowerCase();
    const project = index.projects.find(
      (candidate) => candidate.name.toLowerCase() === lower || candidate.name.toLowerCase().includes(lower),
    );
    const matchInput = project
      ? { projectId: project.id, title: project.name, description: project.description, tags: project.tags }
      : { description: query, tags: [] };
    const result = matchFundsV2(prepareMatchIndexV2(index), {
      ...matchInput,
    });
    const anonymousResult = project
      ? matchFundsV2(prepareMatchIndexV2(index), { title: project.name, description: project.description, tags: project.tags })
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
