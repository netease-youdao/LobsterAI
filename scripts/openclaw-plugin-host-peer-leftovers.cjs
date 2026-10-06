'use strict';

/**
 * Detect and remove dependency trees that only exist because npm installed the
 * OpenClaw host package (`openclaw`) as a plugin peerDependency.
 *
 * OpenClaw installs archive plugins with `npm install --omit=dev` and without
 * `--omit=peer`, so a required `openclaw` peer is downloaded at the newest
 * registry version together with its whole dependency tree. The host gateway
 * provides openclaw at runtime, and since openclaw 2026.8.x no longer ships an
 * npm-shrinkwrap.json that tree is hoisted next to the plugin's real
 * dependencies (openclaw@2026.8.2 adds @anthropic-ai/claude-agent-sdk with a
 * 300+ MB platform binary). Deleting node_modules/openclaw alone leaves all of
 * it behind.
 *
 * npm's hidden lockfile (node_modules/.package-lock.json) records every
 * installed package with its dependency edges. Starting from the plugin
 * manifest, walk every edge except the one pointing at `openclaw`; whatever is
 * not reachable only serves the host peer and can be removed. This mirrors
 * `npm prune` with the openclaw peer dropped from the manifest, without
 * running npm at packaging time.
 */

const fs = require('fs');
const path = require('path');

const HOST_PEER_PACKAGE_NAME = 'openclaw';
const HIDDEN_LOCKFILE_NAME = '.package-lock.json';
const HOST_PEER_LOCATION = `node_modules/${HOST_PEER_PACKAGE_NAME}`;

// Packages that only ever arrive through the openclaw peer tree. They are
// flagged even when no hidden lockfile is available to reason about edges.
const HOST_PEER_ONLY_PACKAGE_PREFIXES = ['@anthropic-ai/claude-agent-sdk'];

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function lstatIfExists(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch {
    return null;
  }
}

function readdirNames(dirPath) {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

function measureDirectorySize(targetPath) {
  const stat = lstatIfExists(targetPath);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;

  let total = 0;
  for (const entry of readdirNames(targetPath)) {
    total += measureDirectorySize(path.join(targetPath, entry));
  }
  return total;
}

function dependencyNames(entry) {
  const names = new Set();
  if (!isRecord(entry)) return names;
  for (const group of [entry.dependencies, entry.optionalDependencies, entry.peerDependencies]) {
    if (!isRecord(group)) continue;
    for (const name of Object.keys(group)) {
      if (name !== HOST_PEER_PACKAGE_NAME) names.add(name);
    }
  }
  return names;
}

function containingNodeModulesLocation(location) {
  const index = location.lastIndexOf('node_modules/');
  return location.slice(0, index + 'node_modules'.length);
}

function parentPackageLocation(location) {
  const index = location.lastIndexOf('/node_modules/');
  return index === -1 ? '' : location.slice(0, index);
}

/**
 * Resolve `name` the way Node would from a package installed at `fromLocation`
 * ('' for the plugin root), using only the lockfile's package locations.
 */
function resolveDependencyLocation(fromLocation, name, packages) {
  let base = fromLocation;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (Object.prototype.hasOwnProperty.call(packages, candidate)) return candidate;
    if (!base) return null;
    base = parentPackageLocation(base);
  }
}

function collectReachableLocations(pluginDir, packages) {
  const manifest = readJsonIfExists(path.join(pluginDir, 'package.json')) || {};
  const reachable = new Set();
  const queue = [];

  const visit = (fromLocation, entry) => {
    for (const name of dependencyNames(entry)) {
      const location = resolveDependencyLocation(fromLocation, name, packages);
      if (location && !reachable.has(location)) {
        reachable.add(location);
        queue.push(location);
      }
    }
  };

  visit('', manifest);
  while (queue.length > 0) {
    const location = queue.shift();
    visit(location, packages[location]);
  }
  return reachable;
}

function listTopLevelPackageLocations(nodeModulesDir) {
  const locations = [];
  for (const entry of readdirNames(nodeModulesDir)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      for (const scoped of readdirNames(path.join(nodeModulesDir, entry))) {
        if (!scoped.startsWith('.')) locations.push(`node_modules/${entry}/${scoped}`);
      }
      continue;
    }
    locations.push(`node_modules/${entry}`);
  }
  return locations;
}

function isHostPeerOnlyPackage(location) {
  const name = location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
  return HOST_PEER_ONLY_PACKAGE_PREFIXES.some(
    (prefix) => name === prefix || name.startsWith(`${prefix}-`) || name.startsWith(`${prefix}/`),
  );
}

function hasLeftoverAncestor(location, leftovers) {
  let current = parentPackageLocation(location);
  while (current) {
    if (leftovers.has(current)) return true;
    current = parentPackageLocation(current);
  }
  return false;
}

/**
 * List packages under `pluginDir/node_modules` that only exist to serve the
 * openclaw peer. Each item is `{ location, reason }` with a lockfile-style
 * location such as `node_modules/@anthropic-ai/claude-agent-sdk`.
 */
