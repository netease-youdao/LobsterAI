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

const { pruneHostPeerLeftovers } = require('./openclaw-plugin-host-peer-leftovers.cjs');
const { ensureOpenClawPluginSdkBridge } = require('./openclaw-plugin-sdk-bridge.cjs');

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
  // Native debug symbols (node-pty ships 10 MB of them next to conpty.node)
  /\.pdb$/i,
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
  'xai', 'xiaomi',
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

// ─── Strategy 2b: Remove unused bundled skills ───
// OpenClaw loads every directory under <runtime>/skills as an "openclaw-bundled"
// skill and <runtime>/custodian-skills as "openclaw-custodian" skills. LobsterAI
// hides both from its skill manager, yet the gateway still:
//   - probes PATH for each skill's required binaries while building the model
//     runtime sidecar: one accessSync per PATH dir x PATHEXT entry, about 12,700
//     calls and 5 s of sync I/O at startup on Windows for the binaries that are
//     missing (macOS/overseas CLIs such as blu, codex, spotify_player);
//   - injects every eligible one into the agent prompt (clawhub, healthcheck,
//     notion, taskflow, spike, ... plus custodian skills that edit OpenClaw's
//     config and channels, which LobsterAI owns);
//   - lets bundled skills beat LobsterAI's own SKILLs of the same name
//     (skill-creator, weather), because bundled skills load after extraDirs.
// skills.allowBundled cannot fix the shadowing: collisions resolve before that
// filter runs, so a filtered-out bundled winner removes both copies. Removing
// the directories makes those skills absent instead.
//
// Allowlist approach: new skills from OpenClaw upgrades are pruned unless added
// here. Never add a name that LobsterAI ships in SKILLs/ (see the test).

const BUNDLED_SKILLS_TO_KEEP = new Set([
  'diagram-maker', // SVG / Excalidraw diagrams, no external binaries
]);

const BUNDLED_SKILLS_DIR = 'skills';
const CUSTODIAN_SKILLS_DIR = 'custodian-skills';

function shouldKeepBundledSkill(skillId) {
  return BUNDLED_SKILLS_TO_KEEP.has(skillId);
}

/**
 * Remove bundled skill directories outside BUNDLED_SKILLS_TO_KEEP and the whole
 * custodian skills directory. Loose files in skills/ (e.g. pyproject.toml) are
 * not skills and stay. Safe to run repeatedly.
 */
function pruneBundledSkills(runtimeRoot, stats) {
  const removed = [];
  const skillsDir = path.join(runtimeRoot, BUNDLED_SKILLS_DIR);
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || shouldKeepBundledSkill(entry.name)) continue;
      const fullPath = path.join(skillsDir, entry.name);
      stats.bytesFreed += getDirSize(fullPath);
      fs.rmSync(fullPath, { recursive: true, force: true });
      stats.dirsRemoved++;
      removed.push(entry.name);
    }
  }
  const custodianDir = path.join(runtimeRoot, CUSTODIAN_SKILLS_DIR);
  if (fs.existsSync(custodianDir)) {
    stats.bytesFreed += getDirSize(custodianDir);
    fs.rmSync(custodianDir, { recursive: true, force: true });
    stats.dirsRemoved++;
    removed.push(CUSTODIAN_SKILLS_DIR);
  }
  return removed;
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

// koffi backs OpenClaw's native Windows private-directory helper
// (scripts/patches/<version>/openclaw-windows-private-directory-native.patch),
// which replaced the PowerShell + Add-Type spawn that security software blocks.
// Windows runtimes keep the real package and its @koromix/koffi-win32-* binary;
// every other target still ships the stub.
const KOFFI_PACKAGE = 'koffi';
const WINDOWS_RUNTIME_TARGET_PREFIX = 'win-';
// Build-only koffi content that its runtime loader never reads.
const KOFFI_BUILD_ONLY_PATHS = ['doc', 'vendor', 'CHANGELOG.md', 'cnoke.cjs'];

