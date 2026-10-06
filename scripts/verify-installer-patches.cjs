'use strict';

// Build gate for Windows installer packaging.
//
// Every LobsterAI fix to the electron-builder NSIS templates lives in
// patches/app-builder-lib+24.13.3.patch and only reaches node_modules when
// patch-package runs, i.e. during `npm install` / `npm ci` (postinstall).
// `git pull` does not re-apply it, so a build machine that pulled a newer
// patch without reinstalling ships an installer WITHOUT the fixes, and the
// build itself never complains -- this drift happened on a dev machine once.
//
// So before every Windows installer build:
//   1. apply the patches (idempotent when already applied; fails loudly when
//      node_modules holds a stale partial application, which only `npm ci`
//      can repair), then
//   2. run the installer contract tests, which assert against the ACTUAL
//      node_modules template contents rather than the patch file.
// Any failure aborts the build.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const CONTRACT_TEST = path.join('tests', 'windowsInstallerContract.test.ts');
const PATCH_PACKAGE_BIN = path.join(REPO_ROOT, 'node_modules', 'patch-package', 'index.js');
const VITEST_BIN = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

function fail(message) {
  console.error(`[InstallerGate] ${message}`);
  process.exit(1);
}

function run(label, script, args) {
  console.log(`[InstallerGate] ${label}`);
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.error) {
    fail(`failed to start ${path.basename(script)}: ${result.error.message}`);
  }
  return result.status ?? 1;
}

for (const [label, file] of [
  ['installer contract test', path.join(REPO_ROOT, CONTRACT_TEST)],
  ['patch-package', PATCH_PACKAGE_BIN],
  ['vitest', VITEST_BIN],
]) {
  if (!fs.existsSync(file)) {
    fail(`${label} not found at ${path.relative(REPO_ROOT, file)}; run \`npm ci\` first.`);
  }
}

if (run('applying app-builder-lib patches (patch-package --error-on-fail)', PATCH_PACKAGE_BIN, ['--error-on-fail']) !== 0) {
  fail(
    'patch-package could not bring node_modules in line with patches/. node_modules most ' +
      'likely holds a stale partial application from an older patch file; run `npm ci` and ' +
      'retry. Do not ship an installer built from this tree.',
  );
}

if (run('running Windows installer contract tests', VITEST_BIN, ['run', CONTRACT_TEST]) !== 0) {
  fail(
    'installer contract tests failed: the NSIS templates in node_modules do not match what the ' +
      'installer hardening expects. Do not ship an installer built from this tree.',
  );
}

console.log('[InstallerGate] ok: patches applied and installer contracts verified.');