function collectHostPeerLeftovers(pluginDir) {
  const nodeModulesDir = path.join(pluginDir, 'node_modules');
  // Only reason about a node_modules the plugin owns. A symlinked node_modules
  // (for example one pointing at a shared or host install) must never be
  // inspected or pruned through.
  const nodeModulesStat = lstatIfExists(nodeModulesDir);
  if (!nodeModulesStat || !nodeModulesStat.isDirectory()) return [];

  const leftovers = new Map();
  if (lstatIfExists(path.join(pluginDir, HOST_PEER_LOCATION))) {
    leftovers.set(HOST_PEER_LOCATION, 'openclaw host package installed into the plugin');
  }
  for (const location of listTopLevelPackageLocations(nodeModulesDir)) {
    if (isHostPeerOnlyPackage(location)) {
      leftovers.set(location, 'only shipped by the openclaw peer tree');
    }
  }

  const lock = readJsonIfExists(path.join(nodeModulesDir, HIDDEN_LOCKFILE_NAME));
  if (lock && isRecord(lock.packages)) {
    const reachable = collectReachableLocations(pluginDir, lock.packages);
    for (const location of Object.keys(lock.packages)) {
      if (!location || reachable.has(location) || leftovers.has(location)) continue;
      if (!lstatIfExists(path.join(pluginDir, location))) continue;
      leftovers.set(location, 'unreachable once openclaw is provided by the host');
    }
  }

  return [...leftovers.entries()]
    .filter(([location]) => !hasLeftoverAncestor(location, leftovers))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([location, reason]) => ({ location, reason }));
}

function removeDanglingBinLinks(binDir) {
  for (const entry of readdirNames(binDir)) {
    const linkPath = path.join(binDir, entry);
    const stat = lstatIfExists(linkPath);
    if (!stat || !stat.isSymbolicLink()) continue;
    try {
      fs.statSync(linkPath); // follows the link; throws when the target is gone
    } catch {
      fs.unlinkSync(linkPath);
    }
  }
}

function removeEmptyScopeDirs(nodeModulesDir) {
  for (const entry of readdirNames(nodeModulesDir)) {
    if (!entry.startsWith('@')) continue;
    const scopeDir = path.join(nodeModulesDir, entry);
    const stat = lstatIfExists(scopeDir);
    if (stat && stat.isDirectory() && readdirNames(scopeDir).length === 0) {
      fs.rmdirSync(scopeDir);
    }
  }
}

// Drop the removed packages from the hidden lockfile, along with entries whose
// directory is already gone (for example an openclaw dir deleted earlier).
function rewriteHiddenLockfile(pluginDir, removedLocations) {
  const lockPath = path.join(pluginDir, 'node_modules', HIDDEN_LOCKFILE_NAME);
  const lock = readJsonIfExists(lockPath);
  if (!lock || !isRecord(lock.packages)) return;

  const packages = {};
  for (const [location, entry] of Object.entries(lock.packages)) {
    const removed = removedLocations.some(
      (removedLocation) => location === removedLocation || location.startsWith(`${removedLocation}/`),
    );
    if (removed) continue;
    if (location && !lstatIfExists(path.join(pluginDir, location))) continue;
    packages[location] = entry;
  }
  fs.writeFileSync(lockPath, `${JSON.stringify({ ...lock, packages }, null, 2)}\n`, 'utf-8');
}

function isPathInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// A leftover may only be deleted when its real parent directory lives inside
// the plugin's own node_modules; a symlinked ancestor would otherwise let the
// removal escape into a directory the plugin does not own.
function isDeletableLeftover(pluginDir, location) {
  try {
    const nodeModulesReal = fs.realpathSync(path.join(pluginDir, 'node_modules'));
    const parentReal = fs.realpathSync(path.dirname(path.join(pluginDir, location)));
    return parentReal === nodeModulesReal || isPathInside(nodeModulesReal, parentReal);
  } catch {
    return false;
  }
}

/**
 * Remove every leftover reported by collectHostPeerLeftovers, then drop the
 * removed entries from the hidden lockfile and clean up dangling `.bin` links
 * and empty scope directories. Returns `{ removed, bytesFreed }`.
 */
function pruneHostPeerLeftovers(pluginDir) {
  const leftovers = collectHostPeerLeftovers(pluginDir).filter(({ location }) =>
    isDeletableLeftover(pluginDir, location),
  );
  if (leftovers.length === 0) {
    return { removed: [], bytesFreed: 0 };
  }

  const touchedNodeModulesDirs = new Set();
  let bytesFreed = 0;
  for (const { location } of leftovers) {
    const target = path.join(pluginDir, location);
    bytesFreed += measureDirectorySize(target);
    fs.rmSync(target, { recursive: true, force: true });
    touchedNodeModulesDirs.add(path.join(pluginDir, containingNodeModulesLocation(location)));
  }

  const removed = leftovers.map((item) => item.location);
  rewriteHiddenLockfile(pluginDir, removed);
  for (const dir of touchedNodeModulesDirs) {
    removeDanglingBinLinks(path.join(dir, '.bin'));
    removeEmptyScopeDirs(dir);
  }

  return { removed, bytesFreed };
}

module.exports = {
  HOST_PEER_ONLY_PACKAGE_PREFIXES,
  HOST_PEER_PACKAGE_NAME,
  collectHostPeerLeftovers,
  collectReachableLocations,
  measureDirectorySize,
  pruneHostPeerLeftovers,
  resolveDependencyLocation,
};
