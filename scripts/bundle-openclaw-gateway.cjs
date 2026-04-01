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

// IM / channel platform SDKs that are not installed in the runtime but imported
// by OpenClaw channel modules. Keep them external (so esbuild doesn't error on
// missing named exports) but register a Node.js module resolution hook at
// startup that returns an empty stub for any of these packages.
const STUB_PACKAGES = [
  '@buape/carbon', '@buape/carbon/gateway', '@buape/carbon/voice',
  '@whiskeysockets/baileys',
  '@slack/web-api', '@slack/bolt',
  '@discordjs/voice',
  '@grammyjs/runner', '@grammyjs/transformer-throttler',
  'grammy',
  'discord-api-types/v10', 'discord-api-types/payloads/v10',
];

const STUB_EXTERNAL_PACKAGES = [
  '@buape/carbon', '@buape/carbon/*',
  '@whiskeysockets/baileys',
  '@slack/web-api', '@slack/bolt',
  '@discordjs/voice',
  '@grammyjs/runner', '@grammyjs/transformer-throttler',
  'grammy',
  'discord-api-types', 'discord-api-types/*',
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
    platform: 'node',
    format: 'esm',
    outfile: bundleOutPath,
    external: [...EXTERNAL_PACKAGES, ...STUB_EXTERNAL_PACKAGES],
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

    // Patch chalk v4 CJS → expose Chalk constructor for v5-style usage.
    // OpenClaw code uses `new Chalk({ level })` (chalk v5 API) but the bundled
    // chalk is v4 CJS which only exports an instance, not the class.
    let bundleSrc = fs.readFileSync(bundleOutPath, 'utf8');
    const chalkCtorMatch = bundleSrc.match(/var chalk5 = (\w+)\(\);/);
    const chalkPatchTarget = 'module.exports = chalk5;';
    if (chalkCtorMatch && bundleSrc.includes(chalkPatchTarget)) {
      const ctorName = chalkCtorMatch[1];
      bundleSrc = bundleSrc.replace(
        chalkPatchTarget,
        `module.exports = chalk5;\n    module.exports.Chalk = ${ctorName};`,
      );
      fs.writeFileSync(bundleOutPath, bundleSrc);
      console.log(`[bundle-openclaw-gateway] Patched chalk v4 to expose Chalk constructor (${ctorName})`);
    }
    const allExternalPkgs = [...EXTERNAL_PACKAGES, ...STUB_EXTERNAL_PACKAGES];

    // Build a set of all external specifiers (expanding globs like '@img/*')
    const externalExact = new Set();
    const externalPrefixes = [];
    for (const ext of allExternalPkgs) {
      if (ext.endsWith('/*')) {
        externalPrefixes.push(ext.slice(0, -2));
      } else {
        externalExact.add(ext);
      }
    }
    const isExternal = (spec) => {
      if (externalExact.has(spec)) return true;
      return externalPrefixes.some(p => spec === p || spec.startsWith(p + '/'));
    };

    // Extract all import specifiers and their named exports from the bundle
    const specExports = new Map();
    const importRe = /import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g;
    let m;
    while ((m = importRe.exec(bundleSrc)) !== null) {
      const specifier = m[2];
      if (!isExternal(specifier)) continue;
      if (!specExports.has(specifier)) specExports.set(specifier, new Set());
      const names = m[1].split(',').map(n => {
        const trimmed = n.trim();
        const asMatch = trimmed.match(/^(\S+)\s+as\s+/);
        return asMatch ? asMatch[1] : trimmed;
      }).filter(Boolean);
      for (const name of names) specExports.get(specifier).add(name);
    }
    const defaultRe = /import\s+(\w+)\s+from\s+["']([^"']+)["']/g;
    while ((m = defaultRe.exec(bundleSrc)) !== null) {
      if (!isExternal(m[2])) continue;
      if (!specExports.has(m[2])) specExports.set(m[2], new Set());
    }
    // Collect namespace imports: import * as Foo from "pkg" → track Foo → "pkg" mapping.
    const namespaceMap = new Map(); // localName → specifier
    const starRe = /import\s+\*\s+as\s+(\w+)\s+from\s+["']([^"']+)["']/g;
    while ((m = starRe.exec(bundleSrc)) !== null) {
      if (!isExternal(m[2])) continue;
      if (!specExports.has(m[2])) specExports.set(m[2], new Set());
      namespaceMap.set(m[1], m[2]);
    }

    // Scan for property accesses on namespace imports (e.g. PiCodingAgent.Foo).
    // ESM Module Namespace Objects only expose explicit named exports, so these
    // properties must be included in the stub's export list.
    for (const [localName, specifier] of namespaceMap) {
      const propRe = new RegExp(`${localName}\\.(\\w+)`, 'g');
      let pm;
      while ((pm = propRe.exec(bundleSrc)) !== null) {
        specExports.get(specifier).add(pm[1]);
      }
    }

    // Group by root package name
    const nodeModulesDir = path.join(runtimeDir, 'node_modules');
    const pkgGroups = new Map();
    for (const [specifier, exports] of specExports) {
      const parts = specifier.split('/');
      const rootName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      const subPath = specifier.startsWith('@') ? parts.slice(2).join('/') : parts.slice(1).join('/');
      if (!pkgGroups.has(rootName)) pkgGroups.set(rootName, { subPaths: new Set(), allExports: new Set() });
      const group = pkgGroups.get(rootName);
      if (subPath) group.subPaths.add(subPath);
      for (const e of exports) group.allExports.add(e);
    }

    let stubCount = 0;
    for (const [rootName, { subPaths, allExports }] of pkgGroups) {
      const pkgDir = path.join(nodeModulesDir, ...rootName.split('/'));
      // Skip packages that are already properly installed
      const existingPkg = path.join(pkgDir, 'package.json');
      if (fs.existsSync(existingPkg)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(existingPkg, 'utf8'));
          if (pkg.version && pkg.version !== '0.0.0-stub') continue;
        } catch {}
      }

      fs.mkdirSync(pkgDir, { recursive: true });

      const exportsMapJson = { '.': './index.mjs' };
      for (const sub of subPaths) exportsMapJson['./' + sub] = './index.mjs';
      exportsMapJson['./*'] = './index.mjs';

      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
        name: rootName,
        version: '0.0.0-stub',
        type: 'module',
        main: 'index.mjs',
        exports: exportsMapJson,
      }, null, 2) + '\n');

       const namedExports = [...allExports];
      const lines = [
        // Proxy stub that safely handles primitive coercion, iteration, and property access.
        // Without Symbol.toPrimitive, string concatenation like `"prefix" + proxy` throws
        // "Cannot convert object to primitive value".
        'const P = new Proxy(function(){}, {' +
        '  get: (_, k) => {' +
        '    if (k === Symbol.toPrimitive) return () => "";' +
        '    if (k === Symbol.iterator) return function*(){};' +
        '    if (k === "toString" || k === "valueOf") return () => "";' +
        '    if (k === "then") return undefined;' +  // prevent treating P as thenable
        '    return P;' +
        '  },' +
        '  apply: () => P,' +
        '  construct: () => P' +
        '});',
      ];
      if (namedExports.length > 0) {
        lines.push(`export { ${namedExports.map(n => `P as ${n}`).join(', ')} };`);
      }
      lines.push('export default P;');
      lines.push('');
      fs.writeFileSync(path.join(pkgDir, 'index.mjs'), lines.join('\n'));
      stubCount++;
    }
    if (stubCount > 0) {
      console.log(`[bundle-openclaw-gateway] Created ${stubCount} stub package(s) for missing external deps`);
    }
  })
  .catch((err) => {
    console.error('[bundle-openclaw-gateway] esbuild failed:', err.message || err);
    process.exit(1);
  });
