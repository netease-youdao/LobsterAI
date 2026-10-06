'use strict';

// Environment variable names shared by the channel build entry points,
// electron-builder-config.cjs, and NSIS compile-time guards.

const BuildEnv = {
  ChannelBuild: 'LOBSTERAI_CHANNEL_BUILD',
  Keyfrom: 'KEYFROM',
  SilentOnDoubleClick: 'LOBSTERAI_SILENT_ON_DOUBLE_CLICK',
  ReuseWebPackage: 'LOBSTERAI_REUSE_NSIS_WEB_PACKAGE',
  WebInstaller: 'LOBSTERAI_WEB_INSTALLER',
  WebPkgUrl: 'LOBSTERAI_WEB_PKG_URL',
  WebPkgBaseUrl: 'LOBSTERAI_WEB_PKG_BASE_URL',
};

// Every variable a channel build must control itself; the build entry points
// scrub these from the inherited shell environment so leftovers from earlier
// commands can never leak into a build.
const CHANNEL_SCOPED_ENV_VARS = Object.values(BuildEnv);

module.exports = {
  BuildEnv,
  CHANNEL_SCOPED_ENV_VARS,
};
