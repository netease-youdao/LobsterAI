'use strict';

const {
  patchTypeScriptPluginPackageDirectory,
  prepareTypeScriptPluginPackage,
} = require('./typescript-plugin.cjs');

const BEE_PACKAGE_NAME = 'openclaw-netease-bee';

function buildBeeOptions(opts = {}) {
  return {
    ...opts,
    expectedPackageNames: [BEE_PACKAGE_NAME],
    packageLabel: BEE_PACKAGE_NAME,
  };
}

function patchBeePackageDirectory(packageDir, opts = {}) {
  return patchTypeScriptPluginPackageDirectory(packageDir, buildBeeOptions(opts));
}

function prepareOpenClawNeteaseBeePackage(inputTgzPath, outputDir, opts = {}) {
  return prepareTypeScriptPluginPackage(inputTgzPath, outputDir, buildBeeOptions(opts));
}

module.exports = {
  BEE_PACKAGE_NAME,
  patchBeePackageDirectory,
  prepareOpenClawNeteaseBeePackage,
};
