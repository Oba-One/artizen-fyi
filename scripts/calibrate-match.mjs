import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const inputPath = process.argv[2];
const sampleSize = Number(process.argv[3] || 0) || Infinity;
if (!inputPath) {
  console.error('Usage: node scripts/calibrate-match.mjs <match-index.json> [sample]');
  process.exitCode = 1;
} else {
  const source = JSON.parse(await readFile(inputPath, 'utf8'));
  const temp = await mkdtemp(join(tmpdir(), 'artizen-matching-calibrate-'));
  const outfile = join(temp, 'calibrate.mjs');
  try {
    await build({
      stdin: {
        contents: `
          export { prepareMatchIndex, matchFunds } from ${JSON.stringify(join(process.cwd(), 'src/matching/engine.ts'))};
        `,
        resolveDir: process.cwd(),
        sourcefile: 'calibrate-entry.ts',
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
    const prepared = prepareMatchIndex(index);

    const projects = index.projects.filter((project) => project.description || project.tags.length);
    const sampled = Number.isFinite(sampleSize) ? projects.slice(0, sampleSize) : projects;
    const rank1 = [];
    const rank3 = [];
    const rank7 = [];
    const allScores = [];
    let insufficient = 0;
    for (const project of sampled) {
      const result = matchFunds(prepared, {
        title: project.name,
        description: project.description,
        tags: project.tags,
      });
      if (!result.sufficient || result.recommendations.length === 0) {
        insufficient += 1;
        continue;
      }
      const scores = result.recommendations.map((row) => row.score);
      rank1.push(scores[0]);
      if (scores[2] != null) rank3.push(scores[2]);
      if (scores[6] != null) rank7.push(scores[6]);
      for (const score of scores) if (score > 0) allScores.push(score);
    }

    const quantile = (values, q) => {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))];
    };
    const describe = (label, values) => ({
      label,
      n: values.length,
      min: round(quantile(values, 0)),
      p10: round(quantile(values, 0.1)),
      p25: round(quantile(values, 0.25)),
      p50: round(quantile(values, 0.5)),
      p75: round(quantile(values, 0.75)),
      p90: round(quantile(values, 0.9)),
      max: round(quantile(values, 1)),
    });
    const round = (value) => Number(value.toFixed(4));

    // How many projects would reach each band, and how wide each band gets, at a candidate threshold.
    const reach = (values, threshold) => round(values.filter((score) => score >= threshold).length / Math.max(1, values.length));
    const bandWidths = (threshold) => {
      const widths = sampled.slice(0, 200).map((project) => {
        const result = matchFunds(prepared, { title: project.name, description: project.description, tags: project.tags });
        return result.recommendations.filter((row) => row.score >= threshold).length;
      });
      return { p50: quantile(widths, 0.5), p90: quantile(widths, 0.9), max: quantile(widths, 1) };
    };

    const candidates = [0.4, 0.42, 0.44, 0.45, 0.46, 0.47, 0.48, 0.5, 0.55];
    console.log(
      JSON.stringify(
        {
          source: index.source,
          scoring: index.scoring,
          scoredProjects: rank1.length,
          insufficientProjects: insufficient,
          distributions: [describe('rank1', rank1), describe('rank3', rank3), describe('rank7', rank7), describe('allPositive', allScores)],
          strongCandidates: candidates.map((threshold) => ({
            threshold,
            projectsWithAtLeastOneStrong: reach(rank1, threshold),
            fundsPerProject: bandWidths(threshold),
          })),
          goodCandidates: [0.3, 0.34, 0.36, 0.38, 0.4].map((threshold) => ({
            threshold,
            projectsWithAtLeastOneGood: reach(rank1, threshold),
            fundsPerProject: bandWidths(threshold),
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
