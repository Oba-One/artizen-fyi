import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { env, pipeline } from '@huggingface/transformers';

// Semantic scoring uses a different weight profile from the baseline ranker, so it produces a
// different score distribution. Band thresholds calibrated on baseline scores collapse under it -
// every result reads "Strong fit". This measures the semantic distribution so the semantic bands
// can be set from data rather than guessed.
const inputPath = process.argv[2];
const sampleSize = Number(process.argv[3] || 300);
if (!inputPath) {
  console.error('Usage: node scripts/calibrate-semantic-v2.mjs <match-index-v2.json> [sample]');
  process.exitCode = 1;
} else {
  const index = JSON.parse(await readFile(inputPath, 'utf8'));
  if (index.schemaVersion !== 2 || !index.semantic) throw new Error('A MatchIndexV2 with a semantic manifest is required');

  const temp = await mkdtemp(join(tmpdir(), 'artizen-semantic-calibrate-'));
  const outfile = join(temp, 'engine.mjs');
  try {
    await build({
      stdin: {
        contents: `export { prepareMatchIndexV2, matchFundsV2 } from ${JSON.stringify(join(process.cwd(), 'src/matching/engine-v2.ts'))};`,
        resolveDir: process.cwd(),
        sourcefile: 'semantic-calibrate-entry.ts',
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'silent',
    });
    const { prepareMatchIndexV2, matchFundsV2 } = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
    const prepared = prepareMatchIndexV2(index);

    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = `${resolve('public/assets/models')}/`;
    env.useFSCache = false;
    const extractor = await pipeline('feature-extraction', index.semantic.modelId, {
      dtype: index.semantic.dtype,
      revision: index.semantic.modelRevision,
      local_files_only: true,
      device: 'cpu',
    });

    const dimensions = index.semantic.dimensions;
    const truncate = (values, offset) => {
      const vector = new Float32Array(dimensions);
      let norm = 0;
      for (let i = 0; i < dimensions; i += 1) {
        const value = Number(values[offset + i] || 0);
        vector[i] = value;
        norm += value * value;
      }
      const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
      for (let i = 0; i < vector.length; i += 1) vector[i] *= scale;
      return vector;
    };
    const embed = async (texts) => {
      const output = await extractor(texts, { pooling: 'mean', normalize: true });
      const full = output.dims.at(-1);
      return texts.map((_t, i) => truncate(output.data, i * full));
    };
    const cosine = (a, b) => {
      let total = 0;
      for (let i = 0; i < a.length; i += 1) total += a[i] * b[i];
      return Math.max(0, Math.min(1, total));
    };

    const fundVectors = new Map();
    for (let start = 0; start < index.funds.length; start += 16) {
      const batch = index.funds.slice(start, start + 16);
      const vectors = await embed(batch.map((fund) => fund.profileText));
      batch.forEach((fund, i) => fundVectors.set(fund.id, vectors[i]));
    }
    console.error(`Embedded ${fundVectors.size} fund profiles`);

    const usable = index.projects.filter((p) => p.description || p.tags.length);
    const step = Math.max(1, Math.floor(usable.length / sampleSize));
    const sampled = [];
    for (let i = 0; i < usable.length && sampled.length < sampleSize; i += step) sampled.push(usable[i]);

    const rank1 = [];
    const rank3 = [];
    const rank10 = [];
    const all = [];
    for (let start = 0; start < sampled.length; start += 16) {
      const batch = sampled.slice(start, start + 16);
      const vectors = await embed(batch.map((p) => [p.name, p.description, ...p.tags].filter(Boolean).join('. ')));
      batch.forEach((project, i) => {
        const scores = new Map();
        for (const fund of index.funds) {
          const vector = fundVectors.get(fund.id);
          if (vector) scores.set(fund.id, cosine(vectors[i], vector));
        }
        const result = matchFundsV2(prepared, { title: project.name, description: project.description, tags: project.tags }, scores);
        if (!result.sufficient || !result.recommendations.length) return;
        const ranked = result.recommendations.map((row) => row.score);
        rank1.push(ranked[0]);
        if (ranked[2] != null) rank3.push(ranked[2]);
        if (ranked[9] != null) rank10.push(ranked[9]);
        for (const score of ranked) if (score > 0) all.push(score);
      });
      console.error(`Scored ${Math.min(start + batch.length, sampled.length)}/${sampled.length} projects`);
    }
    await extractor.dispose();

    const round = (v) => Number(v.toFixed(4));
    const quantile = (values, q) => {
      if (!values.length) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))];
    };
    const describe = (label, values) => ({
      label,
      n: values.length,
      p10: round(quantile(values, 0.1)),
      p25: round(quantile(values, 0.25)),
      p50: round(quantile(values, 0.5)),
      p75: round(quantile(values, 0.75)),
      p90: round(quantile(values, 0.9)),
      max: round(quantile(values, 1)),
    });
    const reach = (threshold) => ({
      threshold,
      projectsWithAtLeastOne: round(rank1.filter((s) => s >= threshold).length / Math.max(1, rank1.length)),
      shareOfAllPairs: round(all.filter((s) => s >= threshold).length / Math.max(1, all.length)),
    });

    console.log(
      JSON.stringify(
        {
          scoring: index.scoring,
          scoredProjects: rank1.length,
          distributions: [describe('rank1', rank1), describe('rank3', rank3), describe('rank10', rank10), describe('allPositive', all)],
          candidates: [0.5, 0.55, 0.58, 0.6, 0.62, 0.65, 0.68, 0.7, 0.75].map(reach),
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
