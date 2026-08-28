import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function assetError(message) {
  return new Error(`Matching release assets are inconsistent: ${message}`);
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
    !Array.isArray(header.records)
  ) {
    throw assetError(`${filename} is missing vector metadata`);
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
  if (!Array.isArray(index.projects) || !Array.isArray(compact.projects)) {
    throw assetError('project records are missing');
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
  if (fundHeader.records.length !== index.funds.length) {
    throw assetError(`the fund vectors contain ${fundHeader.records.length} of ${index.funds.length} funds`);
  }

  const projectRecords = [];
  const buckets = index.semantic.projectVectorBuckets;
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const filename = `match-project-vectors-${bucket}.bin`;
    const header = parseVectorHeader(await readBuffer(join(assetRoot, filename), filename), filename);
    if (header.vectorVersion !== vectorVersion || header.dimensions !== expectedDimensions) {
      throw assetError(`${filename} does not match the catalog semantic manifest`);
    }
    projectRecords.push(...header.records);
  }
  if (projectRecords.length !== index.projects.length) {
    throw assetError(`the project vectors contain ${projectRecords.length} of ${index.projects.length} projects`);
  }
  const projectFingerprints = new Map(projectRecords.map((record) => [record.id, record.fingerprint]));
  for (const project of index.projects) {
    if (projectFingerprints.get(project.id) !== project.semanticFingerprint) {
      throw assetError(`the prepared vector for ${project.id} was built from different project text`);
    }
  }

  return {
    indexVersion: index.indexVersion,
    vectorVersion,
    projects: index.projects.length,
    funds: index.funds.length,
    projectVectorBuckets: buckets,
  };
}
