'use strict';

// Builds selection-hook's Windows addon from LobsterAI's patched source.
//
// patches/selection-hook+<version>.patch changes the addon's C++ (patch-package applies it on
// `npm install`), but the package also ships a prebuilt binary that node-gyp-build loads in
// preference to compiling, so the patch alone never reaches the app. This script compiles the
// patched source with node-gyp and puts the result in place of the shipped
// prebuilds/win32-x64 binary, which electron-builder packages (npmRebuild is off). The
// node-gyp output under build/ is removed afterwards: node-gyp-build would load it first, and
// its object files and symbols must not be packaged.
//
// Run by dist:win (a build without it would ship the unpatched addon) and by developers on
// Windows who want the patched addon locally. Needs the Visual Studio C++ build tools.
// Skipped when the installed binary was already built from the current patch.

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const PACKAGE_DIR = path.join(REPO_ROOT, 'node_modules', 'selection-hook');
const ARCH = 'x64';
const PREBUILD = path.join(PACKAGE_DIR, 'prebuilds', `win32-${ARCH}`, 'selection-hook.node');
const STAMP = `${PREBUILD}.lobsterai-patch`;
const BUILD_DIR = path.join(PACKAGE_DIR, 'build');
const BUILT = path.join(BUILD_DIR, 'Release', 'selection-hook.node');
// A line the patch adds; its absence means patch-package has not run on this tree.
const PATCH_MARKER = 'kMaxTextRectLogicalHeight';
const PATCHED_SOURCE = path.join(PACKAGE_DIR, 'src', 'windows', 'core', 'engine.cc');

function fail(message) {
  console.error(`[SelectionHook] ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`[SelectionHook] ${message}`);
}

/** npm passes its bundled node-gyp to lifecycle scripts; fall back to the copy beside node. */
function findNodeGyp() {
  const candidates = [
    process.env.npm_config_node_gyp,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
  ];
  return candidates.find(file => file && fs.existsSync(file)) ?? null;
}

if (process.platform !== 'win32') {
  log('not Windows; the macOS and Linux addons are used as shipped.');
  process.exit(0);
}

const packageJson = path.join(PACKAGE_DIR, 'package.json');
if (!fs.existsSync(packageJson)) fail('node_modules/selection-hook is missing; run `npm ci` first.');
const { version } = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
const patchFile = path.join(REPO_ROOT, 'patches', `selection-hook+${version}.patch`);
if (!fs.existsSync(patchFile)) {
  fail(`no ${path.relative(REPO_ROOT, patchFile)} for the installed selection-hook ${version}; ` +
    'port the patch to this version (or drop this build step if upstream has the fix).');
}
if (!fs.readFileSync(PATCHED_SOURCE, 'utf8').includes(PATCH_MARKER)) {
  fail('the selection-hook patch is not applied to node_modules; run `npx patch-package` or `npm ci` first.');
}

const patchHash = crypto.createHash('sha256').update(fs.readFileSync(patchFile)).digest('hex');
const stampMatches = fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8').trim() === patchHash;
if (stampMatches && !fs.existsSync(BUILD_DIR)) {
  log(`prebuilds/win32-${ARCH} already holds the addon built from the current patch.`);
  process.exit(0);
}

const nodeGyp = findNodeGyp();
if (!nodeGyp) fail('node-gyp not found; run this through npm (`npm run build:selection-hook`).');

log(`compiling the patched addon (${ARCH}) with ${path.relative(REPO_ROOT, nodeGyp) || nodeGyp}`);
const build = spawnSync(process.execPath, [nodeGyp, 'rebuild', `--arch=${ARCH}`], { cwd: PACKAGE_DIR, stdio: 'inherit' });
if (build.error) fail(`failed to start node-gyp: ${build.error.message}`);
if (build.status !== 0) {
  fail('node-gyp could not compile selection-hook. Install the Visual Studio C++ build tools ' +
    '("Desktop development with C++") and retry. Do not ship a Windows build without the patched addon.');
}
if (!fs.existsSync(BUILT)) fail(`node-gyp reported success but ${path.relative(REPO_ROOT, BUILT)} is missing.`);

fs.copyFileSync(BUILT, PREBUILD);
fs.rmSync(BUILD_DIR, { recursive: true, force: true });

// The copied binary must load where node-gyp-build will look for it.
const check = spawnSync(process.execPath, ['-e', [
  "const p = require('node-gyp-build').path(process.argv[1]);",
  "if (!p.endsWith(require('path').join('prebuilds', 'win32-x64', 'selection-hook.node'))) throw new Error('loads ' + p);",
  "const Hook = require(process.argv[1]); new Hook().cleanup();",
].join(' '), PACKAGE_DIR], { cwd: REPO_ROOT, encoding: 'utf8' });
if (check.status !== 0) fail(`the built addon does not load: ${(check.stderr || check.stdout).trim()}`);

fs.writeFileSync(STAMP, `${patchHash}\n`);
log(`ok: prebuilds/win32-${ARCH}/selection-hook.node is built from ${path.basename(patchFile)}.`);