// tsc --locale message catalogs; the compiler API never loads them.
const TYPESCRIPT_DIAGNOSTIC_LOCALES = ['cs', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pl', 'pt-br', 'ru', 'tr', 'zh-cn', 'zh-tw'];

// Paths under node_modules that the gateway never loads.
const RUNTIME_UNUSED_PATHS = [
  // OpenClaw loads only tree-sitter-bash.wasm (via web-tree-sitter); the
  // grammar C sources and per-platform native prebuilds are dead weight.
  'tree-sitter-bash/src',
  'tree-sitter-bash/prebuilds',
  // Type-only packages with no runtime code.
  '@cloudflare/workers-types',
  'bun-types',
  // OpenClaw uses the compiler API (lib/typescript.js) for createSourceFile
  // and transpileModule. The tsc CLI bundle is only reached through bin/tsc,
  // which the Windows payload never exposes (node_modules/.bin is excluded).
  'typescript/lib/_tsc.js',
  ...TYPESCRIPT_DIAGNOSTIC_LOCALES.map(locale => `typescript/lib/${locale}`),
];

function readRuntimeTarget(runtimeRoot) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'runtime-build-info.json'), 'utf8'));
    return typeof info.target === 'string' ? info.target : '';
  } catch {
    return '';
  }
}

function isWindowsRuntimeTarget(target) {
  return typeof target === 'string' && target.startsWith(WINDOWS_RUNTIME_TARGET_PREFIX);
}

function resolvePackagesToStub(target) {
  return PACKAGES_TO_STUB.filter(pkgName => !(pkgName === KOFFI_PACKAGE && isWindowsRuntimeTarget(target)));
}

function getPathSize(target) {
  try {
    const stat = fs.statSync(target);
    return stat.isDirectory() ? getDirSize(target) : stat.size;
  } catch {
    return 0;
  }
}

function trimKoffiBuildFiles(nodeModulesDir, stats) {
  const koffiDir = path.join(nodeModulesDir, KOFFI_PACKAGE);
  if (!fs.existsSync(koffiDir)) return [];
  const removed = [];
  for (const relative of KOFFI_BUILD_ONLY_PATHS) {
    const target = path.join(koffiDir, relative);
    if (!fs.existsSync(target)) continue;
    const size = getPathSize(target);
    const isDirectory = fs.statSync(target).isDirectory();
    fs.rmSync(target, { recursive: true, force: true });
    stats.bytesFreed += size;
    if (isDirectory) stats.dirsRemoved++; else stats.filesRemoved++;
    removed.push(relative);
  }
  return removed;
}

function removeRuntimeUnusedPaths(nodeModulesDir, stats) {
  const removed = [];
  for (const relative of RUNTIME_UNUSED_PATHS) {
    const target = path.join(nodeModulesDir, relative);
    if (!fs.existsSync(target)) continue;
    const isDirectory = fs.statSync(target).isDirectory();
    stats.bytesFreed += getPathSize(target);
    fs.rmSync(target, { recursive: true, force: true });
    if (isDirectory) stats.dirsRemoved++; else stats.filesRemoved++;
    removed.push(relative);
  }
  return removed;
}

// Only the bundled feishu extension imports the root copy of the Lark SDK
// (install-openclaw-channel-deps.cjs put it there for that extension's dist
// chunks). openclaw-lark ships its own copy under its node_modules.
const LARK_SDK_PACKAGE = '@larksuiteoapi/node-sdk';

/**
 * Prefer external openclaw-lark over the bundled feishu extension when both
 * are present, then drop the root Lark SDK that only feishu loaded. Keep the
 * current runtime-code path intact; this trims packaging/runtime output only.
 */
