'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GATEWAY_BUNDLE_CACHE_FILE = 'gateway-bundle.cache.json';
const CACHE_VERSION = 1;
const RUNTIME_METADATA_FILES = [
  'runtime-build-info.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'node_modules/.package-lock.json',
];

function hash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function hashFile(filePath, optional = false) {
  try {
    return hash(fs.readFileSync(filePath));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

// Callers provide runtime-relative entry/output options. Only file contents,
// never the checkout location, participate in the builder fingerprint.
function createBundleBuildKey({ options, esbuildVersion, builderPaths }) {
  return hash(JSON.stringify(stableValue({
    options,
    esbuildVersion,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    builders: builderPaths.map((filePath) => hashFile(filePath)),
  })));
}

function relativeRuntimePath(runtimeRoot, filePath) {
  const relative = path.relative(runtimeRoot, filePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Bundle input/output is outside the runtime: ${filePath}`);
  }
  return relative.split(path.sep).join('/');
}

function resolveManifestPath(runtimeRoot, relative) {
  if (typeof relative !== 'string') throw new Error('Invalid bundle cache path.');
  const absolute = path.resolve(runtimeRoot, relative);
  if (relativeRuntimePath(runtimeRoot, absolute) !== relative) {
    throw new Error('Bundle cache paths must be relative to the runtime.');
  }
  return absolute;
}

function collectMetadataPaths(inputPaths) {
  const metadata = new Set(RUNTIME_METADATA_FILES);
  for (const input of inputPaths) {
    let directory = path.posix.dirname(input);
    while (true) {
      metadata.add(path.posix.join(directory, 'package.json'));
      if (directory === '.') break;
      directory = path.posix.dirname(directory);
    }
  }
  return [...metadata].sort();
}

function recordsMatch(runtimeRoot, records, optional = false) {
  return Array.isArray(records) && records.every((record) => {
    if (!record || (record.sha256 !== null && !/^[a-f0-9]{64}$/.test(record.sha256))) return false;
    if (!optional && record.sha256 === null) return false;
    return hashFile(resolveManifestPath(runtimeRoot, record.path), optional) === record.sha256;
  });
}

function isBundleCacheCurrent({ runtimeDir, bundlePath, buildKey }) {
  try {
    const runtimeRoot = fs.realpathSync(runtimeDir);
    const manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, GATEWAY_BUNDLE_CACHE_FILE), 'utf8'));
    const outputPath = relativeRuntimePath(runtimeRoot, fs.realpathSync(bundlePath));
    if (manifest.version !== CACHE_VERSION || manifest.buildKey !== buildKey) return false;
    if (manifest.output?.path !== outputPath || !Array.isArray(manifest.inputs) || !manifest.inputs.length) return false;
    for (const input of manifest.inputs) resolveManifestPath(runtimeRoot, input.path);
    const expectedMetadata = collectMetadataPaths(manifest.inputs.map((input) => input.path));
    if (JSON.stringify(manifest.metadata?.map((record) => record.path)) !== JSON.stringify(expectedMetadata)) return false;
    return recordsMatch(runtimeRoot, [manifest.output])
      && recordsMatch(runtimeRoot, manifest.inputs)
      && recordsMatch(runtimeRoot, manifest.metadata, true);
  } catch {
    // A missing, old, malformed, or incomplete manifest always rebuilds.
    return false;
  }
}

// Track the previous esbuild graph and package-resolution metadata without
// walking all of node_modules. Missing package.json/lockfiles are recorded too,
// so adding one invalidates the cache. A new, higher-priority resolution
// candidate with no graph/metadata change still requires a forced rebuild.
function writeBundleCache({ runtimeDir, bundlePath, buildKey, metafile, metafileBaseDir = process.cwd() }) {
  const runtimeRoot = fs.realpathSync(runtimeDir);
  const cachePath = path.join(runtimeRoot, GATEWAY_BUNDLE_CACHE_FILE);
  fs.rmSync(cachePath, { force: true });

  let inputPaths;
  try {
    inputPaths = [...new Set(Object.keys(metafile.inputs).map((input) => (
      relativeRuntimePath(runtimeRoot, fs.realpathSync(path.resolve(metafileBaseDir, input)))
    )))].sort();
  } catch {
    // Keep successful builds usable when a source lives outside the runtime or
    // comes from a virtual module. Such a graph cannot have a portable cache.
    return false;
  }
  if (!inputPaths.length) return false;

  const snapshot = (relative, optional = false) => ({
    path: relative,
    sha256: hashFile(resolveManifestPath(runtimeRoot, relative), optional),
  });
  const manifest = {
    version: CACHE_VERSION,
    buildKey,
    inputs: inputPaths.map((input) => snapshot(input)),
    metadata: collectMetadataPaths(inputPaths).map((relative) => snapshot(relative, true)),
    output: snapshot(relativeRuntimePath(runtimeRoot, fs.realpathSync(bundlePath))),
  };
  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(temporaryPath, cachePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return true;
}

module.exports = {
  GATEWAY_BUNDLE_CACHE_FILE,
  createBundleBuildKey,
  isBundleCacheCurrent,
  writeBundleCache,
};
