import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { env, pipeline } from '@huggingface/transformers';

const inputPath = resolve(process.argv[2] || 'public/match/index.json');
const targetReferences = process.argv.slice(3);
const index = JSON.parse(await readFile(inputPath, 'utf8'));
if (index.schemaVersion !== 2 || !index.semantic || !Array.isArray(index.projects) || !Array.isArray(index.funds)) {
  throw new Error('A MatchIndex with semantic projects and funds is required');
}

function arrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

const temp = await mkdtemp(join(tmpdir(), 'artizen-prepared-parity-'));
const shim = join(temp, 'shared.mjs');
let extractor;
try {
  await build({
    stdin: {
      contents: `
        export { matchFunds, prepareMatchIndex } from ${JSON.stringify(join(process.cwd(), 'src/matching/engine.ts'))};
        export { matchInputForProject } from ${JSON.stringify(join(process.cwd(), 'src/matching/project-search.ts'))};
        export { matchInputVectorText, projectVectorFingerprint, vectorBucket, vectorFingerprint } from ${JSON.stringify(join(process.cwd(), 'src/matching/semantic-text.ts'))};
        export { SEMANTIC_CATALOG } from ${JSON.stringify(join(process.cwd(), 'src/matching/semantic-config.ts'))};
        export { parseVectorCatalog, scoreAgainstFunds, truncateAndNormalize } from ${JSON.stringify(join(process.cwd(), 'src/client/vector-catalog.ts'))};
      `,
      resolveDir: process.cwd(),
      sourcefile: 'prepared-parity-entry.ts',
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
  if (index.semantic.vectorVersion !== manifest.vectorVersion) {
    throw new Error(
      `Catalog vectors are ${index.semantic.vectorVersion}, but the browser expects ${manifest.vectorVersion}`,
    );
  }
  const expectedFunds = new Map(index.funds.map((fund) => [fund.id, shared.vectorFingerprint(fund.profileText)]));
  const fundBytes = await readFile(resolve('public/assets/match-fund-vectors.bin'));
  const fundVectors = shared.parseVectorCatalog(arrayBuffer(fundBytes), manifest, expectedFunds);
  if (fundVectors.size !== index.funds.length) {
    throw new Error(`Prepared fund vectors cover ${fundVectors.size} of ${index.funds.length} funds`);
  }

  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = `${resolve('public/assets/models')}/`;
  env.useFSCache = false;
  extractor = await pipeline('feature-extraction', manifest.modelId, {
    dtype: manifest.dtype,
    revision: manifest.modelRevision,
    local_files_only: true,
    device: 'cpu',
  });
  const preparedIndex = shared.prepareMatchIndex(index);
  const fundIds = index.funds.map((fund) => fund.id);
  const fundsById = new Map(index.funds.map((fund) => [fund.id, fund]));
  const targetProjects = targetReferences.length
    ? targetReferences.map((reference) => {
        const needle = reference.toLowerCase();
        const project = index.projects.find(
          (candidate) =>
            candidate.id === reference ||
            candidate.name.toLowerCase() === needle ||
            candidate.slug.toLowerCase() === needle,
        );
        if (!project) throw new Error(`Project not found for prepared parity QA: ${reference}`);
        return project;
      })
    : (() => {
        const candidates = index.projects.filter(
          (project) =>
            project.semanticFingerprint &&
            (project.description || project.context?.description || project.tags.length),
        );
        if (!candidates.length) throw new Error('No project is available for prepared parity QA');
        return [candidates[Math.floor(candidates.length / 2)]];
      })();

  for (const project of targetProjects) {
    const bucket = shared.vectorBucket(project.id, manifest.projectVectorBuckets);
    const expectedProjects = new Map(
      index.projects
        .filter((candidate) => shared.vectorBucket(candidate.id, manifest.projectVectorBuckets) === bucket)
        .map((candidate) => [candidate.id, shared.projectVectorFingerprint(candidate)]),
    );
    const projectBytes = await readFile(resolve(`public/assets/match-project-vectors-${bucket}.bin`));
    const projectVectors = shared.parseVectorCatalog(arrayBuffer(projectBytes), manifest, expectedProjects);
    const preparedVector = projectVectors.get(project.id);
    if (!preparedVector) throw new Error(`${project.name} has no verified prepared project vector`);

    const input = shared.matchInputForProject(project);
    const output = await extractor(shared.matchInputVectorText(input), { pooling: 'mean', normalize: true });
    const freshVector = shared.truncateAndNormalize(output.data, 0, manifest.dimensions);
    let cosine = 0;
    for (let dimension = 0; dimension < manifest.dimensions; dimension += 1) {
      cosine += preparedVector[dimension] * freshVector[dimension];
    }
    // The release builder embeds batches of sixteen while the browser embeds one project. ONNX
    // can vary slightly with batch shape, so require near-identical meaning and exact top-ten
    // behavior rather than pretending the floating-point vectors must be bit-identical.
    if (cosine < 0.995) {
      throw new Error(`${project.name} prepared and on-device project vectors diverge (cosine ${cosine})`);
    }

    const preparedScores = shared.scoreAgainstFunds(preparedVector, fundVectors, fundIds);
    const freshScores = shared.scoreAgainstFunds(freshVector, fundVectors, fundIds);
    const preparedResult = shared.matchFunds(preparedIndex, input, preparedScores);
    const freshResult = shared.matchFunds(preparedIndex, input, freshScores);
    const preparedTop = preparedResult.recommendations.slice(0, 10).map((row) => row.fundId);
    const freshTop = freshResult.recommendations.slice(0, 10).map((row) => row.fundId);
    const freshRanks = new Map(freshTop.map((fundId, rank) => [fundId, rank]));
    const sharedTop = preparedTop.filter((fundId) => freshRanks.has(fundId));
    const maxRankDelta = Math.max(
      ...preparedTop.flatMap((fundId, rank) => {
        const freshRank = freshRanks.get(fundId);
        return freshRank == null ? [] : [Math.abs(rank - freshRank)];
      }),
    );
    const freshByFund = new Map(freshResult.recommendations.map((row) => [row.fundId, row]));
    const maxScoreDelta = Math.max(
      ...preparedResult.recommendations
        .slice(0, 10)
        .map((row) => Math.abs(row.score - (freshByFund.get(row.fundId)?.score ?? 0))),
    );
    // The tenth-place boundary can flip when two near-tied scores move by floating-point noise.
    // Guard the decision users actually notice: same winner, at least nine shared results, no
    // shared result moving more than two places, and no displayed candidate changing materially.
    if (sharedTop.length < 9 || preparedTop[0] !== freshTop[0] || maxRankDelta > 2 || maxScoreDelta > 0.01) {
      console.error('Prepared:', preparedTop.map((fundId) => fundsById.get(fundId)?.name || fundId));
      console.error('On-device:', freshTop.map((fundId) => fundsById.get(fundId)?.name || fundId));
      throw new Error(
        `${project.name} prepared and on-device rankings diverge (rank delta ${maxRankDelta}, score delta ${maxScoreDelta})`,
      );
    }
    const names = preparedTop.map((fundId) => fundsById.get(fundId)?.name || fundId);
    console.log(
      `Prepared parity ${project.name}: cosine ${cosine.toFixed(6)}; ${sharedTop.length}/10 overlap; max rank delta ${maxRankDelta}`,
    );
    names.forEach((name, index) => console.log(`  ${index + 1}. ${name}`));
  }
} finally {
  await extractor?.dispose();
  await rm(temp, { recursive: true, force: true });
}
