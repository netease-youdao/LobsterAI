'use strict';

const fs = require('fs');
const path = require('path');
const { extractPluginTarball, npmPackDirectory, readJsonFile, writeJsonFile } = require('./typescript-plugin.cjs');

const QQ_PACKAGE_NAME = '@tencent-connect/openclaw-qqbot';
const QQ_RUNTIME_ENTRY = './dist/index.cjs';

const QQ_PUBLISHED_EXIT_HOOKS = [
  '  process.on("beforeExit", flush);',
  '  process.on("SIGINT", () => {',
  '    flush();',
  '    process.exit(0);',
  '  });',
  '  process.on("SIGTERM", () => {',
  '    flush();',
  '    process.exit(0);',
  '  });',
].join('\n');

const QQ_HOST_MANAGED_EXIT_HOOKS = [
  '  // LobsterAI: OpenClaw owns process shutdown and boot lifecycle completion.',
  '  process.on("beforeExit", flush);',
  '  process.on("SIGINT", flush);',
  '  process.on("SIGTERM", flush);',
  '  process.on("exit", flush);',
].join('\n');

function patchQQExitHooks(runtimePath) {
  const source = fs.readFileSync(runtimePath, 'utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const publishedHooks = QQ_PUBLISHED_EXIT_HOOKS.replace(/\n/g, newline);
  const managedHooks = QQ_HOST_MANAGED_EXIT_HOOKS.replace(/\n/g, newline);
  if (source.split(managedHooks).length === 2 && !source.includes(publishedHooks)) return;
  if (source.split(publishedHooks).length !== 2 || source.includes(managedHooks)) {
    throw new Error('[qqbot-package] Review the published QQ shutdown hooks before bundling this runtime.');
  }
  // The plugin's process.exit(0) skips the host's async channel cleanup and
  // leaves gateway_boot_lifecycle open even though the parent sees exit 0.
  // Keep synchronous store flushing, including the host's final process.exit
  // path (which skips beforeExit), and let OpenClaw finish shutting down.
  fs.writeFileSync(runtimePath, source.replace(publishedHooks, managedHooks), 'utf8');
}

function configureQQRuntimeEntry(packageDir) {
  const packagePath = path.join(packageDir, 'package.json');
  const pkg = readJsonFile(packagePath);
  if (pkg.name !== QQ_PACKAGE_NAME || pkg.version !== '2.0.1') {
    throw new Error('[qqbot-package] Review the bundled runtime entry before changing the pinned QQ package.');
  }
  if (!fs.statSync(path.join(packageDir, QQ_RUNTIME_ENTRY)).isFile()) {
    throw new Error('[qqbot-package] The published QQ CommonJS runtime entry is missing.');
  }
  patchQQExitHooks(path.join(packageDir, QQ_RUNTIME_ENTRY));
  // LobsterAI supplies the shared SDK bridge. The published preload exists
  // only to find a global OpenClaw install and create a private SDK symlink;
  // bypass it via entry metadata so relocated builds use their own SDK.
  pkg.openclaw = {
    ...pkg.openclaw,
    extensions: [QQ_RUNTIME_ENTRY],
    runtimeExtensions: [QQ_RUNTIME_ENTRY],
  };
  const manifestPath = path.join(packageDir, 'openclaw.plugin.json');
  const manifest = readJsonFile(manifestPath);
  manifest.extensions = [QQ_RUNTIME_ENTRY];
  writeJsonFile(packagePath, pkg);
  writeJsonFile(manifestPath, manifest);
}

function prepareQQPackage(tarball, outputDir) {
  const sourceDir = extractPluginTarball(tarball, outputDir, QQ_PACKAGE_NAME);
  configureQQRuntimeEntry(sourceDir);
  const packDir = fs.mkdtempSync(path.join(outputDir, 'openclaw-qqbot-package-'));
  return npmPackDirectory(sourceDir, packDir);
}

module.exports = { QQ_PACKAGE_NAME, QQ_RUNTIME_ENTRY, configureQQRuntimeEntry, prepareQQPackage };
