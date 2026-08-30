import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function assetError(message) {
  return new Error(`Matching release assets are inconsistent: ${message}`);
}

function vectorFingerprint(text) {
  let low = 2166136261;
  let high = 2166136261 ^ 0x5bf03635;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    low = Math.imul(low ^ code, 16777619) >>> 0;
    high = Math.imul(high ^ (code + index), 16777639) >>> 0;
  }
  return low.toString(16).padStart(8, '0') + high.toString(16).padStart(8, '0');
}

function vectorBucket(id, buckets) {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16777619) >>> 0;
  }
  return hash % buckets;
}

function verifyRecords(records, expected, filename) {
  if (records.length !== expected.size) {
    throw assetError(`${filename} contains ${records.length} of ${expected.size} expected records`);
  }
  const seen = new Set();
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || typeof record.fingerprint !== 'string') {
      throw assetError(`${filename} has invalid record metadata`);
    }
    if (seen.has(record.id)) throw assetError(`${filename} contains duplicate record ${record.id}`);
    seen.add(record.id);
    const fingerprint = expected.get(record.id);
    if (fingerprint == null) throw assetError(`${filename} contains unexpected record ${record.id}`);
    if (record.fingerprint !== fingerprint) {
      throw assetError(`${filename} record ${record.id} was built from different text`);
    }
  }
}

export function parseVectorHeader(buffer, filename = 'vector catalog') {
  if (buffer.byteLength < 12 || buffer.subarray(0, 4).toString() !== 'AMV3') {
    throw assetError(`${filename} is not an AMV3 vector catalog`);
  }
  const jsonLength = buffer.readUInt32LE(4);
  const dataOffset = buffer.readUInt32LE(8);
  if (jsonLength <= 0 || dataOffset < 12 + jsonLength || dataOffset > buffer.byteLength) {
    throw assetError(`${filename} has an invalid header`);
  }
  let header;
  try {
    header = JSON.parse(buffer.subarray(12, 12 + jsonLength).toString('utf8'));
  } catch {
    throw assetError(`${filename} has an unreadable header`);
  }
  if (
    typeof header.vectorVersion !== 'string' ||
    !Number.isInteger(header.dimensions) ||
    header.dimensions <= 0 ||
    !Array.isArray(header.records)
  ) {
    throw assetError(`${filename} is missing vector metadata`);
  }
  if (dataOffset % 4 !== 0) throw assetError(`${filename} has an unaligned vector payload`);
  const expectedBytes = dataOffset + header.records.length * header.dimensions * 4;
  if (buffer.byteLength !== expectedBytes) {
    throw assetError(`${filename} payload is ${buffer.byteLength} bytes; expected ${expectedBytes}`);
  }
  return header;
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw assetError(`${label} is missing`);
    throw assetError(`${label} could not be read`);
  }
}

async function readBuffer(path, label) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') throw assetError(`${label} is missing`);
    throw assetError(`${label} could not be read`);
  }
}

/**
 * Checks the exact release contract the browser depends on: one index version, one vector version,
 * full project narratives, compact fingerprints, and a vector record for every catalog record.
 */
export async function verifyMatchingReleaseAssets(root = 'public', expectedManifest) {
  const matchRoot = join(root, 'match');
  const assetRoot = join(root, 'assets');
  const [index, core, compact] = await Promise.all([
    readJson(join(matchRoot, 'index.json'), 'match/index.json'),
    readJson(join(matchRoot, 'core.json'), 'match/core.json'),
    readJson(join(matchRoot, 'projects.json'), 'match/projects.json'),
  ]);
  if (!index.semantic?.vectorVersion || !core.semantic?.vectorVersion) {
    throw assetError('the catalog has no semantic manifest');
  }
  if (index.indexVersion !== core.indexVersion || index.indexVersion !== compact.indexVersion) {
    throw assetError('core.json, projects.json, and index.json use different index versions');
  }
  const vectorVersion = index.semantic.vectorVersion;
  if (core.semantic.vectorVersion !== vectorVersion) {
    throw assetError('core.json and index.json use different vector versions');
  }
  if (expectedManifest?.vectorVersion && expectedManifest.vectorVersion !== vectorVersion) {
    throw assetError(
      `the browser expects ${expectedManifest.vectorVersion}, but the catalog and vectors use ${vectorVersion}; rebuild them`,
    );
  }
  if (
    !Array.isArray(index.projects) ||
    !Array.isArray(compact.projects) ||
    !Array.isArray(index.funds) ||
    !Array.isArray(core.funds)
  ) {
    throw assetError('project or fund records are missing');
  }
  const compactById = new Map(compact.projects.map((project) => [project.id, project]));
  for (const project of index.projects) {
    if (!Object.hasOwn(project, 'context')) {
      throw assetError(`full project ${project.id} has no narrative context`);
    }
    if (!/^[a-f0-9]{16}$/.test(project.semanticFingerprint || '')) {
      throw assetError(`full project ${project.id} has no semantic fingerprint`);
    }
    if (compactById.get(project.id)?.semanticFingerprint !== project.semanticFingerprint) {
      throw assetError(`compact project ${project.id} does not carry its full-text fingerprint`);
    }
  }

  const fundPath = join(assetRoot, 'match-fund-vectors.bin');
  const fundHeader = parseVectorHeader(await readBuffer(fundPath, 'match-fund-vectors.bin'), 'match-fund-vectors.bin');
  const expectedDimensions = index.semantic.dimensions;
  if (fundHeader.vectorVersion !== vectorVersion || fundHeader.dimensions !== expectedDimensions) {
    throw assetError('the fund vectors do not match the catalog semantic manifest');
  }
  const expectedFunds = new Map(
    index.funds.map((fund) => [
      fund.id,
      vectorFingerprint(typeof fund.profileText === 'string' ? fund.profileText : ''),
    ]),
  );
  const coreFunds = new Map(
    core.funds.map((fund) => [
      fund.id,
      vectorFingerprint(typeof fund.profileText === 'string' ? fund.profileText : ''),
    ]),
  );
  if (
    expectedFunds.size !== index.funds.length ||
    coreFunds.size !== core.funds.length ||
    expectedFunds.size !== coreFunds.size
  ) {
    throw assetError('core.json and index.json contain different or duplicate funds');
  }
  for (const [fundId, fingerprint] of expectedFunds) {
    if (coreFunds.get(fundId) !== fingerprint) {
      throw assetError(`core fund ${fundId} does not match its full catalog profileText`);
    }
  }
  verifyRecords(fundHeader.records, expectedFunds, 'match-fund-vectors.bin');

  const buckets = index.semantic.projectVectorBuckets;
  if (!Number.isInteger(buckets) || buckets <= 0) {
    throw assetError('the catalog has an invalid project shard count');
  }
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const filename = `match-project-vectors-${bucket}.bin`;
    const header = parseVectorHeader(await readBuffer(join(assetRoot, filename), filename), filename);
    if (header.vectorVersion !== vectorVersion || header.dimensions !== expectedDimensions) {
      throw assetError(`${filename} does not match the catalog semantic manifest`);
    }
    const expectedProjects = new Map(
      index.projects
        .filter((project) => vectorBucket(project.id, buckets) === bucket)
        .map((project) => [project.id, project.semanticFingerprint]),
    );
    verifyRecords(header.records, expectedProjects, filename);
  }

  return {
    indexVersion: index.indexVersion,
    vectorVersion,
    projects: index.projects.length,
    funds: index.funds.length,
    projectVectorBuckets: buckets,
  };
}
