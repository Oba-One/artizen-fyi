import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { env, pipeline } from '@huggingface/transformers';

// How much does the on-device model actually change the recommendations? Scores alone do not
// answer that - the bands could shift while the ranking stays put. This runs both rankers over a
// sample of real projects and reports how much of the top ten is genuinely different.
const inputPath = process.argv[2];
const sampleSize = Number(process.argv[3] || 200);
if (!inputPath) {
  console.error('Usage: npm run compare:match-modes -- <match-index-v2.json> [sample]');
  process.exit(1);
}
const index = JSON.parse(await readFile(inputPath, 'utf8'));
if (index.schemaVersion !== 2 || !index.semantic) throw new Error('A MatchIndexV2 with a semantic manifest is required');
const temp = await mkdtemp(join(tmpdir(), 'artizen-compare-'));
const outfile = join(temp, 'engine.mjs');
try {
  await build({
    stdin: { contents: `export { prepareMatchIndexV2, matchFundsV2 } from ${JSON.stringify(join(process.cwd(), 'src/matching/engine-v2.ts'))};`, resolveDir: process.cwd(), sourcefile: 'e.ts' },
    outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
  });
  const { prepareMatchIndexV2, matchFundsV2 } = await import(`${pathToFileURL(outfile).href}?v=1`);
  const prepared = prepareMatchIndexV2(index);

  env.allowRemoteModels = false; env.allowLocalModels = true;
  env.localModelPath = `${resolve('public/assets/models')}/`; env.useFSCache = false;
  const extractor = await pipeline('feature-extraction', index.semantic.modelId, {
    dtype: index.semantic.dtype, revision: index.semantic.modelRevision, local_files_only: true, device: 'cpu',
  });
  const D = index.semantic.dimensions;
  const trunc = (v, off) => { const o=new Float32Array(D); let n=0; for(let i=0;i<D;i++){const x=Number(v[off+i]||0); o[i]=x; n+=x*x;} const s=n>0?1/Math.sqrt(n):1; for(let i=0;i<D;i++)o[i]*=s; return o; };
  const embed = async (texts) => { const out = await extractor(texts, {pooling:'mean', normalize:true}); const full=out.dims.at(-1); return texts.map((_t,i)=>trunc(out.data, i*full)); };
  const cos = (a,b)=>{let t=0; for(let i=0;i<a.length;i++)t+=a[i]*b[i]; return Math.max(0,Math.min(1,t));};

  const fundVecs = new Map();
  for (let s=0; s<index.funds.length; s+=16) { const b=index.funds.slice(s,s+16); const v=await embed(b.map(f=>f.profileText)); b.forEach((f,i)=>fundVecs.set(f.id, v[i])); }

  const usable = index.projects.filter(p => p.description || p.tags.length);
  const step = Math.max(1, Math.floor(usable.length / sampleSize));
  const sampled = []; for (let i=0;i<usable.length && sampled.length<sampleSize;i+=step) sampled.push(usable[i]);

  const overlaps = [], top1Same = [], newEntrants = [], bandUp = [], compared = [];
  for (let s=0; s<sampled.length; s+=16) {
    const batch = sampled.slice(s, s+16);
    const vecs = await embed(batch.map(p => [p.name,p.description,...p.tags].filter(Boolean).join('. ')));
    batch.forEach((project, i) => {
      const input = { title: project.name, description: project.description, tags: project.tags };
      const base = matchFundsV2(prepared, input);
      if (!base.sufficient || !base.recommendations.length) return;
      const scores = new Map();
      for (const f of index.funds) { const v = fundVecs.get(f.id); if (v) scores.set(f.id, cos(vecs[i], v)); }
      const sem = matchFundsV2(prepared, input, scores);
      const b10 = base.recommendations.slice(0,10).map(r=>r.fundId);
      const s10 = sem.recommendations.slice(0,10).map(r=>r.fundId);
      const shared = b10.filter(id => s10.includes(id)).length;
      overlaps.push(shared);
      top1Same.push(b10[0] === s10[0] ? 1 : 0);
      newEntrants.push(s10.filter(id => !b10.includes(id)).length);
      const evid = rs => rs.slice(0,10).filter(r=>r.fit==='strong'||r.fit==='good').length;
      bandUp.push(evid(sem.recommendations) - evid(base.recommendations));
      compared.push(1);
    });
  }
  await extractor.dispose();
  const mean = a => a.length ? Number((a.reduce((x,y)=>x+y,0)/a.length).toFixed(2)) : 0;
  const hist = a => { const h={}; for(const x of a) h[x]=(h[x]||0)+1; return h; };
  console.log(JSON.stringify({
    projectsCompared: compared.length,
    meanTop10Overlap: mean(overlaps) + ' / 10',
    top10OverlapHistogram: hist(overlaps),
    top1Unchanged: mean(top1Same),
    meanNewFundsInTop10: mean(newEntrants),
    meanEvidenceBackedDelta: mean(bandUp),
  }, null, 2));
} finally { await rm(temp, {recursive:true, force:true}); }
