'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const asar = require('@electron/asar');
const { OPENCLAW_BUNDLE_ASSET_TARGETS } = require('./openclaw-bundle-assets.cjs');
const { verifyOpenClawPluginSdkBridge } = require('./openclaw-plugin-sdk-bridge.cjs');

const REVIEWED_OPENCLAW_VERSION = '2026.8.1';
const REVIEWED_CLAUDE_SDK_VERSION = '0.3.239';
const WINDOWS_X64_TARGET = 'win-x64';
const FS_SAFE_TARGET = 'win32-x64-msvc';
const FS_SAFE_ROOTS = ['dist/native', 'node_modules/@openclaw/fs-safe/dist/native'];
const CLAUDE_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
const CUA_DRIVER_PACKAGE = '@trycua/cua-driver';
const KOFFI_STUB_COMMENT = 'this package is not needed for headless gateway operation.';
const CONTROL_UI_MANIFEST = 'dist/control-ui/asset-manifest.json';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function requireFile(root, relative) {
  if (!isFile(path.join(root, relative))) {
    throw new Error(`[openclaw-windows-payload] Missing bare runtime file: ${relative}. Rebuild the runtime before packaging.`);
  }
}

/** Verify the fallback archive really is redundant before omitting it. */
function verifyBareRuntime(root) {
  for (const relative of [
    'openclaw.mjs', 'gateway-bundle.mjs', 'dist/control-ui/index.html',
    'dist/worker/worker.mjs', ...OPENCLAW_BUNDLE_ASSET_TARGETS.map(asset => asset.targetFile),
  ]) requireFile(root, relative);
  if (!['dist/entry.js', 'dist/entry.mjs'].some(relative => isFile(path.join(root, relative)))) {
    throw new Error('[openclaw-windows-payload] Missing bare dist/entry.js or dist/entry.mjs. Rebuild the runtime.');
  }
  verifyOpenClawPluginSdkBridge(root);

  const archive = path.join(root, 'gateway.asar');
  if (!fs.existsSync(archive)) return;
  for (const entry of asar.listPackage(archive)) {
    const archiveEntry = entry.replace(/^[/\\]+/, '');
    const relative = archiveEntry.replace(/\\/g, '/');
    const metadata = asar.statFile(archive, archiveEntry);
    if (metadata.files || /(?:\.d\.(?:ts|cts|mts)|\.map)$/i.test(relative)) continue;
    requireFile(root, relative);
    const bare = fs.readFileSync(path.join(root, relative));
    // ASAR's integrity header avoids reading the archive body a second time.
    const matches = metadata.integrity?.algorithm === 'SHA256'
      ? bare.length === metadata.size && createHash('sha256').update(bare).digest('hex') === metadata.integrity.hash
      : bare.equals(asar.extractFile(archive, archiveEntry));
    if (!matches) {
      throw new Error(`[openclaw-windows-payload] Bare runtime differs from gateway.asar: ${relative}. Rebuild the runtime.`);
    }
  }
}

function optionalNativePackages(root, name) {
  const manifestPath = path.join(root, 'node_modules', name, 'package.json');
  if (!isFile(manifestPath)) return { manifest: null, packages: [] };
  const manifest = readJson(manifestPath);
  return {
    manifest,
    packages: Object.keys(manifest.optionalDependencies || {})
      .filter(dependency => dependency.startsWith(`${name}-`))
      .map(dependency => `node_modules/${dependency}`),
  };
}

function hashAssetEntries(assets) {
  const hash = createHash('sha256');
  for (const asset of assets) {
    // OpenClaw src/gateway/control-ui-asset-manifest.ts (manifest version 1).
    hash.update(`${asset.path}\0${asset.size}\0${asset.sha256}\n`);
  }
  return hash.digest('hex');
}

function buildControlUiManifest(root, filter) {
  requireFile(root, CONTROL_UI_MANIFEST);
  const manifest = readJson(path.join(root, CONTROL_UI_MANIFEST));
  if (manifest.version !== 1 || !Array.isArray(manifest.assets) || !manifest.assets.length) {
    throw new Error('[openclaw-windows-payload] Unsupported Control UI asset manifest. Review the payload policy.');
  }
  const paths = new Set();
  for (const asset of manifest.assets) {
    if (typeof asset.path !== 'string' || !asset.path.startsWith('assets/')
      || asset.path.includes('\\') || asset.path.includes('\0')
      || asset.path !== path.posix.normalize(asset.path) || asset.path.endsWith('/')
      || paths.has(asset.path) || !Number.isSafeInteger(asset.size) || asset.size < 0
      || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
      throw new Error('[openclaw-windows-payload] Invalid Control UI asset manifest entry. Rebuild the runtime.');
    }
    paths.add(asset.path);
  }
  if (hashAssetEntries(manifest.assets) !== manifest.generation) {
    throw new Error('[openclaw-windows-payload] Stale Control UI asset manifest generation. Rebuild the runtime.');
  }
  const assets = manifest.assets.filter(asset => filter(`dist/control-ui/${asset.path}`));
  if (!assets.length) throw new Error('[openclaw-windows-payload] Control UI asset inventory would be empty.');
  // Retention validates every listed file and the generation digest. Its
  // inventory must describe the shipped assets, including identity fallback.
  return JSON.stringify({ ...manifest, assets, generation: hashAssetEntries(assets) }) + '\n';
}

