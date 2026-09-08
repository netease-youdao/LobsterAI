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
const { ensureOpenClawPluginSdkBridge, verifyOpenClawPluginSdkBridge } = require('../scripts/openclaw-plugin-sdk-bridge.cjs');
const { packSingleSource, packMultipleSources } = require('../scripts/pack-openclaw-tar.cjs');
const tempDirs: string[] = [];
const nativeRoots = ['dist/native', 'node_modules/@openclaw/fs-safe/dist/native'];
const sdkName = '@anthropic-ai/claude-agent-sdk';
const cuaName = '@trycua/cua-driver';
const controlUiManifest = 'dist/control-ui/asset-manifest.json';

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

async function fixture(): Promise<string> {
  const parent = tempDir();
  const root = path.join(parent, 'runtime');
  manifest(root, 'package.json', {
    name: 'openclaw', version: '2026.8.1', type: 'module',
    exports: { './plugin-sdk/core': './dist/plugin-sdk/core.js' },
  });
  manifest(root, 'runtime-build-info.json', { target: 'win-x64' });
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
    for (const target of ['win32-x64-msvc', 'darwin-arm64', 'linux-x64-gnu']) {
      write(root, `${nativeRoot}/${target}/fs-safe-native.node`);
    }
    write(root, `${nativeRoot}/metadata.json`, '{}');
  }
  for (const [name, version, nativeSuffix] of [
    [sdkName, '0.3.239', 'win32-x64'], [cuaName, '0.21.0', 'win32-x64-msvc'],
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
  'openclaw.mjs', 'dist/entry.js', 'dist/plugin-sdk/core.js', 'dist/control-ui/index.html',
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
