'use strict';

const fs = require('fs');
const path = require('path');

const DIST_DIR = 'dist';
const OPENCLAW_ENTRY = 'openclaw.mjs';
const DIST_CONTROL_UI_INDEX = path.join(DIST_DIR, 'control-ui', 'index.html');
const DIST_ENTRY_JS = path.join(DIST_DIR, 'entry.js');
const DIST_ENTRY_MJS = path.join(DIST_DIR, 'entry.mjs');
const DIST_EXTENSIONS_DIR = path.join(DIST_DIR, 'extensions');
const DIST_DIFFS_EXTENSION_DIR = path.join(DIST_EXTENSIONS_DIR, 'diffs');

const BARE_DIST_TOP_LEVEL_TO_KEEP = new Set(['control-ui', 'extensions']);

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
  summarizeGatewayAsarEntries,
};
