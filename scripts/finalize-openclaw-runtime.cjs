'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const {
  DIST_CONTROL_UI_INDEX,
  DIST_DIFFS_EXTENSION_DIR,
  DIST_ENTRY_JS,
  DIST_ENTRY_MJS,
  DIST_EXTENSIONS_DIR,
  OPENCLAW_ENTRY,
  pruneBareDistAfterGatewayPack,
  pruneGatewayAsarStage,
  summarizeGatewayAsarEntries,
} = require('./openclaw-runtime-packaging.cjs');

const rootDir = path.resolve(__dirname, '..');
const runtimeRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(rootDir, 'vendor', 'openclaw-runtime', 'current');

function fail(message) {
  console.error(`[finalize-openclaw-runtime] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(runtimeRoot)) {
  fail(`Runtime root not found: ${runtimeRoot}`);
}

const openclawEntry = path.join(runtimeRoot, OPENCLAW_ENTRY);
const distDir = path.join(runtimeRoot, 'dist');
const gatewayAsarPath = path.join(runtimeRoot, 'gateway.asar');
const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');

if (!fs.existsSync(openclawEntry)) {
  fail(`Missing runtime entry before finalize: ${openclawEntry}`);
}
if (!fs.existsSync(path.join(runtimeRoot, DIST_CONTROL_UI_INDEX))) {
  fail(`Missing control UI before finalize: ${path.join(runtimeRoot, DIST_CONTROL_UI_INDEX)}`);
}
if (!fs.existsSync(path.join(runtimeRoot, DIST_ENTRY_JS)) && !fs.existsSync(path.join(runtimeRoot, DIST_ENTRY_MJS))) {
  fail(`Missing dist entry before finalize: ${path.join(runtimeRoot, DIST_ENTRY_JS)} or ${path.join(runtimeRoot, DIST_ENTRY_MJS)}`);
}
if (!fs.existsSync(bundlePath)) {
  fail(`Missing gateway bundle before finalize: ${bundlePath}`);
}

const requireFromRoot = createRequire(path.join(rootDir, 'package.json'));
const asar = requireFromRoot('@electron/asar');
const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-gateway-asar-'));
const stageRoot = path.join(stageDir, 'gateway');
const requiredSourceEntries = ['openclaw.mjs', 'dist'];

const listAsarEntries = () => {
  const summary = summarizeGatewayAsarEntries(asar.listPackage(gatewayAsarPath));

  if (!summary.hasOpenClawEntry || !summary.hasControlUiIndex || !summary.hasGatewayEntry || summary.hasBundledExtensions) {
    fail(
      `gateway.asar validation failed (openclaw.mjs=${summary.hasOpenClawEntry}, control-ui=${summary.hasControlUiIndex}, entry=${summary.hasGatewayEntry}, extensions=${summary.hasBundledExtensions})`,
    );
  }
};

(async () => {
  try {
    fs.mkdirSync(stageRoot, { recursive: true });
    for (const name of requiredSourceEntries) {
      const src = path.join(runtimeRoot, name);
      if (!fs.existsSync(src)) {
        fail(`Missing runtime entry before asar pack: ${src}`);
      }
      fs.cpSync(src, path.join(stageRoot, name), { recursive: true, force: true });
    }
    pruneGatewayAsarStage(stageRoot);

    fs.rmSync(gatewayAsarPath, { force: true });
    await asar.createPackageWithOptions(stageRoot, gatewayAsarPath, {});
    listAsarEntries();

    fs.rmSync(openclawEntry, { force: true });
    pruneBareDistAfterGatewayPack(runtimeRoot);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  if (!fs.existsSync(gatewayAsarPath)) {
    fail(`Expected gateway.asar to exist after finalize: ${gatewayAsarPath}`);
  }
  if (fs.existsSync(openclawEntry)) {
    fail(`Expected openclaw.mjs to be packed into gateway.asar, but unpacked file still exists: ${openclawEntry}`);
  }
  if (fs.existsSync(path.join(runtimeRoot, DIST_ENTRY_JS)) || fs.existsSync(path.join(runtimeRoot, DIST_ENTRY_MJS))) {
    fail('Expected dist/entry.* to be packed into gateway.asar, but unpacked entry files still exist.');
  }
  if (!fs.existsSync(path.join(runtimeRoot, DIST_CONTROL_UI_INDEX))) {
    fail('dist/control-ui/index.html is missing after finalize.');
  }
  if (!fs.existsSync(path.join(runtimeRoot, DIST_EXTENSIONS_DIR))) {
    fail('dist/extensions is missing after finalize.');
  }
  if (fs.existsSync(path.join(runtimeRoot, DIST_DIFFS_EXTENSION_DIR))) {
    fail('dist/extensions/diffs should be removed after finalize.');
  }

  console.log(`[finalize-openclaw-runtime] Finalized runtime at ${runtimeRoot}`);
})().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
