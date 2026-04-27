'use strict';

/**
 * Pre-compile OpenClaw extension plugins from TypeScript to JavaScript.
 *
 * This eliminates the ~135s jiti/Babel runtime transpilation overhead on first
 * gateway startup.  When jiti finds a .js file it skips Babel entirely and just
 * loads it, while still applying its module alias resolution (openclaw/plugin-sdk).
 *
 * Usage:
 *   node scripts/precompile-openclaw-extensions.cjs [runtime-dir]
 *
 * If runtime-dir is not specified, defaults to vendor/openclaw-runtime/current.
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const runtimeDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(rootDir, 'vendor', 'openclaw-runtime', 'current');

const extensionsDir = path.join(runtimeDir, 'third-party-extensions');

if (!fs.existsSync(extensionsDir)) {
  console.log('[precompile-extensions] No extensions directory found, skipping.');
  process.exit(0);
}

// SDK imports that must stay external — jiti resolves them via alias at runtime.
const SDK_EXTERNALS = [
  'openclaw/plugin-sdk',
  'openclaw/plugin-sdk/*',
  'clawdbot/plugin-sdk',
  'clawdbot/plugin-sdk/*',
];

// esbuild plugin: mark relative imports into openclaw core (../../../src/...)
// as external — they only exist in the full openclaw source tree and are
// resolved at runtime by jiti.
const openclawInternalsPlugin = {
  name: 'externalize-openclaw-internals',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/.*\/src\// }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  console.error('[precompile-extensions] esbuild not found. Run: npm install --save-dev esbuild');
  process.exit(1);
}

/**
 * Resolve the TypeScript entry point for a plugin directory.
 * Returns null if the plugin is already compiled (.js) or has no TS entry.
 */
function resolvePluginEntry(pluginDir) {
  const pkgPath = path.join(pluginDir, 'package.json');

  // 1) Try package.json → openclaw.extensions
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const entries = pkg.openclaw?.extensions;
      if (Array.isArray(entries) && entries.length > 0) {
        const entry = entries[0]; // First entry is the main one
        if (entry.endsWith('.js') || entry.endsWith('.mjs') || entry.endsWith('.cjs')) {
          return null; // Already compiled
        }
        const abs = path.resolve(pluginDir, entry);
        if (fs.existsSync(abs)) {
          return { entryAbs: abs, entryRel: entry, hasPkg: true };
        }
      }
    } catch {
      // Malformed package.json — fall through to convention
    }
  }

  // 2) Convention: index.ts
  const indexTs = path.join(pluginDir, 'index.ts');
  if (fs.existsSync(indexTs)) {
    return { entryAbs: indexTs, entryRel: './index.ts', hasPkg: fs.existsSync(pkgPath) };
  }

  return null;
}

async function main() {
  const t0 = Date.now();
  const dirs = fs.readdirSync(extensionsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  let compiled = 0;
  let skipped = 0;
  let errors = 0;

  for (const name of dirs) {
    const pluginDir = path.join(extensionsDir, name);
    const entry = resolvePluginEntry(pluginDir);

    if (!entry) {
      skipped++;
      continue;
    }

    const outFile = entry.entryAbs.replace(/\.tsx?$/, '.js');
    const outRel = entry.entryRel.replace(/\.tsx?$/, '.js');

    try {
      await esbuild.build({
        entryPoints: [entry.entryAbs],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'es2023',
        outfile: outFile,
        packages: 'external',  // All node_modules deps stay external
        external: SDK_EXTERNALS,
        plugins: [openclawInternalsPlugin],
        // Silence warnings about __dirname/__filename in ESM
        logLevel: 'warning',
      });

      // Update package.json to point to the compiled .js entry
      if (entry.hasPkg) {
        const pkgPath = path.join(pluginDir, 'package.json');
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          if (Array.isArray(pkg.openclaw?.extensions)) {
            pkg.openclaw.extensions = pkg.openclaw.extensions.map(e =>
              e === entry.entryRel ? outRel : e,
            );
            fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
          }
        } catch {
          // Non-critical — jiti will still find index.js by convention
        }
      }

      compiled++;
    } catch (err) {
      console.error(`[precompile-extensions] FAILED ${name}: ${err.message || err}`);
      errors++;
    }
  }

  const elapsed = Date.now() - t0;
  console.log(
    `[precompile-extensions] Done in ${elapsed}ms: ` +
    `${compiled} compiled, ${skipped} skipped, ${errors} errors`,
  );

  if (errors > 0) {
    // Non-fatal — plugins will fall back to jiti runtime compilation
    console.warn('[precompile-extensions] Some plugins failed to compile. They will use jiti fallback.');
  }
}

main();
