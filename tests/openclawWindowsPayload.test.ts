import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';

import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const tar = require('tar');
const { createOpenClawWindowsPayload } = require('../scripts/openclaw-windows-payload.cjs');
const { createOpenClawRuntimePayload, OpenClawPayloadTarget } = require('../scripts/openclaw-runtime-payload.cjs');
const { pruneOpenClawMacPayload } = require('../scripts/openclaw-mac-payload.cjs');
const { afterPack } = require('../scripts/electron-builder-hooks.cjs');
const { Arch } = require('builder-util');
const { ensureOpenClawPluginSdkBridge, verifyOpenClawPluginSdkBridge } = require('../scripts/openclaw-plugin-sdk-bridge.cjs');
const { packSingleSource, packMultipleSources } = require('../scripts/pack-openclaw-tar.cjs');
const tempDirs: string[] = [];
const nativeRoots = ['dist/native', 'node_modules/@openclaw/fs-safe/dist/native'];
const sdkName = '@anthropic-ai/claude-agent-sdk';
const cuaName = '@trycua/cua-driver';
const controlUiManifest = 'dist/control-ui/asset-manifest.json';
const macTargets = [
  { target: OpenClawPayloadTarget.MacArm64, arch: Arch.arm64, native: 'darwin-arm64', otherNative: 'darwin-x64' },
  { target: OpenClawPayloadTarget.MacX64, arch: Arch.x64, native: 'darwin-x64', otherNative: 'darwin-arm64' },
];

function createOpenClawWindowsPayloadFilter(root: string, target: string | undefined) {
  return createOpenClawWindowsPayload(root, target).filter;
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-windows-payload-'));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relative: string, content = 'fixture'): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function manifest(root: string, relative: string, value: object): void {
  write(root, relative, JSON.stringify(value));
}

