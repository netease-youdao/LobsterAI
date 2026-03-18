'use strict';

/**
 * Warmup script for V8 compile cache.
 *
 * Loads the gateway-bundle.mjs (26MB) so V8 compiles it and writes bytecode
 * to the compile cache directory. Subsequent loads by the real gateway process
 * skip V8 compilation and start in ~5s instead of ~35s.
 *
 * Usage (via ELECTRON_RUN_AS_NODE=1):
 *   set ELECTRON_RUN_AS_NODE=1
 *   set NODE_COMPILE_CACHE=<cache-dir>
 *   LobsterAI.exe <path-to>/warmup-compile-cache.cjs [--cache-dir <dir>]
 *
 * Or directly with Node.js (for testing):
 *   NODE_COMPILE_CACHE=<cache-dir> node warmup-compile-cache.cjs
 *
 * Exit codes:
 *   0 — warmup completed (or skipped/errored — never blocks caller)
 */

const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');

const t0 = Date.now();
const elapsed = () => `${Date.now() - t0}ms`;

// Parse --cache-dir argument
let cacheDir = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cache-dir' && i + 1 < args.length) {
    cacheDir = args[i + 1];
    break;
  }
}

// Default cache dir: same location the engine manager uses at runtime.
if (!cacheDir) {
  cacheDir = path.join(process.env.OPENCLAW_STATE_DIR || __dirname, '.compile-cache');
}

// Set NODE_COMPILE_CACHE env var — this enables V8 compile cache for BOTH
// CJS require() and ESM import().  The enableCompileCache() API only covers
// CJS, so we need the env var for the ESM gateway-bundle.mjs.
process.env.NODE_COMPILE_CACHE = cacheDir;

// Also call enableCompileCache() as a belt-and-suspenders measure.
try {
  const { enableCompileCache, getCompileCacheDir } = require('node:module');
  enableCompileCache(cacheDir);
  const actualDir = getCompileCacheDir();
  process.stderr.write(`[warmup] compile-cache dir: ${actualDir}\n`);
} catch (err) {
  process.stderr.write(`[warmup] enableCompileCache: ${err.message}\n`);
}

// Find the gateway bundle
const bundleCandidates = [
  path.join(__dirname, 'gateway-bundle.mjs'),
  path.join(__dirname, '..', 'resources', 'cfmind', 'gateway-bundle.mjs'),
];

let bundlePath = null;
for (const candidate of bundleCandidates) {
  if (fs.existsSync(candidate)) {
    bundlePath = candidate;
    break;
  }
}

if (!bundlePath) {
  process.stderr.write(`[warmup] No gateway-bundle.mjs found, skipping. (${elapsed()})\n`);
  process.exit(0);
}

process.stderr.write(`[warmup] Loading bundle: ${bundlePath} ...\n`);

// Load the bundle to trigger V8 compilation.
// The gateway-entry code inside the bundle will detect that it's not the main
// module (isMainModule check) and skip all side effects — no gateway starts.
const bundleUrl = pathToFileURL(bundlePath).href;
import(bundleUrl)
  .then(() => {
    try { require('node:module').flushCompileCache(); } catch (_) {}
    process.stderr.write(`[warmup] Bundle loaded successfully. (${elapsed()})\n`);
    process.exit(0);
  })
  .catch((err) => {
    // Some import errors are expected (missing native modules, etc.)
    // The compile cache is still written for the JS portions that were parsed.
    try { require('node:module').flushCompileCache(); } catch (_) {}
    process.stderr.write(`[warmup] Bundle load finished with error (cache still written): ${err.message} (${elapsed()})\n`);
    process.exit(0);
  });
