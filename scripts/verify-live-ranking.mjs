import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const inputPath = resolve(process.argv[2] || 'public/match/index.json');
const assetRoot = resolve(process.argv[3] || 'public/assets');
const regression = {
  projectId: '1770869215335x984989015863722000',
  fundId: '1787275976116x317304465147527700',
  label: 'Green Goods × Metacrisis',
  maxRank: 12,
};

const index = JSON.parse(await readFile(inputPath, 'utf8'));
const project = index.projects?.find((candidate) => candidate.id === regression.projectId);
const fund = index.funds?.find((candidate) => candidate.id === regression.fundId);

if (!project || !fund) {
  console.log(`${regression.label} ranking regression skipped: one or both live records are no longer published.`);
} else {
  const temp = await mkdtemp(join(tmpdir(), 'artizen-live-ranking-'));
  const shim = join(temp, 'shared.mjs');
  try {
    await build({
      stdin: {
        contents: `
          export { matchFunds, prepareMatchIndex } from ${JSON.stringify(join(process.cwd(), 'src/matching/engine.ts'))};
          export { matchInputForProject } from ${JSON.stringify(join(process.cwd(), 'src/matching/project-search.ts'))};
          export { projectVectorFingerprint, vectorBucket, vectorFingerprint } from ${JSON.stringify(join(process.cwd(), 'src/matching/semantic-text.ts'))};
          export { SEMANTIC_CATALOG } from ${JSON.stringify(join(process.cwd(), 'src/matching/semantic-config.ts'))};
          export { parseVectorCatalog, scoreAgainstFunds } from ${JSON.stringify(join(process.cwd(), 'src/client/vector-catalog.ts'))};
        `,
        resolveDir: process.cwd(),
        sourcefile: 'live-ranking-entry.ts',
      },
      outfile: shim,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'silent',
    });
    const shared = await import(`${pathToFileURL(shim).href}?v=${Date.now()}`);
    const manifest = shared.SEMANTIC_CATALOG;
    if (index.semantic?.vectorVersion !== manifest.vectorVersion) {
      throw new Error(`${regression.label} cannot run against a stale semantic catalog`);
    }
    const arrayBuffer = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const expectedFunds = new Map(
      index.funds.map((candidate) => [candidate.id, shared.vectorFingerprint(candidate.profileText)]),
    );
    const fundBytes = await readFile(join(assetRoot, 'match-fund-vectors.bin'));
    const fundVectors = shared.parseVectorCatalog(arrayBuffer(fundBytes), manifest, expectedFunds);
    const bucket = shared.vectorBucket(project.id, manifest.projectVectorBuckets);
    const expectedProjects = new Map(
      index.projects
        .filter((candidate) => shared.vectorBucket(candidate.id, manifest.projectVectorBuckets) === bucket)
        .map((candidate) => [candidate.id, shared.projectVectorFingerprint(candidate)]),
    );
    const projectBytes = await readFile(join(assetRoot, `match-project-vectors-${bucket}.bin`));
    const projectVectors = shared.parseVectorCatalog(arrayBuffer(projectBytes), manifest, expectedProjects);
    const projectVector = projectVectors.get(project.id);
    if (!projectVector || fundVectors.size !== index.funds.length) {
      throw new Error(`${regression.label} cannot run because its prepared vectors are incomplete`);
    }

    const semanticScores = shared.scoreAgainstFunds(
      projectVector,
      fundVectors,
      index.funds.map((candidate) => candidate.id),
    );
    const result = shared.matchFunds(
      shared.prepareMatchIndex(index),
      shared.matchInputForProject(project),
      semanticScores,
    );
    const rank = result.recommendations.findIndex((candidate) => candidate.fundId === fund.id) + 1;
    if (rank < 1 || rank > regression.maxRank) {
      const target = result.recommendations.find((candidate) => candidate.fundId === fund.id);
      console.error(
        'Page one:',
        result.recommendations.slice(0, regression.maxRank).map((candidate, rankIndex) => {
          const candidateFund = index.funds.find((row) => row.id === candidate.fundId);
          return {
            rank: rankIndex + 1,
            fund: candidateFund?.name || candidate.fundId,
            score: candidate.score,
            facets: candidateFund?.facets,
            breakdown: candidate.breakdown,
          };
        }),
      );
      console.error('Target:', target);
      throw new Error(
        `${regression.label} ranking regressed: ${fund.name} is rank ${rank || 'unranked'}, expected page one`,
      );
    }
    console.log(`${regression.label} ranking regression: ${fund.name} is rank ${rank} (page one).`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