async function fixture(target: string = OpenClawPayloadTarget.WindowsX64): Promise<string> {
  const parent = tempDir();
  const root = path.join(parent, 'runtime');
  manifest(root, 'package.json', {
    name: 'openclaw', version: '2026.8.1', type: 'module',
    exports: { './plugin-sdk/core': './dist/plugin-sdk/core.js' },
  });
  manifest(root, 'runtime-build-info.json', { target });
  const bareFiles = {
    'openclaw.mjs': 'import "./dist/entry.js";',
    'dist/entry.js': 'export {};',
    'dist/plugin-sdk/core.js': 'export const state = { value: 42 };',
    'dist/control-ui/index.html': '<script src="./assets/app.js"></script>',
    'dist/control-ui/assets/app.js': 'console.log("UI");',
    'dist/worker/worker.mjs': 'export const worker = true;',
  };
  const stage = path.join(parent, 'stage');
  for (const [relative, content] of Object.entries(bareFiles)) {
    write(root, relative, content);
    write(stage, relative, content);
  }
  // Declarations and source maps are already omitted by the production tar.
  write(stage, 'dist/plugin-sdk/core.d.ts', 'export declare const state: object;');
  write(stage, 'dist/entry.js.map', '{}');
  const archiveStream = await asar.createPackage(stage, path.join(root, 'gateway.asar'));
  await finished(archiveStream); // Release the fixture's write handle before moving it on Windows.
  write(root, 'gateway-bundle.mjs');
  write(root, 'web-tree-sitter.wasm');
  write(root, 'dist/control-ui/assets/app.js.br');
  write(root, 'dist/control-ui/assets/app.js.gz');
  write(root, 'dist/control-ui/assets/compressed-only.gz');
  const assets = ['assets/app.js', 'assets/app.js.br', 'assets/app.js.gz'].map(relative => {
    const content = fs.readFileSync(path.join(root, 'dist/control-ui', relative));
    return { path: relative, size: content.length, sha256: createHash('sha256').update(content).digest('hex') };
  });
  manifest(root, controlUiManifest, {
    version: 1, assets,
    generation: createHash('sha256').update(assets.map(asset => `${asset.path}\0${asset.size}\0${asset.sha256}\n`).join('')).digest('hex'),
  });
  for (const nativeRoot of nativeRoots) {
    for (const native of ['win32-x64-msvc', 'darwin-arm64', 'darwin-x64', 'linux-x64-gnu']) {
      write(root, `${nativeRoot}/${native}/fs-safe-native.node`);
    }
    write(root, `${nativeRoot}/metadata.json`, '{}');
  }
  const macNative = macTargets.find(item => item.target === target)?.native;
  for (const [name, version, nativeSuffix] of [
    [sdkName, '0.3.239', macNative || 'win32-x64'], [cuaName, '0.21.0', macNative || 'win32-x64-msvc'],
  ]) {
    manifest(root, `node_modules/${name}/package.json`, {
      name, version, optionalDependencies: { [`${name}-${nativeSuffix}`]: version },
    });
    write(root, `node_modules/${name}/sdk.mjs`, 'export {};');
    write(root, `node_modules/${name}-${nativeSuffix}/native.bin`);
  }
  write(root, 'node_modules/@anthropic-ai/sdk/index.mjs');
  write(root, 'dist/extensions/anthropic/index.js');
  write(root, 'node_modules/@trycua/unrelated/index.js');
  write(root, 'node_modules/@koromix/unrelated/index.js');
  write(root, 'node_modules/@koromix/koffi-win32-x64/native.node');
  for (const { native } of macTargets) {
    write(root, `node_modules/@koromix/koffi-${native}/native.node`);
    write(root, `node_modules/@img/sharp-${native}/lib/sharp.node`);
  }
  for (const [file, format] of [['index.js', 'CJS'], ['index.mjs', 'ESM']]) {
    write(root, `node_modules/koffi/${file}`, `// Stub (${format}): this package is not needed for headless gateway operation.\n`);
  }
  write(root, 'third-party-extensions/discord/probe.mjs', [
    'import assert from "node:assert/strict";',
    'const sdk = await import("openclaw/plugin-sdk/core");',
    'const host = await import("../../dist/plugin-sdk/core.js");',
    'assert.equal(sdk.state, host.state);',
    'assert.equal(sdk.state.value, 42);',
    'console.log("relocated-sdk-ok");',
  ].join('\n'));
  ensureOpenClawPluginSdkBridge(root);
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test.each(['single', 'combined'])('slims the %s tar while preserving native SDK resolution after relocation', async mode => {
  const root = await fixture();
  const payload = createOpenClawWindowsPayload(root, 'win-x64');
  const originalManifest = fs.readFileSync(path.join(root, controlUiManifest), 'utf8');
  const archive = path.join(tempDir(), 'resources.tar');
  const skills = tempDir();
  write(skills, 'gateway.asar');
  write(skills, `node_modules/${sdkName}-win32-x64/native.bin`);
  const counts = mode === 'single'
    ? packSingleSource(root, archive, 'cfmind', payload)
    : packMultipleSources([{ dir: root, prefix: 'cfmind', ...payload }, { dir: skills, prefix: 'SKILLs' }], archive);
  const entries: string[] = [];
  tar.list({ file: archive, sync: true, onentry: (entry: { path: string; type: string }) => {
    if (entry.type === 'File') entries.push(entry.path);
  } });
  expect(counts.totalFiles).toBe(entries.length);
  for (const removed of [
    'gateway.asar', `node_modules/${sdkName}-win32-x64/native.bin`,
    `node_modules/${cuaName}/sdk.mjs`, `node_modules/${cuaName}-win32-x64-msvc/native.bin`,
    'node_modules/@koromix/koffi-win32-x64/native.node',
    'dist/control-ui/assets/app.js.br', 'dist/control-ui/assets/app.js.gz',
    ...nativeRoots.flatMap(nativeRoot => ['darwin-arm64', 'linux-x64-gnu'].map(target => `${nativeRoot}/${target}/fs-safe-native.node`)),
  ]) {
    expect(entries).not.toContain(`cfmind/${removed}`);
    expect(fs.existsSync(path.join(root, removed))).toBe(true); // The build cache is intact.
  }
  for (const kept of [
    'gateway-bundle.mjs', 'openclaw.mjs', 'dist/entry.js', 'dist/worker/worker.mjs',
    'dist/control-ui/index.html', 'dist/control-ui/assets/app.js', 'dist/control-ui/assets/compressed-only.gz',
    `node_modules/${sdkName}/sdk.mjs`, 'node_modules/@anthropic-ai/sdk/index.mjs', 'dist/extensions/anthropic/index.js',
    'node_modules/@trycua/unrelated/index.js', 'node_modules/@koromix/unrelated/index.js',
    ...nativeRoots.flatMap(nativeRoot => [`${nativeRoot}/win32-x64-msvc/fs-safe-native.node`, `${nativeRoot}/metadata.json`]),
  ]) expect(entries).toContain(`cfmind/${kept}`);
  if (mode === 'combined') {
    expect(entries).toContain('SKILLs/gateway.asar');
    expect(entries).toContain(`SKILLs/node_modules/${sdkName}-win32-x64/native.bin`);
  }
  const destination = path.join(tempDir(), '安装目录 with spaces #');
  fs.mkdirSync(destination);
  tar.extract({ file: archive, cwd: destination, sync: true });
  const installedManifest = JSON.parse(fs.readFileSync(path.join(destination, 'cfmind', controlUiManifest), 'utf8'));
  const original = JSON.parse(originalManifest);
  expect(installedManifest.assets).toEqual([original.assets[0]]);
  const asset = original.assets[0];
  expect(installedManifest.generation).toBe(createHash('sha256').update(`assets/app.js\0${asset.size}\0${asset.sha256}\n`).digest('hex'));
  expect(installedManifest.generation).not.toBe(original.generation);
  expect(fs.readFileSync(path.join(root, controlUiManifest), 'utf8')).toBe(originalManifest);
  expect(entries.filter(entry => entry === `cfmind/${controlUiManifest}`)).toHaveLength(1);
  fs.renameSync(root, `${root}-old`);
  const installed = path.join(destination, 'cfmind');
  verifyOpenClawPluginSdkBridge(installed);
  const probe = spawnSync(process.execPath, [path.join(installed, 'third-party-extensions/discord/probe.mjs')], {
    cwd: installed, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  expect(probe.stderr).toBe('');
  expect(probe.status).toBe(0);
  expect(probe.stdout.trim()).toBe('relocated-sdk-ok');
});

test.each([
  'openclaw.mjs', 'gateway-bundle.mjs', 'dist/entry.js', 'dist/plugin-sdk/core.js', 'dist/control-ui/index.html',
  'dist/worker/worker.mjs', 'web-tree-sitter.wasm',
  controlUiManifest,
  ...nativeRoots.map(root => `${root}/win32-x64-msvc/fs-safe-native.node`),
])('rejects an incomplete bare runtime: %s', async relative => {
  const root = await fixture();
  fs.unlinkSync(path.join(root, relative));
  expect(() => createOpenClawWindowsPayloadFilter(root, 'win-x64')).toThrow(/Missing/);
});

test('rejects a same-sized stale bare chunk instead of discarding its archive fallback', async () => {
  const root = await fixture();
  write(root, 'dist/control-ui/assets/app.js', 'console.log("XX");');
  expect(() => createOpenClawWindowsPayloadFilter(root, 'win-x64')).toThrow('differs from gateway.asar');
});

test('keeps the CUA driver when its owner returns and keeps native Koffi when the parent is real', async () => {
  const root = await fixture();
  write(root, 'dist/extensions/cua-computer/index.js');
  write(root, 'node_modules/koffi/index.js', 'module.exports = require("@koromix/koffi-win32-x64");');
  const filter = createOpenClawWindowsPayloadFilter(root, 'win-x64');
  expect(filter(`node_modules/${cuaName}/sdk.mjs`)).toBe(true);
  expect(filter(`node_modules/${cuaName}-win32-x64-msvc/native.bin`)).toBe(true);
  expect(filter('node_modules/@koromix/koffi-win32-x64/native.node')).toBe(true);
});

test.each(['mac-arm64', 'linux-x64', 'win-arm64', undefined])('does not apply x64 exclusions to target %s', target => {
  const filter = createOpenClawWindowsPayloadFilter(tempDir(), target);
  expect(filter('gateway.asar')).toBe(true);
  expect(filter(`node_modules/${sdkName}-win32-x64/native.bin`)).toBe(true);
});

test('rejects a runtime built for a different target', async () => {
  const root = await fixture();
  manifest(root, 'runtime-build-info.json', { target: 'mac-arm64' });
  expect(() => createOpenClawWindowsPayloadFilter(root, 'win-x64')).toThrow('does not match packaging target');
});

test('keeps native SDK packages after an unreviewed SDK upgrade', async () => {
  const root = await fixture();
  manifest(root, `node_modules/${sdkName}/package.json`, {
    name: sdkName, version: '0.4.0', optionalDependencies: { [`${sdkName}-win32-x64`]: '0.4.0' },
  });
  const filter = createOpenClawWindowsPayloadFilter(root, 'win-x64');
  expect(filter(`node_modules/${sdkName}-win32-x64/native.bin`)).toBe(true);
});

test('requires a new payload review after an OpenClaw upgrade', async () => {
  const root = await fixture();
  const host = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  manifest(root, 'package.json', { ...host, version: '2026.8.2' });
  const filter = createOpenClawWindowsPayloadFilter(root, 'win-x64');
  expect(filter('gateway.asar')).toBe(true);
  expect(filter(`node_modules/${sdkName}-win32-x64/native.bin`)).toBe(true);
});

test.each(['version', 'generation', 'path'])('rejects an unreviewed or stale Control UI manifest: %s', async field => {
  const root = await fixture();
  const value = JSON.parse(fs.readFileSync(path.join(root, controlUiManifest), 'utf8'));
  if (field === 'version') value.version = 2;
  if (field === 'generation') value.generation = '0'.repeat(64);
  if (field === 'path') value.assets[0].path = 'assets/../../outside.js';
  manifest(root, controlUiManifest, value);
  expect(() => createOpenClawWindowsPayload(root, 'win-x64')).toThrow(/Control UI asset manifest/);
});

test('rejects tar overrides outside their owned staging directory', () => {
  const root = tempDir();
  write(root, 'file.js');
  const output = path.join(tempDir(), 'payload.tar');
  expect(() => packSingleSource(root, output, 'cfmind', { overrides: { '../outside.js': 'unexpected' } })).toThrow('Invalid payload override path');
  expect(fs.existsSync(path.join(path.dirname(output), 'outside.js'))).toBe(false);
});

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[path.relative(root, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  }
  walk(root);
  return files;
}

test.each(macTargets)('trims the $target app copy and preserves runtime imports and the source cache', async ({ target, native, otherNative }) => {
  const root = await fixture(target);
  const original = snapshot(root);
  const app = path.join(tempDir(), '安装目录 with spaces #', 'LobsterAI.app');
  const installed = path.join(app, 'Contents', 'Resources', 'cfmind');
  fs.cpSync(root, installed, { recursive: true });
  // electron-builder uses hard links for resource files on CI.
  fs.unlinkSync(path.join(installed, controlUiManifest));
  fs.linkSync(path.join(root, controlUiManifest), path.join(installed, controlUiManifest));
  const resources = path.dirname(installed);
  write(resources, 'SKILLs/gateway.asar');
  fs.chmodSync(path.join(installed, 'openclaw.mjs'), 0o755);
  const beforeSize = measureSize(installed);

  const stats = pruneOpenClawMacPayload(app, target);
  expect(stats.bytesFreed).toBe(beforeSize - measureSize(installed));
  expect(stats.bytesFreed).toBeGreaterThan(0);
  expect(snapshot(root)).toEqual(original);
  for (const removed of [
    'gateway.asar', 'gateway-bundle.mjs', `node_modules/${sdkName}-${native}/native.bin`,
    `node_modules/${cuaName}/sdk.mjs`, `node_modules/${cuaName}-${native}/native.bin`,
    'dist/control-ui/assets/app.js.br', 'dist/control-ui/assets/app.js.gz',
    ...macTargets.map(item => `node_modules/@koromix/koffi-${item.native}/native.node`),
    ...nativeRoots.flatMap(dir => [otherNative, 'win32-x64-msvc', 'linux-x64-gnu'].map(arch => `${dir}/${arch}/fs-safe-native.node`)),
  ]) expect(fs.existsSync(path.join(installed, removed)), removed).toBe(false);
  for (const kept of [
    'openclaw.mjs', 'dist/worker/worker.mjs',
    `node_modules/${sdkName}/sdk.mjs`, 'node_modules/@anthropic-ai/sdk/index.mjs', 'dist/extensions/anthropic/index.js',
    'dist/control-ui/assets/app.js', 'dist/control-ui/assets/compressed-only.gz',
    `node_modules/@img/sharp-${native}/lib/sharp.node`,
    ...nativeRoots.map(dir => `${dir}/${native}/fs-safe-native.node`),
  ]) expect(fs.readFileSync(path.join(installed, kept))).toEqual(fs.readFileSync(path.join(root, kept)));
  expect(fs.readFileSync(path.join(resources, 'SKILLs/gateway.asar'), 'utf8')).toBe('fixture');
  if (process.platform !== 'win32') expect(fs.statSync(path.join(installed, 'openclaw.mjs')).mode & 0o777).toBe(0o755);

  const ui = JSON.parse(fs.readFileSync(path.join(installed, controlUiManifest), 'utf8'));
  expect(ui.assets).toHaveLength(1);
  const asset = ui.assets[0];
  expect(asset.path).toBe('assets/app.js');
  expect(ui.generation).toBe(createHash('sha256').update(`${asset.path}\0${asset.size}\0${asset.sha256}\n`).digest('hex'));
  fs.renameSync(root, `${root}-old`);
  verifyOpenClawPluginSdkBridge(installed);
  const probe = spawnSync(process.execPath, [path.join(installed, 'third-party-extensions/discord/probe.mjs')], {
    cwd: installed, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 15000,
  });
  expect(probe.stderr).toBe('');
  expect(probe.status).toBe(0);
  expect(probe.stdout.trim()).toBe('relocated-sdk-ok');
  const trimmed = snapshot(installed);
  expect(pruneOpenClawMacPayload(app, target)).toEqual({ filesRemoved: 0, bytesFreed: 0 });
  expect(snapshot(installed)).toEqual(trimmed);
});

function measureSize(root: string): number {
  return fs.readdirSync(root, { withFileTypes: true }).reduce((size, entry) => {
    const file = path.join(root, entry.name);
    return size + (entry.isDirectory() ? measureSize(file) : fs.lstatSync(file).size);
  }, 0);
}

test.each(macTargets)('rejects incomplete $target native payloads before deleting files', async ({ target, native }) => {
  const root = await fixture(target);
  for (const nativeRoot of nativeRoots) {
    const app = path.join(tempDir(), 'LobsterAI.app');
    const installed = path.join(app, 'Contents', 'Resources', 'cfmind');
    fs.cpSync(root, installed, { recursive: true });
    fs.unlinkSync(path.join(installed, nativeRoot, native, 'fs-safe-native.node'));
    const before = snapshot(installed);
    expect(() => pruneOpenClawMacPayload(app, target)).toThrow('Missing bare runtime file');
    expect(snapshot(installed)).toEqual(before);
  }
});

test.each(macTargets)('preserves unreviewed SDK packages and restored native consumers on $target', async ({ target, native }) => {
  const root = await fixture(target);
  manifest(root, `node_modules/${sdkName}/package.json`, {
    name: sdkName, version: '0.4.0', optionalDependencies: { [`${sdkName}-${native}`]: '0.4.0' },
  });
  write(root, 'third-party-extensions/cua-computer/index.js');
  write(root, 'node_modules/koffi/index.mjs', 'export default {};');
  const { filter } = createOpenClawRuntimePayload(root, target);
  for (const kept of [
    `node_modules/${sdkName}-${native}/native.bin`, `node_modules/${cuaName}/sdk.mjs`,
    `node_modules/${cuaName}-${native}/native.bin`, `node_modules/@koromix/koffi-${native}/native.node`,
  ]) expect(filter(kept)).toBe(true);
});

test.each(macTargets)('leaves unreviewed OpenClaw versions untouched on $target', async ({ target }) => {
  const root = await fixture(target);
  const host = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  manifest(root, 'package.json', { ...host, version: '2026.8.2' });
  const app = path.join(tempDir(), 'LobsterAI.app');
  const installed = path.join(app, 'Contents', 'Resources', 'cfmind');
  fs.cpSync(root, installed, { recursive: true });
  const before = snapshot(installed);
  expect(pruneOpenClawMacPayload(app, target)).toEqual({ filesRemoved: 0, bytesFreed: 0 });
  expect(snapshot(installed)).toEqual(before);
});

test.each([
  { name: 'missing bare CLI', corrupt: (root: string) => fs.unlinkSync(path.join(root, 'openclaw.mjs')) },
  { name: 'missing worker', corrupt: (root: string) => fs.unlinkSync(path.join(root, 'dist/worker/worker.mjs')) },
  { name: 'stale bare file', corrupt: (root: string) => write(root, 'dist/entry.js', 'stale code') },
  { name: 'target mismatch', corrupt: (root: string) => manifest(root, 'runtime-build-info.json', { target: OpenClawPayloadTarget.MacX64 }) },
  { name: 'invalid manifest', corrupt: (root: string) => manifest(root, controlUiManifest, { version: 2 }) },
])('aborts macOS pruning without partial deletion on $name', async ({ corrupt }) => {
  const target = OpenClawPayloadTarget.MacArm64;
  const root = await fixture(target);
  const app = path.join(tempDir(), 'LobsterAI.app');
  const installed = path.join(app, 'Contents', 'Resources', 'cfmind');
  fs.cpSync(root, installed, { recursive: true });
  corrupt(installed);
  const before = snapshot(installed);
  expect(() => pruneOpenClawMacPayload(app, target)).toThrow();
  expect(snapshot(installed)).toEqual(before);
});

test('refuses to prune a linked build cache as a packaged macOS runtime', async () => {
  const root = await fixture(OpenClawPayloadTarget.MacArm64);
  const app = path.join(tempDir(), 'LobsterAI.app');
  const installed = path.join(app, 'Contents', 'Resources', 'cfmind');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.symlinkSync(root, installed, process.platform === 'win32' ? 'junction' : 'dir');
  const before = snapshot(root);
  expect(() => pruneOpenClawMacPayload(app, OpenClawPayloadTarget.MacArm64)).toThrow('not a link to the build cache');
  expect(snapshot(root)).toEqual(before);
});

test.each(macTargets)('runs $target payload pruning from the real afterPack hook', async ({ target, arch, native }) => {
  const root = await fixture(target);
  const appOutDir = tempDir();
  const installed = path.join(appOutDir, 'LobsterAI.app', 'Contents', 'Resources', 'cfmind');
  fs.cpSync(root, installed, { recursive: true });
  write(installed, 'node_modules/.bin/unused');
  await afterPack({ appOutDir, arch, electronPlatformName: 'darwin', packager: { appInfo: { productFilename: 'LobsterAI' } } });
  expect(fs.existsSync(path.join(installed, 'gateway.asar'))).toBe(false);
  expect(fs.existsSync(path.join(installed, 'gateway-bundle.mjs'))).toBe(false);
  expect(fs.existsSync(path.join(installed, 'node_modules/.bin'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'gateway.asar'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'gateway-bundle.mjs'))).toBe(true);
  expect(fs.existsSync(path.join(installed, 'dist/native', native, 'fs-safe-native.node'))).toBe(true);
});

test.each([Arch.arm64, Arch.x64, Arch.universal])('preserves universal build resources in its arch=%s hook', async arch => {
  const appOutDir = tempDir();
  const installed = path.join(appOutDir, 'LobsterAI.app', 'Contents', 'Resources', 'cfmind');
  for (const { native } of macTargets) write(installed, `dist/native/${native}/fs-safe-native.node`);
  write(installed, 'gateway-bundle.mjs');
  const before = snapshot(installed);
  const platform = {};
  await afterPack({
    appOutDir, arch, electronPlatformName: 'darwin',
    packager: {
      platform, appInfo: { productFilename: 'LobsterAI' },
      info: { options: { targets: new Map([[platform, new Map([[Arch.universal, ['dmg']]])]]) } },
    },
  });
  expect(snapshot(installed)).toEqual(before);
});
