'use strict';

// Build and activate the dsh runtime for the current host platform/arch.

const path = require('path');
const { spawnSync } = require('child_process');

function fail(message) {
  console.error(`[dsh-runtime-host] ${message}`);
  process.exit(1);
}

function resolveHostTargetId() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  }
  if (process.platform === 'win32') {
    return 'win-x64';
  }
  if (process.platform === 'linux') {
    return 'linux-x64';
  }
  return null;
}

const targetId = resolveHostTargetId();
if (!targetId) {
  fail(`Unsupported host platform: ${process.platform}`);
}

for (const script of ['build-dsh-runtime.cjs', 'sync-dsh-runtime-current.cjs']) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script), targetId], { stdio: 'inherit' });
  if (result.status !== 0) {
    fail(`${script} ${targetId} exited with code ${result.status}`);
  }
}
