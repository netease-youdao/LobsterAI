'use strict';

/**
 * install-openclaw-channel-deps.cjs
 *
 * Workaround for OpenClaw v2026.4.5–v2026.4.8 packaging bug:
 * Top-level dist/ chunk files use bare specifiers to import channel extension
 * dependencies (@buape/carbon, grammy, @larksuiteoapi/node-sdk, etc.), but
 * these packages only exist under dist/extensions/<ext>/node_modules/.
 * Node's module resolution cannot find them from the dist/ directory.
 *
 * This script installs the missing packages into the runtime's root
 * node_modules/ so that bare requires resolve correctly.
 *
 * Fixed upstream in OpenClaw v2026.4.9 (#63065).  Remove this script and its
 * pipeline step after upgrading past v2026.4.8.
 *
 * Usage:
 *   node scripts/install-openclaw-channel-deps.cjs [runtime-root]
 *
 * Defaults to vendor/openclaw-runtime/current if runtime-root is not specified.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LABEL = '[install-openclaw-channel-deps]';

// TODO(openclaw-upgrade): Remove this entire script and the "openclaw:channel-deps"
// pipeline step in package.json after upgrading OpenClaw past v2026.4.8.
//
// Packages that dist/ chunks import via bare specifiers but are only shipped
// inside individual extension node_modules.
const CHANNEL_DEPS = [
  '@buape/carbon',                  // discord
  '@larksuiteoapi/node-sdk',        // feishu / lark
  'grammy',                         // telegram
  '@grammyjs/runner',               // telegram
  '@grammyjs/transformer-throttler', // telegram
];

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const runtimeRoot = process.argv[2]
    || path.join(projectRoot, 'vendor', 'openclaw-runtime', 'current');

  if (!fs.existsSync(runtimeRoot)) {
    console.error(`${LABEL} Runtime root not found: ${runtimeRoot}`);
    process.exit(1);
  }

  const nodeModulesDir = path.join(runtimeRoot, 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    console.error(`${LABEL} node_modules not found in runtime root: ${nodeModulesDir}`);
    process.exit(1);
  }

  // Filter out packages that are already present in root node_modules.
  const missing = CHANNEL_DEPS.filter((dep) => {
    const depDir = path.join(nodeModulesDir, ...dep.split('/'));
    return !fs.existsSync(depDir);
  });

  if (missing.length === 0) {
    console.log(`${LABEL} All channel deps already present, nothing to install.`);
    return;
  }

  console.log(`${LABEL} Installing ${missing.length} missing channel dep(s): ${missing.join(', ')}`);

  const isWin = process.platform === 'win32';
  const npmCmd = isWin ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCmd, ['install', '--no-save', ...missing], {
    cwd: runtimeRoot,
    encoding: 'utf-8',
    stdio: 'pipe',
    shell: isWin,
    windowsVerbatimArguments: isWin,
    timeout: 5 * 60 * 1000,
  });

  if (result.error) {
    console.error(`${LABEL} npm install failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${LABEL} npm install failed (exit ${result.status})`);
    if (result.stderr) {
      console.error(result.stderr.substring(0, 1000));
    }
    process.exit(1);
  }

  // Verify installation
  const stillMissing = missing.filter((dep) => {
    const depDir = path.join(nodeModulesDir, ...dep.split('/'));
    return !fs.existsSync(depDir);
  });

  if (stillMissing.length > 0) {
    console.error(`${LABEL} Failed to install: ${stillMissing.join(', ')}`);
    process.exit(1);
  }

  console.log(`${LABEL} Done. Installed ${missing.length} package(s).`);
}

main();
