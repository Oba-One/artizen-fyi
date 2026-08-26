import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const indexPath = process.argv[2];
const reviewPath = process.argv[3];
if (!indexPath || !reviewPath) {
  console.error('Usage: npm run evaluate:matching -- <match-index.json> <review-export.json>');
  process.exitCode = 1;
} else {
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const review = JSON.parse(await readFile(reviewPath, 'utf8'));
  const temp = await mkdtemp(join(tmpdir(), 'artizen-matching-eval-'));
  const outfile = join(temp, 'evaluate.mjs');
  try {
    await build({
      entryPoints: ['src/matching/evaluate.ts'],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
    });
    const evaluation = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
    const baseline = evaluation.evaluateHumanRankings(evaluation.baselineRankings(index), review.ratings, 'holdout');
    const tunedBaseline = evaluation.tuneBaselineWeights(index, review.ratings, {
      minPrecisionAt7: baseline.precisionAt7,
      maxGradeZeroRateAt7: baseline.gradeZeroRateAt7,
    });
    const tunedSemantic = evaluation.tuneSemanticWeights(review.ratings, tunedBaseline.scoring, {
      minPrecisionAt7: tunedBaseline.metrics.precisionAt7,
      maxGradeZeroRateAt7: tunedBaseline.metrics.gradeZeroRateAt7,
    });
    console.log(JSON.stringify({ reviewVersion: review.reviewVersion, baselineHoldout: baseline, tunedBaseline, tunedSemantic }, null, 2));
    if (baseline.fullyJudgedProjects === 0) process.exitCode = 1;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
