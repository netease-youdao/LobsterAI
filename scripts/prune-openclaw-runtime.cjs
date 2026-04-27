'use strict';

/**
 * Clean up unnecessary files from the OpenClaw runtime to reduce package size.
 *
 * Two strategies:
 * 1. Remove unnecessary files (.map, .d.ts, README, etc.) from all packages
 * 2. Replace large packages not needed at runtime with lightweight stubs
 *    (same approach as AutoClaw — import succeeds, actual calls throw in existing try-catch)
 */

const fs = require('fs');
const path = require('path');

// ─── Strategy 1: File cleanup patterns ───

const PATTERNS_TO_DELETE = [
  // Source maps
  /\.map$/i,
  // TypeScript declarations
  /\.d\.ts$/i,
  /\.d\.cts$/i,
  /\.d\.mts$/i,
  // Documentation files
  /^readme(\.(md|txt|rst))?$/i,
  /^changelog(\.(md|txt|rst))?$/i,
  /^history(\.(md|txt|rst))?$/i,
  /^license(\.(md|txt))?$/i,
  /^licence(\.(md|txt))?$/i,
  /^authors(\.(md|txt))?$/i,
  /^contributors(\.(md|txt))?$/i,
  // Config files not needed at runtime
  /^\.eslintrc/i,
  /^\.prettierrc/i,
  /^\.editorconfig$/i,
  /^\.npmignore$/i,
  /^\.gitignore$/i,
  /^\.gitattributes$/i,
  /^tsconfig(\..+)?\.json$/i,
  /^jest\.config/i,
  /^vitest\.config/i,
  /^\.babelrc/i,
  /^babel\.config/i,
  // Test files
  /\.test\.\w+$/i,
  /\.spec\.\w+$/i,
];

const DIRS_TO_DELETE = new Set([
  'test',
  'tests',
  '__tests__',
  '__mocks__',
  '.github',
  'example',
  'examples',
  'coverage',
]);

// ─── Strategy 2: Remove unused bundled extensions ───
// OpenClaw's plugin discovery scans every directory under dist/extensions/,
// calling realpathSync + readPackageManifest even for plugins later blocked by
// plugins.deny.  On Windows NTFS this costs ~30s of synchronous I/O at startup.
// Physically removing the directories is the only way to skip the scan.
//
// Allowlist approach: new extensions from OpenClaw upgrades are automatically
// pruned unless explicitly added here.

const BUNDLED_EXTENSIONS_TO_KEEP = new Set([
  // --- Providers (LobsterAI may route to these) ---
  'anthropic', 'deepseek', 'google', 'kimi-coding', 'minimax', 'moonshot',
  'ollama', 'openai', 'openrouter', 'qianfan', 'qwen', 'stepfun', 'volcengine',
  // --- Channels (managed via entries or third-party replacements) ---
  'telegram', 'discord', 'feishu', 'qqbot',
  // --- Core features ---
  'browser', 'memory-core', 'lobster', 'llm-task', 'zai',
  // --- Media / voice (bundled defaults, may be used by agents) ---
  'image-generation-core', 'media-understanding-core', 'speech-core', 'talk-voice',
  // --- Internal ---
  'acpx', 'thread-ownership', 'memory-lancedb', 'memory-wiki',
]);

function shouldKeepBundledExtension(extensionId) {
  return BUNDLED_EXTENSIONS_TO_KEEP.has(extensionId);
}

// ─── Strategy 3: Stub replacements ───
// Packages not needed in headless gateway mode, replaced with lightweight stubs.
// The stub allows require/import to succeed but throws when actually called.
// Callers already have try-catch protection.

const PACKAGES_TO_STUB = [
  'koffi',                  // Windows FFI for terminal PTY — not needed in gateway mode
  '@tloncorp/tlon-skill',   // Tlon channel pruned from dist/extensions; native binary not needed
  '@lancedb',
  '@jimp',
  '@napi-rs',
  'pdfjs-dist',
  '@matrix-org',
  // NOTE: @img is intentionally NOT stubbed — it contains platform-specific sharp
  // native bindings (e.g. @img/sharp-win32-x64) required by openclaw's image-ops
  // module and by exec-tool scripts that use require('sharp').
];

const GENERIC_STUB_INDEX_CJS = `// Stub (CJS): this package is not needed for headless gateway operation.
module.exports = new Proxy({}, {
  get(_, prop) {
    if (prop === '__esModule') return false;
    if (prop === 'default') return module.exports;
    if (prop === 'then') return undefined;
    return function() {
      throw new Error(require('./package.json').name + ' is not available in this build');
    };
  }
});
`;

const GENERIC_STUB_INDEX_ESM = `// Stub (ESM): this package is not needed for headless gateway operation.
const handler = {
  get(_, prop) {
    if (prop === 'then') return undefined;
    return function() {
      throw new Error('This package is not available in this build (stub)');
    };
  }
};
const stub = new Proxy({}, handler);
export default stub;
export const chromium = stub;
export const devices = stub;
export const firefox = stub;
export const webkit = stub;
export const getDocument = stub;
export const version = '0.0.0-stub';
`;

