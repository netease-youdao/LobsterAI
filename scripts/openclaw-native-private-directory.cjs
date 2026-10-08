'use strict';

/**
 * Guards for openclaw-windows-private-directory-native.patch.
 *
 * OpenClaw v2026.8.1 creates private Windows SQLite staging directories by
 * spawning PowerShell with an Add-Type compiler step; security software that
 * refuses that child process breaks startup migrations, the Gateway preflight
 * and Doctor. The patch routes the creation through Koffi and Win32 security
 * APIs. These checks stop bundles from being built from an unpatched tree or
 * from stale dist output, which would silently reintroduce the PowerShell spawn.
 */

const fs = require('fs');
const path = require('path');

const PATCH_NAME = 'openclaw-windows-private-directory-native.patch';
// SDDL fragment unique to the native helper; survives minification as a string literal.
const NATIVE_PRIVATE_DIRECTORY_MARKER = '(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)';
// C# class name embedded in the PowerShell implementation the patch removes.
const LEGACY_PRIVATE_DIRECTORY_MARKER = 'OpenClawPrivateDirectory';
// Literals that only survive when a private-directory creator survives tree
// shaking: the read-only worker argv (prepareSqliteReadOnlyLocation and the
// worker itself) and the session import stage prefix. The module-level staging
// prefixes are unsuitable: esbuild keeps their `process.pid` template constants
// as side effects even when every creating function was dropped.
const PRIVATE_DIRECTORY_CONSUMER_MARKERS = [
  '--openclaw-sqlite-readonly-child',
  'openclaw-session-import-',
];

function assertOpenClawSourceUsesNativePrivateDirectory(openclawSrc) {
  const helperPath = path.join(openclawSrc, 'src', 'infra', 'windows-private-directory.ts');
  if (!fs.existsSync(helperPath) || !fs.readFileSync(helperPath, 'utf8').includes(NATIVE_PRIVATE_DIRECTORY_MARKER)) {
    throw new Error(`Native Windows private directories require ${PATCH_NAME}; run openclaw:patch first.`);
  }
  const ownerPath = path.join(openclawSrc, 'src', 'infra', 'sqlite-private-directory.ts');
  const owner = fs.readFileSync(ownerPath, 'utf8');
  if (owner.includes(LEGACY_PRIVATE_DIRECTORY_MARKER) || !owner.includes('./windows-private-directory.js')) {
    throw new Error(`src/infra/sqlite-private-directory.ts still spawns PowerShell; ${PATCH_NAME} was not applied.`);
  }
}

/**
 * Returns true when the bundle embeds a private-directory consumer (and therefore
 * the native helper), false when it does not create private directories at all.
 */
function assertOpenClawBundleUsesNativePrivateDirectory(bundlePath) {
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  const name = path.basename(bundlePath);
  if (bundle.includes(LEGACY_PRIVATE_DIRECTORY_MARKER)) {
    throw new Error(`${name} still embeds the PowerShell private-directory helper; rebuild from a tree with ${PATCH_NAME}.`);
  }
  const consumesPrivateDirectories = PRIVATE_DIRECTORY_CONSUMER_MARKERS.some(marker => bundle.includes(marker));
  if (consumesPrivateDirectories && !bundle.includes(NATIVE_PRIVATE_DIRECTORY_MARKER)) {
    throw new Error(`${name} creates private SQLite directories without the native Windows helper; rebuild from a tree with ${PATCH_NAME}.`);
  }
  return consumesPrivateDirectories;
}

module.exports = {
  LEGACY_PRIVATE_DIRECTORY_MARKER,
  NATIVE_PRIVATE_DIRECTORY_MARKER,
  PRIVATE_DIRECTORY_CONSUMER_MARKERS,
  assertOpenClawBundleUsesNativePrivateDirectory,
  assertOpenClawSourceUsesNativePrivateDirectory,
};
