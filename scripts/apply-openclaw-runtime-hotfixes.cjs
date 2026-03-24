'use strict';

/**
 * Apply runtime hotfixes to the openclaw dist/ files BEFORE esbuild bundling.
 *
 * This ensures the gateway-bundle.mjs contains the patched code, eliminating
 * the need for the slow runtime hotfix pass (applyRuntimeHotfixes) which scans
 * ~1100 JS files via Electron's transparent asar read and takes 250+ seconds
 * on Windows.
 *
 * Usage:
 *   node scripts/apply-openclaw-runtime-hotfixes.cjs [runtime-dir]
 *
 * If runtime-dir is not specified, defaults to vendor/openclaw-runtime/current.
 */

const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const runtimeDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(rootDir, 'vendor', 'openclaw-runtime', 'current');

// Import the compiled hotfix module from dist-electron/.
// The hotfix code lives in src/main/libs/openclawRuntimeHotfix.ts and is
// compiled by `npm run compile:electron` to dist-electron/openclawRuntimeHotfix.js.
// However, compile:electron runs AFTER the runtime build in the dist:win chain,
// so we compile just this file on the fly using tsx/ts-node if the compiled
// output is not available.

let applyBundledOpenClawRuntimeHotfixes;

const compiledPath = path.join(rootDir, 'dist-electron', 'openclawRuntimeHotfix.js');
try {
  const mod = require(compiledPath);
  applyBundledOpenClawRuntimeHotfixes = mod.applyBundledOpenClawRuntimeHotfixes;
} catch {
  // Fallback: compile the TypeScript source directly using esbuild's register
  // (esbuild is already a devDependency for the bundle step).
  try {
    const esbuild = require('esbuild');
    const srcPath = path.join(rootDir, 'src', 'main', 'libs', 'openclawRuntimeHotfix.ts');
    const result = esbuild.buildSync({
      entryPoints: [srcPath],
      bundle: false,
      platform: 'node',
      format: 'cjs',
      write: false,
    });
    const code = result.outputFiles[0].text;
    const mod = new module.constructor();
    mod._compile(code, srcPath);
    applyBundledOpenClawRuntimeHotfixes = mod.exports.applyBundledOpenClawRuntimeHotfixes;
  } catch (err) {
    console.error('[apply-openclaw-runtime-hotfixes] Failed to load hotfix module:', err.message || err);
    console.error('[apply-openclaw-runtime-hotfixes] Run `npm run compile:electron` first, or ensure esbuild is installed.');
    process.exit(1);
  }
}

if (typeof applyBundledOpenClawRuntimeHotfixes !== 'function') {
  console.error('[apply-openclaw-runtime-hotfixes] applyBundledOpenClawRuntimeHotfixes is not a function');
  process.exit(1);
}

console.log(`[apply-openclaw-runtime-hotfixes] Applying hotfixes to: ${runtimeDir}`);
const result = applyBundledOpenClawRuntimeHotfixes(runtimeDir);

if (result.changed) {
  console.log(
    `[apply-openclaw-runtime-hotfixes] Patched ${result.patchedFiles.length} file(s): `
    + result.patchedFiles.map(f => path.relative(runtimeDir, f)).join(', ')
  );
} else {
  console.log('[apply-openclaw-runtime-hotfixes] No files needed patching (already up to date).');
}

if (result.errors.length > 0) {
  console.warn('[apply-openclaw-runtime-hotfixes] Warnings:', result.errors.join(' | '));
}
