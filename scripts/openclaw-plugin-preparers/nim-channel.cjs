'use strict';

const {
  patchTypeScriptPluginPackageDirectory,
  prepareTypeScriptPluginPackage,
} = require('./typescript-plugin.cjs');

const NIM_PLUGIN_PACKAGE_ID = 'openclaw-nim-channel';
const NIM_PACKAGE_NAME = '@nimsuite/openclaw-nim-channel';

function buildNimOptions(opts = {}) {
  return {
    ...opts,
    expectedPackageNames: [NIM_PACKAGE_NAME],
    packageLabel: NIM_PACKAGE_NAME,
  };
}

function patchNimPackageDirectory(packageDir, opts = {}) {
  return patchTypeScriptPluginPackageDirectory(packageDir, buildNimOptions(opts));
}

function prepareOpenClawNimPackage(inputTgzPath, outputDir, opts = {}) {
  return prepareTypeScriptPluginPackage(inputTgzPath, outputDir, buildNimOptions(opts));
}

module.exports = {
  NIM_PACKAGE_NAME,
  NIM_PLUGIN_PACKAGE_ID,
  patchNimPackageDirectory,
  prepareOpenClawNimPackage,
};
