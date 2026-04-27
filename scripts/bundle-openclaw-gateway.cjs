'use strict';

/**
 * Bundle the openclaw gateway entry point into a single file using esbuild.
 *
 * This eliminates the expensive ESM module resolution overhead (~1100 files)
 * that causes Electron's utilityProcess to take 80-100s to start the gateway.
 * The single-file bundle loads in ~2-12s instead.
 *
 * Usage:
 *   node scripts/bundle-openclaw-gateway.cjs [runtime-dir]
 *
 * If runtime-dir is not specified, defaults to vendor/openclaw-runtime/current.
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const runtimeDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(rootDir, 'vendor', 'openclaw-runtime', 'current');

const bundleOutPath = path.join(runtimeDir, 'gateway-bundle.mjs');

// Prefer gateway-entry.js (dedicated gateway entry, skips CLI overhead).
// Fall back to entry.js (full CLI entry) if gateway-entry.js doesn't exist.
const gatewayEntryPath = path.join(runtimeDir, 'dist', 'gateway-entry.js');
const fullEntryPath = path.join(runtimeDir, 'dist', 'entry.js');
const entryPath = fs.existsSync(gatewayEntryPath) ? gatewayEntryPath : fullEntryPath;

if (!fs.existsSync(entryPath)) {
  console.error(`[bundle-openclaw-gateway] Entry point not found: ${entryPath}`);
  console.error(`[bundle-openclaw-gateway] Make sure the openclaw runtime is built first.`);
  process.exit(1);
}

// Skip if bundle is already up-to-date (newer than the entry point).
if (fs.existsSync(bundleOutPath)) {
  const bundleStat = fs.statSync(bundleOutPath);
  const entryStat = fs.statSync(entryPath);
  if (bundleStat.mtimeMs > entryStat.mtimeMs) {
    console.log(`[bundle-openclaw-gateway] Bundle is up-to-date, skipping.`);
    process.exit(0);
  }
}

console.log(`[bundle-openclaw-gateway] Bundling: ${path.relative(runtimeDir, entryPath)}`);
console.log(`[bundle-openclaw-gateway] Output:   ${path.relative(runtimeDir, bundleOutPath)}`);

// Native addons and heavy optional deps that must NOT be bundled.
// These are resolved at runtime from node_modules/.
const EXTERNAL_PACKAGES = [
  // Native image processing
  'sharp', '@img/*',
  // Native terminal
  '@lydell/*',
  // Native clipboard
  '@mariozechner/*',
  // Native canvas
  '@napi-rs/*',
  // Native audio (davey)
  '@snazzah/*',
  // Native FFI
  'koffi',
  // Electron (provided by host)
  'electron',
  // LLM runtime (large, optional)
  'node-llama-cpp',
  // FFmpeg binary (large, optional)
  'ffmpeg-static',
  // Browser automation (large, optional)
  'chromium-bidi', 'playwright-core', 'playwright',
  // Native SQLite
  'better-sqlite3',
  // TypeScript runtime compiler — uses dynamic require("../dist/babel.cjs")
  // that esbuild can't rewrite correctly (resolves relative to bundle instead
  // of the original jiti module location).
  'jiti',
];

let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  console.error('[bundle-openclaw-gateway] esbuild not found. Run: npm install --save-dev esbuild');
  process.exit(1);
}

const t0 = Date.now();

esbuild
  .build({
    entryPoints: [entryPath],
    bundle: true,
    minify: true,
    platform: 'node',
    format: 'esm',
    outfile: bundleOutPath,
    external: EXTERNAL_PACKAGES,
    // Inject createRequire so that esbuild's __require shim works in ESM context.
    // Without this, CJS modules (e.g. @smithy/*) that call require("buffer")
    // fail with "Dynamic require of X is not supported" when loaded via import().
    banner: {
      js: `import { createRequire as __bundleCreateRequire } from 'node:module';\n` +
          `import { fileURLToPath as __bundleFileURLToPath } from 'node:url';\n` +
          `const require = __bundleCreateRequire(import.meta.url);\n` +
          `const __filename = __bundleFileURLToPath(import.meta.url);\n` +
          `const __dirname = __bundleFileURLToPath(new URL('.', import.meta.url));\n`,
    },
    // Silence warnings about __dirname/__filename in ESM (they're polyfilled above).
    logLevel: 'warning',
  })
  .then((result) => {
    const elapsed = Date.now() - t0;
    const sizeKB = Math.round(fs.statSync(bundleOutPath).size / 1024);
    console.log(
      `[bundle-openclaw-gateway] Done in ${elapsed}ms (${sizeKB} KB)` +
        (result.warnings.length ? `, ${result.warnings.length} warnings` : ''),
    );
  })
  .catch((err) => {
    console.error('[bundle-openclaw-gateway] esbuild failed:', err.message || err);
    process.exit(1);
  });
