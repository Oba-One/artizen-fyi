import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const modelId = 'mixedbread-ai/mxbai-embed-xsmall-v1';
const revision = 'b0561d9a97e6b298da39f0ef3e7d3cf153b1b29a';
const base = `https://huggingface.co/${modelId}/resolve/${revision}`;
const target = join('public/assets/models', modelId);
const files = [
  'config.json',
  'config_sentence_transformers.json',
  'modules.json',
  'special_tokens_map.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'vocab.txt',
  '1_Pooling/config.json',
  'onnx/model_quantized.onnx',
];
const expectedModel = {
  bytes: 24_448_010,
  sha256: '952f996d8cf46c311ee8654a750fa942b71c8b94aabe69d043dbb2bcaff5528e',
};
const maxStaticFileBytes = 25 * 1024 * 1024;

async function alreadyPinned() {
  try {
    const manifest = JSON.parse(await readFile(join(target, 'asset-manifest.json'), 'utf8'));
    if (manifest.revision !== revision) return false;
    for (const asset of manifest.files) {
      const bytes = await readFile(join(target, asset.filename));
      if (bytes.byteLength !== asset.bytes) return false;
      if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

if (await alreadyPinned()) {
  console.log('Pinned local model already present and intact; skipping download.');
  process.exit(0);
}

for (const filename of files) {
  const output = join(target, filename);
  await mkdir(dirname(output), { recursive: true });
  const response = await fetch(`${base}/${filename}`, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Model asset download failed (${response.status}): ${filename}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxStaticFileBytes) throw new Error(`${filename} exceeds Cloudflare's 25 MiB asset limit`);
  if (filename === 'onnx/model_quantized.onnx') {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== expectedModel.bytes || sha256 !== expectedModel.sha256) {
      throw new Error(`Pinned model integrity check failed: ${bytes.byteLength} bytes, ${sha256}`);
    }
  }
  await writeFile(output, bytes);
}

const inventory = [];
for (const filename of files) {
  const bytes = await readFile(join(target, filename));
  inventory.push({
    filename,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
await writeFile(
  join(target, 'asset-manifest.json'),
  `${JSON.stringify({ modelId, revision, generatedAt: new Date().toISOString(), files: inventory }, null, 2)}\n`,
);
console.log(`Pinned local model ready: ${inventory.reduce((sum, row) => sum + row.bytes, 0)} bytes`);
