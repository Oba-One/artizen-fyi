import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

/**
 * Which vocabulary the taxonomy is missing.
 *
 * Facet alignment is 40% of the baseline score, so a project matching none of the facets forfeits
 * most of its ranking signal and is left to lexical overlap alone. This lists the words those
 * projects actually use, ranked by how many of them use each one, so a facet can be added for a
 * real cluster rather than a guess.
 */
/**
 * The matcher's own stop list is deliberately short - dropping a word there costs recall. A report
 * has the opposite problem: pronouns and connectives crowd out the content words a facet could be
 * built from, so they are filtered here and only here.
 */
const FUNCTION_WORDS = new Set(
  ('after all also am another any are around back because been before being between both but came can come could did does'
   + ' down each even every few first get give go going got had has have her here him his how into its just know like made'
   + ' make many me more most much must my never new next now off once one only other our out over own put said same say'
   + ' see she should since so some still such take than that their them then there these they thing think this those'
   + ' though through time too under until up us use used using very want was way we well went were what when where which'
   + ' while who whose why will with within would you your').split(' '),
);

const inputPath = process.argv[2];
const limit = Number(process.argv[3] || 60);
const minimum = Number(process.argv[4] || 5);
if (!inputPath) {
  console.error('Usage: node scripts/facet-gaps.mjs <match-index.json> [terms] [min projects per term]');
  process.exitCode = 1;
} else {
  const source = JSON.parse(await readFile(inputPath, 'utf8'));
  const temp = await mkdtemp(join(tmpdir(), 'artizen-facet-gaps-'));
  const outfile = join(temp, 'facet-gaps.mjs');
  try {
    await build({
      stdin: {
        contents: `
          export { normalizeTerms } from ${JSON.stringify(join(process.cwd(), 'src/matching/engine.ts'))};
          export { MATCH_FACET_DEFINITIONS, extractFacetIds } from ${JSON.stringify(join(process.cwd(), 'src/matching/taxonomy.ts'))};
        `,
        resolveDir: process.cwd(),
        sourcefile: 'facet-gaps-entry.ts',
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'silent',
    });
    const { normalizeTerms, MATCH_FACET_DEFINITIONS, extractFacetIds } = await import(
      `${pathToFileURL(outfile).href}?v=${Date.now()}`
    );
    const index = source;
    if (index.schemaVersion !== 2) throw new Error('A schema-2 matching index is required');

    // Terms any existing alias already covers are not gaps, they are hits the project missed for
    // some other reason - drop them so the list is only vocabulary the taxonomy has no word for.
    const covered = new Set(
      MATCH_FACET_DEFINITIONS.flatMap((facet) => facet.aliases.flatMap((alias) => normalizeTerms(alias))),
    );

    // Recomputed rather than read off the record, so the script reports against the taxonomy in
    // this working tree instead of the one the index was built with.
    const uncovered = index.projects.filter(
      (project) => extractFacetIds(project.name, project.description, project.tags.join(' ')).length === 0,
    );

    const terms = (project) => new Set(normalizeTerms(`${project.name} ${project.description} ${project.tags.join(' ')}`));
    const count = (projects, into = new Map()) => {
      for (const project of projects) for (const term of terms(project)) into.set(term, (into.get(term) || 0) + 1);
      return into;
    };
    const uncoveredSet = new Set(uncovered);
    const matched = index.projects.filter((project) => !uncoveredSet.has(project));
    const gapFrequency = count(uncovered);
    const matchedFrequency = count(matched);

    const examples = new Map();
    for (const project of uncovered) {
      for (const term of terms(project)) {
        const shown = examples.get(term) || [];
        if (shown.length < 3) examples.set(term, [...shown, project.name]);
      }
    }

    // Ranked by how many of these projects use the word, which is the number a facet decision turns
    // on. The classified column is the counterweight: a term used just as often by projects the
    // taxonomy already places is general vocabulary, while one that is common here and rare there
    // is a theme with no word for it. Both readings matter, so both are shown rather than folded
    // into one score - a term can be a real gap either way, and which it is takes judgement about
    // what Artizen actually funds.
    const matchedShare = (term) => (matchedFrequency.get(term) || 0) / Math.max(1, matched.length);
    const ranked = [...gapFrequency.entries()]
      .filter(([term, frequency]) => frequency >= minimum && !covered.has(term) && !FUNCTION_WORDS.has(term))
      .map(([term, frequency]) => ({ term, frequency, share: matchedShare(term) }))
      .sort((a, b) => b.frequency - a.frequency || a.term.localeCompare(b.term))
      .slice(0, limit);

    const share = ((uncovered.length / Math.max(1, index.projects.length)) * 100).toFixed(1);
    console.log(`${uncovered.length} of ${index.projects.length} projects (${share}%) match no facet.`);
    console.log(`Taxonomy ${index.taxonomyVersion || 'unknown'} defines ${MATCH_FACET_DEFINITIONS.length} facets.\n`);
    console.log(`Terms used by at least ${minimum} of them.\n`);
    console.log('term'.padEnd(22) + 'projects'.padStart(9) + 'classified'.padStart(12) + '  examples');
    for (const row of ranked) {
      const classified = `${(row.share * 100).toFixed(2)}%`;
      console.log(
        `${row.term.padEnd(22)}${String(row.frequency).padStart(9)}${classified.padStart(12)}  ${(examples.get(row.term) || []).join(' · ')}`,
      );
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
