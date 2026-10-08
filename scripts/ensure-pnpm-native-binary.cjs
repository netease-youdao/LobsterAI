'use strict';

/**
 * Make sure the pnpm that will run inside the OpenClaw source tree is actually
 * executable, before the build reaches its first `pnpm install`.
 *
 * OpenClaw pins its package manager through package.json "packageManager".
 * pnpm honours that pin by downloading the requested version into its store and
 * forwarding to it — but that download does not run build scripts. pnpm v12+
 * ships as a Rust binary whose npm wrapper contains only a placeholder bin; the
 * real binary is hard-linked into place by the wrapper's own preinstall
 * (install.js). With the preinstall skipped, the generated shim points at a
 * text file and the build dies with an opaque "is not recognized as an internal
 * or external command" (Windows) or "Exec format error" (POSIX), naming a path
 * deep inside the pnpm store.
 *
 * This script probes the forwarding path and, when it is broken, runs the
 * wrapper's install.js — precisely what the skipped preinstall would have done.
 * When pnpm already works it is a no-op.
 *
 * Usage:
 *   node scripts/ensure-pnpm-native-binary.cjs [openclaw-src]
 *
 * Environment variables:
 *   OPENCLAW_SRC  – OpenClaw source path (default: ../openclaw)
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

function log(msg) {
  console.log(`[pnpm-preflight] ${msg}`);
}

function die(msg) {
  console.error(`[pnpm-preflight] ERROR: ${msg}`);
  process.exit(1);
}

// pnpm is a .cmd shim on Windows, which spawnSync cannot exec without a shell.
function runPnpm(args, cwd) {
  return spawnSync('pnpm', args, {
    cwd,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
}

/** Version pnpm reports in `cwd`, or null if it cannot run there at all. */
function probePnpmVersion(cwd) {
  const result = runPnpm(['--version'], cwd);
  if (result.status !== 0) return null;
  const version = (result.stdout || '').trim();
  return /^\d+\.\d+\.\d+/.test(version) ? version : null;
}

const openclawSrc =
  process.argv[2] || process.env.OPENCLAW_SRC || path.resolve(rootDir, '..', 'openclaw');

if (!fs.existsSync(path.join(openclawSrc, 'package.json'))) {
  log(`No OpenClaw package.json at ${openclawSrc}, skipping.`);
  process.exit(0);
}

// The pin is what triggers the store download; without one pnpm just runs itself.
let pinnedVersion = null;
try {
  const spec = JSON.parse(fs.readFileSync(path.join(openclawSrc, 'package.json'), 'utf-8'))
    .packageManager;
  // e.g. "pnpm@12.1.0+sha512.d9b8276d..." — the hash suffix is not part of the version.
  const match = /^pnpm@([^+\s]+)/.exec(spec || '');
  pinnedVersion = match ? match[1] : null;
} catch (e) {
  log(`Could not read OpenClaw package.json (${e.message}), skipping.`);
  process.exit(0);
}

if (!pinnedVersion) {
  log('OpenClaw does not pin pnpm via "packageManager", skipping.');
  process.exit(0);
}

const probedVersion = probePnpmVersion(openclawSrc);
if (probedVersion !== null) {
  log(`pnpm ${probedVersion} runs in the OpenClaw source tree (pinned: ${pinnedVersion}).`);
  process.exit(0);
}

log(`pnpm cannot run in ${openclawSrc}; repairing the pinned pnpm@${pinnedVersion} download.`);

// Locate the store copy. Resolve the store path from this repo, which has no
// "packageManager" pin and therefore uses the working, locally installed pnpm.
const storeResult = runPnpm(['store', 'path'], rootDir);
if (storeResult.status !== 0) {
  die(
    'Could not resolve the pnpm store path. Is pnpm installed and working?\n' +
    `  Install the pinned version directly: npm install -g pnpm@${pinnedVersion}`
  );
}
const storePath = (storeResult.stdout || '').trim();

// Self-managed versions live at <store>/links/@/pnpm/<version>/<integrity-hash>/.
const versionDir = path.join(storePath, 'links', '@', 'pnpm', pinnedVersion);
let wrapperDirs = [];
try {
  wrapperDirs = fs
    .readdirSync(versionDir)
    .map((hash) => path.join(versionDir, hash, 'node_modules', 'pnpm'))
    .filter((dir) => fs.existsSync(path.join(dir, 'install.js')));
} catch {
  // versionDir missing — either pnpm changed its store layout or the download
  // never happened. Either way there is nothing here to repair.
}

if (wrapperDirs.length === 0) {
  die(
    `Found no pnpm@${pinnedVersion} wrapper to repair under ${versionDir}.\n` +
    `  Install the pinned version directly: npm install -g pnpm@${pinnedVersion}`
  );
}

for (const wrapperDir of wrapperDirs) {
  // install.js is idempotent: it hard-links the platform binary over the bins.
  const result = spawnSync(process.execPath, ['install.js'], {
    cwd: wrapperDir,
    encoding: 'utf-8',
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    die(
      `Failed to link the pnpm native binary in ${wrapperDir}.\n` +
      `  Install the pinned version directly: npm install -g pnpm@${pinnedVersion}`
    );
  }
}

const repairedVersion = probePnpmVersion(openclawSrc);
if (repairedVersion === null) {
  die(
    `pnpm still cannot run in ${openclawSrc} after linking its native binary.\n` +
    `  Install the pinned version directly: npm install -g pnpm@${pinnedVersion}`
  );
}

log(`Repaired: pnpm ${repairedVersion} now runs in the OpenClaw source tree.`);
