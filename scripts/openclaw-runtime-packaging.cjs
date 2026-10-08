'use strict';

const fs = require('fs');
const path = require('path');

const DIST_DIR = 'dist';
const OPENCLAW_ENTRY = 'openclaw.mjs';
const DIST_CONTROL_UI_INDEX = path.join(DIST_DIR, 'control-ui', 'index.html');
const DIST_ENTRY_JS = path.join(DIST_DIR, 'entry.js');
const DIST_ENTRY_MJS = path.join(DIST_DIR, 'entry.mjs');
const DIST_EXTENSIONS_DIR = path.join(DIST_DIR, 'extensions');
const THIRD_PARTY_EXTENSIONS_DIR = 'third-party-extensions';
const DIST_DIFFS_EXTENSION_DIR = path.join(DIST_EXTENSIONS_DIR, 'diffs');

const BARE_DIST_TOP_LEVEL_TO_KEEP = new Set(['control-ui', 'extensions']);

// Only explicitly reviewed official packages may use OpenClaw's trusted bundled
// root. Other preinstalls remain config-origin plugins in third-party-extensions.
function resolvePreinstalledPluginDir(runtimeRoot, plugin) {
  if (typeof plugin.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(plugin.id)) {
    throw new Error('Invalid preinstalled OpenClaw plugin directory id');
  }
  if (plugin.runtimeBundled === true && plugin.npm !== `@openclaw/${plugin.id}`) {
    throw new Error(`Runtime-bundled plugin ${plugin.id} must use its official @openclaw package`);
  }
  return path.join(runtimeRoot,
    plugin.runtimeBundled === true ? DIST_EXTENSIONS_DIR : THIRD_PARTY_EXTENSIONS_DIR,
    plugin.id);
}

function verifyRuntimeBundledPlugin(runtimeRoot, plugin) {
  if (plugin.runtimeBundled !== true) return;
  const pluginDir = resolvePreinstalledPluginDir(runtimeRoot, plugin);
  const bundledRoot = path.join(fs.realpathSync(runtimeRoot), DIST_EXTENSIONS_DIR);
  const relative = path.relative(bundledRoot, fs.realpathSync(pluginDir));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Runtime-bundled plugin ${plugin.id} must be inside ${bundledRoot}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'openclaw.plugin.json'), 'utf8'));
  if (pkg.name !== plugin.npm || pkg.version !== plugin.version || manifest.id !== plugin.id) {
    throw new Error(`Runtime-bundled plugin ${plugin.id} does not match the pinned official package`);
  }
  const entries = pkg.openclaw?.runtimeExtensions;
  if (!Array.isArray(entries) || entries.length === 0 || entries.some(entry => {
    if (typeof entry !== 'string' || !/\.(?:mjs|cjs|js)$/.test(entry)) return true;
    const relativeEntry = path.relative(pluginDir, path.resolve(pluginDir, entry));
    return relativeEntry.startsWith('..') || path.isAbsolute(relativeEntry)
      || !fs.existsSync(path.join(pluginDir, entry));
  })) {
    throw new Error(`Runtime-bundled plugin ${plugin.id} is missing its compiled runtime entry`);
  }
  // Config paths are scanned first; a stale copy would shadow the trusted one.
  if (fs.existsSync(path.join(runtimeRoot, THIRD_PARTY_EXTENSIONS_DIR, plugin.id))) {
    throw new Error(`Stale config-origin copy of runtime-bundled plugin ${plugin.id}; rebuild OpenClaw plugins`);
  }
}

function normalizeAsarEntry(entry) {
  return entry.replace(/\\/g, '/');
}

function summarizeGatewayAsarEntries(entries) {
  const normalizedEntries = Array.from(entries, normalizeAsarEntry);
  const entrySet = new Set(normalizedEntries);

  return {
    hasOpenClawEntry: entrySet.has(`/${OPENCLAW_ENTRY}`),
    hasControlUiIndex: entrySet.has(`/${DIST_CONTROL_UI_INDEX.replace(/\\/g, '/')}`),
    hasGatewayEntry: entrySet.has(`/${DIST_ENTRY_JS.replace(/\\/g, '/')}`)
      || entrySet.has(`/${DIST_ENTRY_MJS.replace(/\\/g, '/')}`),
    hasBundledExtensions: normalizedEntries.some((entry) => entry === '/dist/extensions' || entry.startsWith('/dist/extensions/')),
  };
}

function pruneGatewayAsarStage(stageRoot) {
  const extensionsDir = path.join(stageRoot, DIST_EXTENSIONS_DIR);
  if (fs.existsSync(extensionsDir)) {
    fs.rmSync(extensionsDir, { recursive: true, force: true });
  }
}

function pruneBareDistAfterGatewayPack(runtimeRoot) {
  const distDir = path.join(runtimeRoot, DIST_DIR);
  if (!fs.existsSync(distDir)) {
    return;
  }

  for (const entry of fs.readdirSync(distDir)) {
    if (BARE_DIST_TOP_LEVEL_TO_KEEP.has(entry)) {
      continue;
    }
    fs.rmSync(path.join(distDir, entry), { recursive: true, force: true });
  }

  const diffsExtensionDir = path.join(runtimeRoot, DIST_DIFFS_EXTENSION_DIR);
  if (fs.existsSync(diffsExtensionDir)) {
    fs.rmSync(diffsExtensionDir, { recursive: true, force: true });
  }
}

module.exports = {
  DIST_CONTROL_UI_INDEX,
  DIST_DIFFS_EXTENSION_DIR,
  DIST_ENTRY_JS,
  DIST_ENTRY_MJS,
  DIST_EXTENSIONS_DIR,
  OPENCLAW_ENTRY,
  pruneBareDistAfterGatewayPack,
  pruneGatewayAsarStage,
  resolvePreinstalledPluginDir,
  summarizeGatewayAsarEntries,
  verifyRuntimeBundledPlugin,
};
