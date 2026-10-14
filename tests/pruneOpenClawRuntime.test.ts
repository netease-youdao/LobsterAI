import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  KOFFI_BUILD_ONLY_PATHS,
  KOFFI_PACKAGE,
  PACKAGES_TO_STUB,
  isWindowsRuntimeTarget,
  readRuntimeTarget,
  resolvePackagesToStub,
  shouldKeepBundledExtension,
  trimKoffiBuildFiles,
} = require('../scripts/prune-openclaw-runtime.cjs');

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-prune-'));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relative: string, content = 'fixture'): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneOpenClawRuntime keeps required bundled extensions', () => {
  expect(shouldKeepBundledExtension('openai')).toBe(true);
  expect(shouldKeepBundledExtension('browser')).toBe(true);
  expect(shouldKeepBundledExtension('feishu')).toBe(true);
  expect(shouldKeepBundledExtension('xiaomi')).toBe(true);
});

test('pruneOpenClawRuntime removes explicitly unwanted bundled extensions', () => {
  expect(shouldKeepBundledExtension('amazon-bedrock')).toBe(false);
  expect(shouldKeepBundledExtension('amazon-bedrock-mantle')).toBe(false);
  expect(shouldKeepBundledExtension('slack')).toBe(false);
  expect(shouldKeepBundledExtension('diffs')).toBe(false);
});

test('pruneOpenClawRuntime keeps koffi only for Windows runtime targets', () => {
  expect(PACKAGES_TO_STUB).toContain(KOFFI_PACKAGE);
  expect(isWindowsRuntimeTarget('win-x64')).toBe(true);
  expect(isWindowsRuntimeTarget('win-arm64')).toBe(true);
  expect(isWindowsRuntimeTarget('mac-arm64')).toBe(false);
  expect(isWindowsRuntimeTarget('')).toBe(false);
  expect(isWindowsRuntimeTarget(undefined)).toBe(false);
  expect(resolvePackagesToStub('win-x64')).toEqual(PACKAGES_TO_STUB.filter((name: string) => name !== KOFFI_PACKAGE));
  expect(resolvePackagesToStub('mac-arm64')).toEqual(PACKAGES_TO_STUB);
  expect(resolvePackagesToStub('')).toEqual(PACKAGES_TO_STUB);
});

test('pruneOpenClawRuntime reads the runtime target from build metadata', () => {
  const root = tempDir();
  expect(readRuntimeTarget(root)).toBe('');
  write(root, 'runtime-build-info.json', JSON.stringify({ target: 'win-x64' }));
  expect(readRuntimeTarget(root)).toBe('win-x64');
  write(root, 'runtime-build-info.json', JSON.stringify({ target: 7 }));
  expect(readRuntimeTarget(root)).toBe('');
  write(root, 'runtime-build-info.json', '{not json');
  expect(readRuntimeTarget(root)).toBe('');
});

test('pruneOpenClawRuntime trims only build-time koffi content and keeps the loader', () => {
  const root = tempDir();
  const nodeModules = path.join(root, 'node_modules');
  const kept = [
    'koffi/index.cjs', 'koffi/index.js', 'koffi/package.json', 'koffi/src/koffi/index.cjs',
    'koffi/src/koffi/src/static.cjs', 'koffi/lib/native/base/api.h',
    '@koromix/koffi-win32-x64/index.js', '@koromix/koffi-win32-x64/win32_x64/koffi.node',
  ];
  const removed = ['koffi/doc/index.html', 'koffi/vendor/node-api-headers/node_api.h', 'koffi/CHANGELOG.md', 'koffi/cnoke.cjs'];
  for (const relative of [...kept, ...removed]) write(nodeModules, relative);
  const stats = { filesRemoved: 0, dirsRemoved: 0, bytesFreed: 0 };
  expect([...trimKoffiBuildFiles(nodeModules, stats)].sort()).toEqual([...KOFFI_BUILD_ONLY_PATHS].sort());
  for (const relative of kept) expect(fs.existsSync(path.join(nodeModules, relative))).toBe(true);
  for (const relative of removed) expect(fs.existsSync(path.join(nodeModules, relative))).toBe(false);
  expect(stats.dirsRemoved).toBe(2);
  expect(stats.filesRemoved).toBe(2);
  expect(stats.bytesFreed).toBeGreaterThan(0);
  expect(trimKoffiBuildFiles(nodeModules, stats)).toEqual([]);
  expect(trimKoffiBuildFiles(path.join(root, 'missing'), stats)).toEqual([]);
});
