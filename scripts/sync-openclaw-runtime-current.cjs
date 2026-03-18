'use strict';

const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(`[sync-openclaw-runtime-current] ${message}`);
  process.exit(1);
}

const targetId = (process.argv[2] || '').trim();
if (!targetId) {
  fail('Missing target id. Usage: node scripts/sync-openclaw-runtime-current.cjs <target-id>');
}

const rootDir = path.resolve(__dirname, '..');
const runtimeBaseDir = path.join(rootDir, 'vendor', 'openclaw-runtime');
const targetRuntimeDir = path.join(runtimeBaseDir, targetId);
const currentRuntimeDir = path.join(runtimeBaseDir, 'current');

if (!fs.existsSync(targetRuntimeDir)) {
  fail(`Target runtime does not exist: ${targetRuntimeDir}`);
}

// Remove existing current (handle both real dirs and symlinks/junctions safely).
try {
  const stat = fs.lstatSync(currentRuntimeDir);
  if (stat.isSymbolicLink()) {
    // Junction (Windows) or symlink (macOS/Linux) — unlink without following.
    fs.unlinkSync(currentRuntimeDir);
  } else {
    fs.rmSync(currentRuntimeDir, { recursive: true, force: true });
  }
} catch (_e) {
  // Does not exist — nothing to remove.
}

// Use a directory junction (Windows) or symlink (macOS/Linux) instead of
// copying thousands of node_modules files.  This is near-instant.
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
fs.symlinkSync(targetRuntimeDir, currentRuntimeDir, linkType);

console.log(`[sync-openclaw-runtime-current] Synced ${targetId} -> vendor/openclaw-runtime/current`);

// Extract entry files from gateway.asar if bare files are missing.
// On Windows, Electron's utilityProcess.fork() cannot load ESM from inside .asar archives,
// so bare files must exist on the real filesystem.
const gatewayAsarPath = path.join(currentRuntimeDir, 'gateway.asar');
const bareEntryPath = path.join(currentRuntimeDir, 'openclaw.mjs');
if (fs.existsSync(gatewayAsarPath) && !fs.existsSync(bareEntryPath)) {
  try {
    const asar = require('@electron/asar');
    const entries = asar.listPackage(gatewayAsarPath);
    const toExtract = entries.filter(function (e) {
      const normalized = e.replace(/\\/g, '/');
      return normalized === '/openclaw.mjs' || normalized.startsWith('/dist/');
    });

    let extracted = 0;
    for (const entry of toExtract) {
      // Use forward slashes for filesystem dest path.
      const normalized = entry.replace(/\\/g, '/').replace(/^\//, '');
      const destPath = path.join(currentRuntimeDir, normalized);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      // asar.extractFile needs the path in the same format stored in the archive.
      // On Windows the asar is packed with backslash paths; strip only the leading
      // separator and keep the rest as-is so the internal lookup matches.
      const asarEntry = entry.replace(/^[/\\]/, '');
      try {
        const content = asar.extractFile(gatewayAsarPath, asarEntry);
        fs.writeFileSync(destPath, content);
        extracted++;
      } catch (_e) {
        // directory entries, skip
      }
    }

    console.log(`[sync-openclaw-runtime-current] Extracted ${extracted}/${toExtract.length} entry files from gateway.asar`);
  } catch (err) {
    console.warn(`[sync-openclaw-runtime-current] Could not extract from gateway.asar: ${err.message}`);
  }
}