/**
 * Only adjusts distribution output: gateway.asar and native packages must remain
 * in vendor, where they are also used by the runtime build cache. The reviewed
 * contract is deliberately scoped to Windows x64 and these pinned versions;
 * upgrades retain unreviewed payloads until their runtime behavior is checked.
 */
function createOpenClawWindowsPayload(runtimeRoot, targetId) {
  if (targetId !== WINDOWS_X64_TARGET) return { filter: () => true };
  const root = fs.realpathSync(runtimeRoot);
  const buildInfo = readJson(path.join(root, 'runtime-build-info.json'));
  if (buildInfo.target !== targetId) {
    throw new Error(`[openclaw-windows-payload] Runtime target ${buildInfo.target} does not match packaging target ${targetId}.`);
  }
  const host = readJson(path.join(root, 'package.json'));
  if (host.name !== 'openclaw' || host.version !== REVIEWED_OPENCLAW_VERSION) {
    console.warn(`[openclaw-windows-payload] Keeping unreviewed OpenClaw ${host.version} payload. Review the Windows exclusions after upgrading.`);
    return { filter: () => true };
  }

  verifyBareRuntime(root);
  const excluded = new Set(['gateway.asar']);
  for (const nativeRoot of FS_SAFE_ROOTS) {
    requireFile(root, `${nativeRoot}/${FS_SAFE_TARGET}/fs-safe-native.node`);
    for (const item of fs.readdirSync(path.join(root, nativeRoot), { withFileTypes: true })) {
      if (item.isDirectory() && item.name !== FS_SAFE_TARGET && /^(?:darwin|linux|win32)-/.test(item.name)) {
        excluded.add(`${nativeRoot}/${item.name}`);
      }
    }
  }

  const sdk = optionalNativePackages(root, CLAUDE_SDK_PACKAGE);
  if (sdk.manifest?.name === CLAUDE_SDK_PACKAGE && sdk.manifest.version === REVIEWED_CLAUDE_SDK_VERSION) {
    // OpenClaw extensions/anthropic/agent-sdk.runtime.ts always supplies
    // pathToClaudeCodeExecutable: context.command. SDK 0.3.239 only resolves
    // its optional bundled CLI when that option is absent. Keep the SDK JS,
    // API provider and externally supplied CLI execution path.
    for (const nativePackage of sdk.packages) excluded.add(nativePackage);
  } else if (sdk.manifest) {
    console.warn(`[openclaw-windows-payload] Keeping unreviewed Claude SDK ${sdk.manifest.version} native packages. Verify its explicit executable contract before trimming.`);
  }

  const hasCuaOwner = ['dist/extensions/cua-computer', 'third-party-extensions/cua-computer']
    .some(relative => fs.existsSync(path.join(root, relative)));
  if (!hasCuaOwner) {
    const driver = optionalNativePackages(root, CUA_DRIVER_PACKAGE);
    if (driver.manifest?.name === CUA_DRIVER_PACKAGE) {
      excluded.add(`node_modules/${CUA_DRIVER_PACKAGE}`);
      for (const nativePackage of driver.packages) excluded.add(nativePackage);
    }
  }

  const koffiIsStub = ['index.js', 'index.mjs'].every(file => {
    const target = path.join(root, 'node_modules/koffi', file);
    return isFile(target) && fs.readFileSync(target, 'utf8').split(/\r?\n/, 1)[0]
      === `// Stub (${file.endsWith('.mjs') ? 'ESM' : 'CJS'}): ${KOFFI_STUB_COMMENT}`;
  });
  const koromixRoot = path.join(root, 'node_modules/@koromix');
  if (koffiIsStub && fs.existsSync(koromixRoot)) {
    for (const item of fs.readdirSync(koromixRoot, { withFileTypes: true })) {
      if (item.isDirectory() && item.name.startsWith('koffi-')) excluded.add(`node_modules/@koromix/${item.name}`);
    }
  }

  console.log(`[openclaw-windows-payload] Verified bare runtime; excluding ${excluded.size} redundant paths and Control UI precompressed copies with originals.`);
  const filter = filePath => {
    const relative = filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if ([...excluded].some(prefix => relative === prefix || relative.startsWith(`${prefix}/`))) return false;
    // control-ui-static.ts falls back to identity when sidecars are absent.
    // Never remove an asset which exists only in compressed form.
    if (relative.startsWith('dist/control-ui/') && /\.(?:br|gz)$/.test(relative)) {
      return !isFile(path.join(root, relative.replace(/\.(?:br|gz)$/, '')));
    }
    return true;
  };
  return { filter, overrides: { [CONTROL_UI_MANIFEST]: buildControlUiManifest(root, filter) } };
}

module.exports = { createOpenClawWindowsPayload };
