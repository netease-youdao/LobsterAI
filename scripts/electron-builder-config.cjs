'use strict';

const path = require('path');

const config = require('../electron-builder.json');
const { BuildEnv } = require('./build-env.cjs');
const { readBuildKeyfrom } = require('./build-keyfrom.cjs');
const { configureMacWebAuthnEntitlements } = require('./mac-webauthn-entitlements.cjs');

// Opt-in web installer (small NSIS stub that downloads the app package from a
// CDN at install time). Default builds are full offline installers; nothing
// changes unless LOBSTERAI_WEB_INSTALLER=1 is set explicitly.
const WEB_INSTALLER_ENV = BuildEnv.WebInstaller;
const WEB_PKG_BASE_URL_ENV = BuildEnv.WebPkgBaseUrl;
const WEB_PKG_URL_ENV = BuildEnv.WebPkgUrl;

function isWebInstallerEnabled() {
  const value = (process.env[WEB_INSTALLER_ENV] || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

function isTruthyBuildEnv(name) {
  const value = (process.env[name] || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

// Name of the .nsis.7z app package that electron-builder produces; fixed as
// <productName>-<version>-x64.nsis.7z.
function expectedPackageFileName() {
  const version = require('../package.json').version;
  return `${config.productName.toLowerCase()}-${version}-x64.nsis.7z`;
}

// Returns the complete package download URL baked into the web installer.
// Requires the app-builder-lib patch (patches/app-builder-lib+*.patch) that
// makes an explicit appPackageUrl be used verbatim instead of being treated
// as a directory to which the package file name is appended.
function resolveWebPackageUrl(keyfrom) {
  // Mode 1: exact package URL, for upload-first flows where object storage
  // assigns a random path/name (e.g. NOS). Used verbatim; must be a permanent
  // public link.
  const fullUrl = (process.env[WEB_PKG_URL_ENV] || '').trim().replace(/\/+$/, '');
  if (fullUrl) {
    if (fullUrl.includes('?')) {
      throw new Error(
        `[WebInstaller] ${WEB_PKG_URL_ENV} must be a permanent public URL without query parameters; ` +
          'signed/expiring links cannot be baked into the installer.',
      );
    }
    return fullUrl;
  }

  // Mode 2: pre-agreed CDN directory. The keyfrom marker is baked into the app
  // package (extraResources), so each channel gets its own subdirectory, and
  // the fixed package file name completes the URL.
  const raw = (process.env[WEB_PKG_BASE_URL_ENV] || '').trim().replace(/\/+$/, '');
  if (!raw) {
    throw new Error(
      `[WebInstaller] either ${WEB_PKG_URL_ENV} (exact package URL from object storage) or ` +
        `${WEB_PKG_BASE_URL_ENV} (CDN base directory, e.g. https://cdn.example.com/lobsterai/win) ` +
        `is required when ${WEB_INSTALLER_ENV}=1.`,
    );
  }
  return `${raw}/${keyfrom}/${expectedPackageFileName()}`;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function resourceKey(resource) {
  if (typeof resource === 'string') return `string:${resource}`;
  return `${resource?.from || ''}->${resource?.to || ''}`;
}

function mergeExtraResources(platformName) {
  const baseResources = asArray(config.extraResources);
  const platformConfig = config[platformName] || {};
  const platformResources = asArray(platformConfig.extraResources);
  const merged = [];
  const seen = new Set();

  for (const resource of [...baseResources, ...platformResources]) {
    const key = resourceKey(resource);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(resource);
  }

  config[platformName] = {
    ...platformConfig,
    extraResources: merged,
  };
}

const keyfrom = readBuildKeyfrom();
const isChannelBuild = isTruthyBuildEnv(BuildEnv.ChannelBuild);
const silentOnDoubleClick = isChannelBuild && isTruthyBuildEnv(BuildEnv.SilentOnDoubleClick);

for (const platformName of ['mac', 'win', 'linux']) {
  mergeExtraResources(platformName);
}

configureMacWebAuthnEntitlements(config, process.env.APPLE_TEAM_ID);

// Sign every Windows binary electron-builder produces (LobsterAI.exe, the
// uninstaller, the installer) through the internal Youdao signing service,
// not just the final Setup.exe: the unsigned inner exe is what security
// software freezes on first execution. The hook skips with a warning when
// YD_SIGN_* credentials are absent, so local packaging still works.
config.win = {
  ...config.win,
  sign: path.join(__dirname, 'win-sign.cjs'),
};

delete config.extraResources;

config.dmg = {
  ...(config.dmg || {}),
  artifactName: `LobsterAI-darwin-\${arch}-\${version}-${keyfrom}.\${ext}`,
};

config.nsis = {
  ...(config.nsis || {}),
  artifactName: `LobsterAI-Setup-\${arch}-\${version}-${keyfrom}${silentOnDoubleClick ? '-silent' : ''}.\${ext}`,
};

if (isWebInstallerEnabled()) {
  // Build the web installer alongside the full one: both targets share the
  // same intermediate .nsis.7z app package, so the extra cost is one more
  // makensis run. nsisWeb inherits every option from the nsis block.
  config.win = {
    ...config.win,
    target: ['nsis', 'nsis-web'],
  };
  config.nsisWeb = {
    appPackageUrl: resolveWebPackageUrl(keyfrom),
    artifactName: `LobsterAI-WebSetup-\${arch}-\${version}-${keyfrom}${silentOnDoubleClick ? '-silent' : ''}.\${ext}`,
  };
  console.log(`[WebInstaller] nsis-web target enabled, app package url: ${config.nsisWeb.appPackageUrl}`);
}

console.log(`[Keyfrom] configured artifact keyfrom as ${keyfrom}`);
console.log(`[ChannelBuild] silentOnDoubleClick=${silentOnDoubleClick}`);

module.exports = config;
