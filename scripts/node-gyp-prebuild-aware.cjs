'use strict';

/**
 * node-gyp entry point that npm uses inside this repository (wired through the
 * `node-gyp` setting in .npmrc, which npm exposes to lifecycle scripts as
 * `npm_config_node_gyp`).
 *
 * Why it exists:
 *   better-sqlite3 >= 13 ships prebuilt N-API binaries inside its npm package
 *   (prebuilds/<platform>-<arch>.node) and sets "gypfile": false so npm's
 *   implicit `node-gyp rebuild` is not supposed to run for it. npm honours the
 *   flag only when the dependency tree comes straight from the registry
 *   manifests. Whenever the tree is built from package-lock.json (npm ci, a
 *   repeat `npm install`, `npm rebuild`) the lockfile carries no "gypfile"
 *   field, npm sees binding.gyp on disk and synthesises `node-gyp rebuild`
 *   anyway. On Windows without Visual Studio node-gyp cannot even configure,
 *   so `npm install` dies before the app can start.
 *
 * What it does:
 *   When the package being built opted out of implicit builds ("gypfile":
 *   false) and already contains a prebuilt binary for this host, exit
 *   successfully without touching node-gyp. That is the outcome better-sqlite3's
 *   own binding.gyp produces ("do nothing when the package contains a prebuild
 *   for the host"), minus the toolchain requirement. Every other invocation,
 *   including explicit `--force_build=1` builds, is forwarded verbatim to npm's
 *   bundled node-gyp.
 *
 * The .npmrc path is resolved against the current working directory, so run
 * npm commands from the repository root (the documented workflow).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function log(msg) {
  console.log(`[node-gyp-prebuild-aware] ${msg}`);
}

function readPackageJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
}

// Same target naming better-sqlite3 uses in lib/binding.js.
function hostPrebuildTarget() {
  const isLinuxMusl =
    process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
  return `${isLinuxMusl ? 'linuxmusl' : process.platform}-${process.arch}`;
}

function findHostPrebuild(pkgDir) {
  const candidate = path.join(pkgDir, 'prebuilds', `${hostPrebuildTarget()}.node`);
  return fs.existsSync(candidate) ? candidate : null;
}

// npm's bundled node-gyp: the binary npm would have used without this wrapper.
function findBundledNodeGyp() {
  const candidates = [];
  if (process.env.npm_execpath) {
    // <npm>/bin/npm-cli.js -> <npm>/node_modules/node-gyp/bin/node-gyp.js
    candidates.push(
      path.resolve(path.dirname(process.env.npm_execpath), '..', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
    );
  }
  const nodeDir = path.dirname(process.execPath);
  // Windows layout: <node>/node_modules/npm; POSIX layout: <prefix>/lib/node_modules/npm
  candidates.push(path.join(nodeDir, 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'));
  candidates.push(path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    return require.resolve('node-gyp/bin/node-gyp.js');
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);
const pkgDir = process.cwd();
const pkg = readPackageJson(pkgDir);
const explicitBuild = args.some((arg) => /^--force_build(=|$)/.test(arg));

if (pkg && pkg.gypfile === false && !explicitBuild) {
  const prebuild = findHostPrebuild(pkgDir);
  if (prebuild) {
    log(
      `${pkg.name}@${pkg.version} ships ${path.relative(pkgDir, prebuild)} for this host; ` +
        `skipping "node-gyp ${args.join(' ')}".`
    );
    process.exit(0);
  }
}

const nodeGyp = findBundledNodeGyp();
if (!nodeGyp) {
  console.error('[node-gyp-prebuild-aware] ERROR: could not locate the node-gyp bundled with npm.');
  process.exit(1);
}

const result = spawnSync(process.execPath, [nodeGyp, ...args], { stdio: 'inherit' });
if (result.error) {
  console.error(`[node-gyp-prebuild-aware] ERROR: failed to start node-gyp: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
