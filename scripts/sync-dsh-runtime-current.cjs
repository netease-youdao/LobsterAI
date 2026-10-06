'use strict';

// Point vendor/dsh-runtime/current at a built target runtime. Mirrors
// scripts/sync-openclaw-runtime-current.cjs (symlink on macOS/Linux, junction
// on Windows so no elevation is needed).

const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(`[sync-dsh-runtime-current] ${message}`);
  process.exit(1);
}

const targetId = (process.argv[2] || '').trim();
if (!targetId) {
  fail('Missing target id. Usage: node scripts/sync-dsh-runtime-current.cjs <target-id>');
}

const rootDir = path.resolve(__dirname, '..');
const runtimeBaseDir = path.join(rootDir, 'vendor', 'dsh-runtime');
const targetRuntimeDir = path.join(runtimeBaseDir, targetId);
const currentRuntimeDir = path.join(runtimeBaseDir, 'current');

if (!fs.existsSync(targetRuntimeDir)) {
  fail(`Target runtime does not exist: ${targetRuntimeDir}`);
}

try {
  const stat = fs.lstatSync(currentRuntimeDir);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(currentRuntimeDir);
  } else {
    fs.rmSync(currentRuntimeDir, { recursive: true, force: true });
  }
} catch (_e) {
  // Does not exist — nothing to remove.
}

const linkType = process.platform === 'win32' ? 'junction' : 'dir';
fs.symlinkSync(targetRuntimeDir, currentRuntimeDir, linkType);

console.log(`[sync-dsh-runtime-current] Synced ${targetId} -> vendor/dsh-runtime/current`);
