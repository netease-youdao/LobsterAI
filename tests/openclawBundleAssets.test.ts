import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

type BundleAssetTarget = {
  targetFile: string;
  sourceFile: string;
};

type BundleAssetResult = {
  created: string[];
  updated: string[];
  unchanged: string[];
  missingSources: string[];
  skippedBecauseBundleMissing: boolean;
};

const require = createRequire(import.meta.url);
const {
  OPENCLAW_BUNDLE_ASSET_TARGETS,
  ensureOpenClawBundleAssets,
} = require('../scripts/openclaw-bundle-assets.cjs') as {
  OPENCLAW_BUNDLE_ASSET_TARGETS: BundleAssetTarget[];
  ensureOpenClawBundleAssets: (runtimeRoot: string) => BundleAssetResult;
};

const tempDirs: string[] = [];

function makeRuntimeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-openclaw-bundle-assets-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('copies web-tree-sitter wasm beside the root gateway bundle', () => {
  const runtimeRoot = makeRuntimeRoot();
  const target = OPENCLAW_BUNDLE_ASSET_TARGETS[0];
  writeFile(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'export {};\n');
  writeFile(path.join(runtimeRoot, target.sourceFile), 'wasm-v1');

  const result = ensureOpenClawBundleAssets(runtimeRoot);

  expect(result.created).toEqual([target.targetFile]);
  expect(result.missingSources).toEqual([]);
  expect(fs.readFileSync(path.join(runtimeRoot, target.targetFile), 'utf8')).toBe('wasm-v1');
});

test('refreshes a stale root asset and leaves a matching asset unchanged', () => {
  const runtimeRoot = makeRuntimeRoot();
  const target = OPENCLAW_BUNDLE_ASSET_TARGETS[0];
  writeFile(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'export {};\n');
  writeFile(path.join(runtimeRoot, target.sourceFile), 'wasm-v2');
  writeFile(path.join(runtimeRoot, target.targetFile), 'wasm-v1');

  const updated = ensureOpenClawBundleAssets(runtimeRoot);
  const unchanged = ensureOpenClawBundleAssets(runtimeRoot);

  expect(updated.updated).toEqual([target.targetFile]);
  expect(unchanged.unchanged).toEqual([target.targetFile]);
});

test('reports a missing source and never creates an empty root asset', () => {
  const runtimeRoot = makeRuntimeRoot();
  const target = OPENCLAW_BUNDLE_ASSET_TARGETS[0];
  writeFile(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'export {};\n');

  const result = ensureOpenClawBundleAssets(runtimeRoot);

  expect(result.missingSources).toEqual([target.sourceFile]);
  expect(fs.existsSync(path.join(runtimeRoot, target.targetFile))).toBe(false);
});