function stubPackage(pkgDir, pkgName, stats) {
  if (!fs.existsSync(pkgDir)) return;

  // Read original version for the stub package.json
  let version = '0.0.0-stub';
  try {
    const origPkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    version = origPkg.version || version;
  } catch { /* ignore */ }

  // Remove all contents
  fs.rmSync(pkgDir, { recursive: true, force: true });
  fs.mkdirSync(pkgDir, { recursive: true });

  // Write dual CJS + ESM stub files
  fs.writeFileSync(path.join(pkgDir, 'index.js'), GENERIC_STUB_INDEX_CJS, 'utf8');
  fs.writeFileSync(path.join(pkgDir, 'index.mjs'), GENERIC_STUB_INDEX_ESM, 'utf8');
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: pkgName,
    version,
    main: 'index.js',
    exports: {
      '.': {
        import: './index.mjs',
        require: './index.js',
        default: './index.js',
      },
    },
  }, null, 2) + '\n', 'utf8');

  stats.stubbed.push(pkgName);
}

// ─── File cleanup ───

function shouldDeleteFile(filename) {
  return PATTERNS_TO_DELETE.some((pattern) => pattern.test(filename));
}

function cleanDir(dirPath, stats) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (DIRS_TO_DELETE.has(entry.name.toLowerCase())) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        stats.dirsRemoved++;
        continue;
      }
      cleanDir(fullPath, stats);
      // Remove empty directories
      try {
        const remaining = fs.readdirSync(fullPath);
        if (remaining.length === 0) {
          fs.rmdirSync(fullPath);
        }
      } catch { /* ignore */ }
    } else if (entry.isFile() && shouldDeleteFile(entry.name)) {
      try {
        const size = fs.statSync(fullPath).size;
        fs.unlinkSync(fullPath);
        stats.filesRemoved++;
        stats.bytesFreed += size;
      } catch { /* ignore */ }
    }
  }
}

// ─── Helpers ───

function getDirSize(dirPath) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += getDirSize(fullPath);
      } else {
        try { total += fs.statSync(fullPath).size; } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return total;
}

// ─── Main ───

