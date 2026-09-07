'use strict';

// Marks the OpenClaw host package as an optional peerDependency inside plugin
// tarballs before they are handed to `openclaw plugins install`.
//
// OpenClaw installs archive plugins with `npm install --omit=dev` and without
// `--omit=peer`, and its npm environment builder drops
// npm_config_legacy_peer_deps before spawning npm. npm 7+ therefore
// auto-installs a required `openclaw` peer at the newest registry version
// (openclaw@2026.8.x pulls @anthropic-ai/claude-agent-sdk with a 300+ MB
// platform binary). The host gateway already provides openclaw at runtime, so
// declaring the peer optional keeps npm from downloading it while leaving the
// peer range, OpenClaw's host link and its host-version checks untouched.

const fs = require('fs');
const path = require('path');

const {
  extractPluginTarball,
  npmPackDirectory,
  readJsonFile,
  writeJsonFile,
} = require('./typescript-plugin.cjs');

const HOST_PEER_PACKAGE_NAME = 'openclaw';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function patchHostPeerPackageDirectory(packageDir, opts = {}) {
  const log = opts.log || (() => {});
  const packageJsonPath = path.join(packageDir, 'package.json');
  const pkg = readJsonFile(packageJsonPath);
  const packageLabel = opts.packageLabel || pkg.name || 'OpenClaw plugin';

  const peerRange = isRecord(pkg.peerDependencies)
    ? pkg.peerDependencies[HOST_PEER_PACKAGE_NAME]
    : undefined;
  if (typeof peerRange !== 'string') {
    return { changed: false, peerRange: null };
  }

  const peerMeta = isRecord(pkg.peerDependenciesMeta) ? pkg.peerDependenciesMeta : {};
  const hostMeta = isRecord(peerMeta[HOST_PEER_PACKAGE_NAME]) ? peerMeta[HOST_PEER_PACKAGE_NAME] : {};
  if (hostMeta.optional === true) {
    return { changed: false, peerRange };
  }

  pkg.peerDependenciesMeta = {
    ...peerMeta,
    [HOST_PEER_PACKAGE_NAME]: { ...hostMeta, optional: true },
  };
  writeJsonFile(packageJsonPath, pkg);

  log(
    `  Marked ${packageLabel} peerDependency "${HOST_PEER_PACKAGE_NAME}" (${peerRange}) ` +
      'optional so npm does not download the host package.',
  );
  return { changed: true, peerRange };
}

function prepareHostPeerPackage(inputTgzPath, outputDir, opts = {}) {
  const packageLabel = opts.packageLabel || 'OpenClaw plugin';
  const sourceDir = extractPluginTarball(inputTgzPath, outputDir, packageLabel);

  const result = patchHostPeerPackageDirectory(sourceDir, { ...opts, packageLabel });
  if (!result.changed) {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    return inputTgzPath;
  }

  const patchedPackDir = fs.mkdtempSync(path.join(outputDir, 'openclaw-plugin-host-peer-'));
  return npmPackDirectory(sourceDir, patchedPackDir);
}

module.exports = {
  HOST_PEER_PACKAGE_NAME,
  patchHostPeerPackageDirectory,
  prepareHostPeerPackage,
};
