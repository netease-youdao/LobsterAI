'use strict';

const fs = require('fs');
const path = require('path');
const { extractPluginTarball, npmPackDirectory, readJsonFile, writeJsonFile } = require('./typescript-plugin.cjs');

const QQ_PACKAGE_NAME = '@tencent-connect/openclaw-qqbot';
const QQ_RUNTIME_ENTRY = './dist/index.cjs';

function configureQQRuntimeEntry(packageDir) {
  const packagePath = path.join(packageDir, 'package.json');
  const pkg = readJsonFile(packagePath);
  if (pkg.name !== QQ_PACKAGE_NAME || pkg.version !== '2.0.1') {
    throw new Error('[qqbot-package] Review the bundled runtime entry before changing the pinned QQ package.');
  }
  if (!fs.statSync(path.join(packageDir, QQ_RUNTIME_ENTRY)).isFile()) {
    throw new Error('[qqbot-package] The published QQ CommonJS runtime entry is missing.');
  }
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