function main() {
  const runtimeRoot = process.argv[2]
    || path.join(__dirname, '..', 'vendor', 'openclaw-runtime', 'current');

  if (!fs.existsSync(runtimeRoot)) {
    console.error(`[prune-openclaw-runtime] Runtime root not found: ${runtimeRoot}`);
    process.exit(1);
  }

  const nodeModulesDir = path.join(runtimeRoot, 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    console.log('[prune-openclaw-runtime] No node_modules found, skipping.');
    return;
  }

  console.log(`[prune-openclaw-runtime] Cleaning ${runtimeRoot} ...`);

  const stats = { filesRemoved: 0, dirsRemoved: 0, bytesFreed: 0, stubbed: [], extensionsPruned: [] };

  // Step 1: Remove unused bundled extensions from dist/extensions/
  const distExtDir = path.join(runtimeRoot, 'dist', 'extensions');
  if (fs.existsSync(distExtDir)) {
    try {
      for (const entry of fs.readdirSync(distExtDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (shouldKeepBundledExtension(entry.name)) continue;
        const fullPath = path.join(distExtDir, entry.name);
        fs.rmSync(fullPath, { recursive: true, force: true });
        stats.extensionsPruned.push(entry.name);
      }
    } catch (err) {
      console.warn(`[prune-openclaw-runtime] Failed to prune dist/extensions: ${err.message}`);
    }
  }

  // Step 1a: Prefer external openclaw-lark over bundled feishu when both are
  // present. Keep the current runtime-code path intact and trim the duplicate
  // bundled feishu extension only for packaging/runtime output.
  const thirdPartyDir = path.join(runtimeRoot, 'third-party-extensions');
  const externalLarkDir = path.join(thirdPartyDir, 'openclaw-lark');
  const bundledFeishuDir = path.join(distExtDir, 'feishu');
  if (fs.existsSync(externalLarkDir) && fs.existsSync(bundledFeishuDir)) {
    const size = getDirSize(bundledFeishuDir);
    fs.rmSync(bundledFeishuDir, { recursive: true, force: true });
    stats.bytesFreed += size;
    stats.dirsRemoved++;
    console.log(
      `[prune-openclaw-runtime] Removed bundled feishu because openclaw-lark is present (${(size / 1024 / 1024).toFixed(1)} MB)`
    );
  }

  // Step 1b: Remove stale external qqbot payloads from older builds.
  const staleExternalQqbotDir = path.join(thirdPartyDir, 'openclaw-qqbot');
  if (fs.existsSync(staleExternalQqbotDir)) {
    const size = getDirSize(staleExternalQqbotDir);
    fs.rmSync(staleExternalQqbotDir, { recursive: true, force: true });
    stats.bytesFreed += size;
    stats.dirsRemoved++;
    console.log(
      `[prune-openclaw-runtime] Removed stale external openclaw-qqbot (${(size / 1024 / 1024).toFixed(1)} MB)`
    );
  }

  // Step 2: Replace large unnecessary packages with stubs
  for (const pkgName of PACKAGES_TO_STUB) {
    stubPackage(path.join(nodeModulesDir, pkgName), pkgName, stats);
  }

  // Step 2a: Remove orphaned platform-specific binaries for stubbed packages.
  // When a package like @tloncorp/tlon-skill is stubbed, its optionalDependencies
  // (e.g. @tloncorp/tlon-skill-darwin-x64) remain as orphaned siblings.
  for (const pkgName of PACKAGES_TO_STUB) {
    if (!pkgName.startsWith('@')) continue;
    const [scope, base] = pkgName.split('/');
    const scopeDir = path.join(nodeModulesDir, scope);
    if (!fs.existsSync(scopeDir)) continue;
    for (const entry of fs.readdirSync(scopeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === base) continue;
      if (!entry.name.startsWith(base + '-')) continue;
      const variantDir = path.join(scopeDir, entry.name);
      const size = getDirSize(variantDir);
      fs.rmSync(variantDir, { recursive: true, force: true });
      stats.bytesFreed += size;
      stats.dirsRemoved++;
      console.log(
        `[prune-openclaw-runtime] Removed orphaned platform binary ${scope}/${entry.name} (${(size / 1024 / 1024).toFixed(1)} MB)`
      );
    }
  }

  // Step 2b: Remove broken .bin symlinks left behind by stubbed packages
  const binDir = path.join(nodeModulesDir, '.bin');
  if (fs.existsSync(binDir)) {
    try {
      for (const entry of fs.readdirSync(binDir)) {
        const linkPath = path.join(binDir, entry);
        try {
          fs.statSync(linkPath); // follows symlink — throws if target is missing
        } catch {
          fs.unlinkSync(linkPath);
          stats.filesRemoved++;
        }
      }
    } catch { /* ignore */ }
  }

  // Step 2c: Remove openclaw SDK duplicates from third-party-extensions.
  // Plugins like openclaw-qqbot declare openclaw as a peerDependency, and
  // npm v7+ auto-installs it into the plugin's own node_modules (~226 MB).
  // At runtime the host gateway already provides the SDK on the module path,
  // so this copy is redundant and safe to remove.
  if (fs.existsSync(thirdPartyDir)) {
    try {
      for (const plugin of fs.readdirSync(thirdPartyDir, { withFileTypes: true })) {
        if (!plugin.isDirectory()) continue;
        const dupeOC = path.join(thirdPartyDir, plugin.name, 'node_modules', 'openclaw');
        if (fs.existsSync(dupeOC)) {
          const size = getDirSize(dupeOC);
          fs.rmSync(dupeOC, { recursive: true, force: true });
          stats.bytesFreed += size;
          stats.dirsRemoved++;
          console.log(
            `[prune-openclaw-runtime] Removed duplicate openclaw SDK from ${plugin.name} (${(size / 1024 / 1024).toFixed(1)} MB)`
          );
        }
      }
    } catch (err) {
      console.warn(`[prune-openclaw-runtime] Failed to prune openclaw from third-party-extensions: ${err.message}`);
    }
  }

  // Step 3: Clean unnecessary files from node_modules only
  cleanDir(nodeModulesDir, stats);

  // Step 4: Clean node_modules inside extensions (but not extension source files)
  const extensionsDir = path.join(runtimeRoot, 'extensions');
  if (fs.existsSync(extensionsDir)) {
    try {
      for (const ext of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
        if (!ext.isDirectory()) continue;
        const extNodeModules = path.join(extensionsDir, ext.name, 'node_modules');
        if (fs.existsSync(extNodeModules)) {
          cleanDir(extNodeModules, stats);
        }
      }
    } catch { /* ignore */ }
  }

  const mbFreed = (stats.bytesFreed / 1024 / 1024).toFixed(1);
  if (stats.extensionsPruned.length > 0) {
    console.log(
      `[prune-openclaw-runtime] Pruned ${stats.extensionsPruned.length} unused bundled extensions`
    );
  }
  console.log(
    `[prune-openclaw-runtime] Stubbed: ${stats.stubbed.length > 0 ? stats.stubbed.join(', ') : 'none'}`
  );
  console.log(
    `[prune-openclaw-runtime] Removed ${stats.filesRemoved} files, ${stats.dirsRemoved} dirs, freed ${mbFreed} MB`
  );
}

module.exports = {
  BUNDLED_EXTENSIONS_TO_KEEP,
  shouldKeepBundledExtension,
};

if (require.main === module) {
  main();
}