function preferExternalLark(runtimeRoot, stats) {
  const removed = [];
  if (!fs.existsSync(path.join(runtimeRoot, 'third-party-extensions', 'openclaw-lark'))) return removed;
  const bundledFeishuDir = path.join(runtimeRoot, 'dist', 'extensions', 'feishu');
  const rootLarkSdkDir = path.join(runtimeRoot, 'node_modules', LARK_SDK_PACKAGE);
  for (const [label, target] of [['bundled feishu', bundledFeishuDir], [`root ${LARK_SDK_PACKAGE}`, rootLarkSdkDir]]) {
    if (!fs.existsSync(target)) continue;
    const size = getDirSize(target);
    fs.rmSync(target, { recursive: true, force: true });
    stats.bytesFreed += size;
    stats.dirsRemoved++;
    removed.push(label);
    console.log(
      `[prune-openclaw-runtime] Removed ${label} because openclaw-lark is present (${(size / 1024 / 1024).toFixed(1)} MB)`
    );
  }
  const scopeDir = path.dirname(rootLarkSdkDir);
  if (fs.existsSync(scopeDir) && fs.readdirSync(scopeDir).length === 0) fs.rmdirSync(scopeDir);
  return removed;
}

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

  // Step 1-skills: Keep only allowlisted bundled skills; drop custodian skills.
  try {
    const skillsPruned = pruneBundledSkills(runtimeRoot, stats);
    if (skillsPruned.length > 0) {
      console.log(
        `[prune-openclaw-runtime] Pruned ${skillsPruned.length} bundled skill dir(s); kept: ${[...BUNDLED_SKILLS_TO_KEEP].join(', ')}`
      );
    }
  } catch (err) {
    console.warn(`[prune-openclaw-runtime] Failed to prune bundled skills: ${err.message}`);
  }

  // Step 1a: Prefer external openclaw-lark over bundled feishu and its root SDK.
  preferExternalLark(runtimeRoot, stats);

  // Step 1b: Remove stale external qqbot payloads from older builds.
  const thirdPartyDir = path.join(runtimeRoot, 'third-party-extensions');
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

  // Step 2: Replace large unnecessary packages with stubs. Windows runtimes
  // keep koffi for the native private-directory helper.
  const runtimeTarget = readRuntimeTarget(runtimeRoot);
  const packagesToStub = resolvePackagesToStub(runtimeTarget);
  if (!packagesToStub.includes(KOFFI_PACKAGE)) {
    const trimmed = trimKoffiBuildFiles(nodeModulesDir, stats);
    console.log(
      `[prune-openclaw-runtime] Keeping ${KOFFI_PACKAGE} for ${runtimeTarget}: native Windows private-directory helper` +
        (trimmed.length > 0 ? ` (trimmed ${trimmed.join(', ')})` : '')
    );
  }
  for (const pkgName of packagesToStub) {
    stubPackage(path.join(nodeModulesDir, pkgName), pkgName, stats);
  }

  // Step 2a: Remove orphaned platform-specific binaries for stubbed packages.
  // When a package like @tloncorp/tlon-skill is stubbed, its optionalDependencies
  // (e.g. @tloncorp/tlon-skill-darwin-x64) remain as orphaned siblings.
  for (const pkgName of packagesToStub) {
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
  // Plugins that declare openclaw as a required peerDependency get it
  // auto-installed by npm v7+ into their own node_modules, together with its
  // whole dependency tree (openclaw@2026.8.x pulls a 300+ MB claude-agent-sdk
  // binary). The install script now marks that peer optional, but caches
  // created before that fix still carry the tree, and openclaw >= 2026.8
  // hoists it next to the plugin's real dependencies. At runtime the host
  // gateway provides the SDK, so everything only reachable through it goes.
  if (fs.existsSync(thirdPartyDir)) {
    try {
      for (const plugin of fs.readdirSync(thirdPartyDir, { withFileTypes: true })) {
        if (!plugin.isDirectory()) continue;
        const pruned = pruneHostPeerLeftovers(path.join(thirdPartyDir, plugin.name));
        if (pruned.removed.length === 0) continue;
        stats.bytesFreed += pruned.bytesFreed;
        stats.dirsRemoved += pruned.removed.length;
        console.log(
          `[prune-openclaw-runtime] Removed ${pruned.removed.length} openclaw peer leftover package(s) from ${plugin.name} (${(pruned.bytesFreed / 1024 / 1024).toFixed(1)} MB)`
        );
      }
    } catch (err) {
      console.warn(`[prune-openclaw-runtime] Failed to prune openclaw peer leftovers from third-party-extensions: ${err.message}`);
    }
  }

  // Step 2d: Remove package content the gateway never loads
  const unusedRemoved = removeRuntimeUnusedPaths(nodeModulesDir, stats);
  if (unusedRemoved.length > 0) {
    console.log(`[prune-openclaw-runtime] Removed unused runtime paths: ${unusedRemoved.join(', ')}`);
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

  // Plugins still need native Node SDK resolution after their private host
  // copies/links are removed, including imports made later by doctor hooks.
  const sdkBridge = ensureOpenClawPluginSdkBridge(runtimeRoot);
  console.log(
    `[prune-openclaw-runtime] SDK bridge: ${sdkBridge.exportCount} exports, ${sdkBridge.bytes} bytes, changed=${sdkBridge.changed}`
  );

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
  BUNDLED_SKILLS_TO_KEEP,
  KOFFI_BUILD_ONLY_PATHS,
  KOFFI_PACKAGE,
  LARK_SDK_PACKAGE,
  PACKAGES_TO_STUB,
  RUNTIME_UNUSED_PATHS,
  isWindowsRuntimeTarget,
  preferExternalLark,
  pruneBundledSkills,
  readRuntimeTarget,
  removeRuntimeUnusedPaths,
  resolvePackagesToStub,
  shouldDeleteFile,
  shouldKeepBundledExtension,
  shouldKeepBundledSkill,
  trimKoffiBuildFiles,
};

if (require.main === module) {
  main();
}
