'use strict';

const fs = require('fs');
const path = require('path');

// Files the single-file gateway bundle resolves relative to itself (the runtime
// root) where the unbundled dist/ chunks found them beside or above themselves.
const OPENCLAW_BUNDLE_ASSET_TARGETS = [
  {
    targetFile: 'web-tree-sitter.wasm',
    sourceFile: path.join('node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
  },
  {
    // The startup-migration checkpoint keys on dist/build-info.json `builtAt` and
    // looks for ./build-info.json from its module. Without this copy the bundle
    // never records the checkpoint and reruns the full doctor preflight
    // (legacy state migrations, plugin convergence) on every gateway start.
    // Version, commit and bundled model catalog stamps use the same lookup.
    targetFile: 'build-info.json',
    sourceFile: path.join('dist', 'build-info.json'),
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
