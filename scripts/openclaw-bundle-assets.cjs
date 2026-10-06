'use strict';

const fs = require('fs');
const path = require('path');

const OPENCLAW_BUNDLE_ASSET_TARGETS = [
  {
    targetFile: 'web-tree-sitter.wasm',
    sourceFile: path.join('node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
  },
];

function filesEqual(leftPath, rightPath) {
  const leftStat = fs.statSync(leftPath);
  const rightStat = fs.statSync(rightPath);
  if (leftStat.size !== rightStat.size) {
    return false;
  }
  return fs.readFileSync(leftPath).equals(fs.readFileSync(rightPath));
}

function ensureOpenClawBundleAssets(runtimeRoot) {
  const result = {
    created: [],
    updated: [],
    unchanged: [],
    missingSources: [],
    skippedBecauseBundleMissing: false,
  };

  if (!fs.existsSync(path.join(runtimeRoot, 'gateway-bundle.mjs'))) {
    result.skippedBecauseBundleMissing = true;
    return result;
  }

  for (const target of OPENCLAW_BUNDLE_ASSET_TARGETS) {
    const sourcePath = path.join(runtimeRoot, target.sourceFile);
    const targetPath = path.join(runtimeRoot, target.targetFile);
    if (!fs.existsSync(sourcePath)) {
      result.missingSources.push(target.sourceFile);
      continue;
    }

    if (fs.existsSync(targetPath)) {
      if (filesEqual(sourcePath, targetPath)) {
        result.unchanged.push(target.targetFile);
        continue;
      }
      fs.copyFileSync(sourcePath, targetPath);
      result.updated.push(target.targetFile);
      continue;
    }

    fs.copyFileSync(sourcePath, targetPath);
    result.created.push(target.targetFile);
  }

  return result;
}

module.exports = {
  OPENCLAW_BUNDLE_ASSET_TARGETS,
  ensureOpenClawBundleAssets,
};
