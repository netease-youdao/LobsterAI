import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { SDK_BRIDGE_LOCATION, ensureOpenClawPluginSdkBridge, verifyOpenClawPluginSdkBridge } =
  require('../scripts/openclaw-plugin-sdk-bridge.cjs');
const { HOST_PEER_PACKAGE_NAME, pruneHostPeerLeftovers, collectHostPeerLeftovers } =
  require('../scripts/openclaw-plugin-host-peer-leftovers.cjs');
const { packMultipleSources, packSingleSource } = require('../scripts/pack-openclaw-tar.cjs');
const tar = require('tar');
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-sdk-bridge-'));
  tempDirs.push(dir);
  return dir;
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture(): string {
  const runtime = path.join(tempDir(), 'runtime');
  write(path.join(runtime, 'package.json'), JSON.stringify({
    name: HOST_PEER_PACKAGE_NAME, version: '2026.8.1', type: 'module',
    exports: {
      '.': './dist/index.js',
      './plugin-sdk/core': { types: './dist/plugin-sdk/core.d.ts', default: './dist/plugin-sdk/core.js' },
      './plugin-sdk/channel-outbound': './dist/plugin-sdk/channel-outbound.js',
      './plugin-sdk/default-value': { default: './dist/plugin-sdk/default-value.js' },
    },
  }));
  write(path.join(runtime, 'dist/plugin-sdk/core.js'), 'export const state = { calls: 0 }; export let count = 0; export function increment() { state.calls++; count++; }');
  write(path.join(runtime, 'dist/plugin-sdk/channel-outbound.js'), 'export * from "./core.js";');
  write(path.join(runtime, 'dist/plugin-sdk/default-value.js'), 'export { state as default } from "./core.js";');
  const plugin = path.join(runtime, 'third-party-extensions/discord');
  write(path.join(plugin, 'package.json'), JSON.stringify({ name: '@openclaw/discord', type: 'module' }));
  write(path.join(plugin, 'setup.cjs'), 'exports.collectPreviewWarnings = async () => (await import("./doctor.mjs")).check();');
  write(path.join(plugin, 'doctor.mjs'), [
    'import * as sdk from "openclaw/plugin-sdk/channel-outbound";',
    'import defaultValue from "openclaw/plugin-sdk/default-value";',
    'import * as host from "../../dist/plugin-sdk/core.js";',
    'export function check() { sdk.increment(); return sdk.state === host.state && defaultValue === host.state && host.count === sdk.count && sdk.count === 1; }',
  ].join('\n'));
  write(path.join(plugin, 'probe.cjs'), [
    'const assert = require("node:assert/strict");',
    'const setup = require("./setup.cjs");',
    'setImmediate(async () => {',
    '  try {',
    '    assert.equal(await setup.collectPreviewWarnings(), true);',
    '    const required = require("openclaw/plugin-sdk/core");',
    '    const host = await import("../../dist/plugin-sdk/core.js");',
    '    assert.equal(required.state, host.state);',
    '    assert.deepEqual(Object.keys(required), Object.keys(host));',
    '    console.log("native-sdk-ok");',
    '  } catch (error) { console.error(error); process.exitCode = 1; }',
    '});',
  ].join('\n'));
  return runtime;
}

function probe(runtime: string) {
  return spawnSync(process.execPath, [path.join(runtime, 'third-party-extensions/discord/probe.cjs')], {
    cwd: runtime,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('restores native delayed doctor imports and require without hooks or private host peers', () => {
  const runtime = fixture();
  expect(probe(runtime).stderr).toContain('ERR_MODULE_NOT_FOUND');
  const result = ensureOpenClawPluginSdkBridge(runtime);
  expect(result.exportCount).toBe(3);
  expect(result.bytes).toBeLessThan(2000);
  const fixed = probe(runtime);
  expect(fixed.stderr).toBe('');
  expect(fixed.status).toBe(0);
  expect(fixed.stdout.trim()).toBe('native-sdk-ok');
  const plugin = path.join(runtime, 'third-party-extensions/discord');
  expect(fs.existsSync(path.join(plugin, SDK_BRIDGE_LOCATION))).toBe(false);
  expect(collectHostPeerLeftovers(plugin)).toEqual([]);
});

test.each(['single', 'combined'])('survives %s tar packing and relocation without duplicating the host', mode => {
  const runtime = fixture();
  const plugin = path.join(runtime, 'third-party-extensions/discord');
  // Removing a duplicate host remains compatible with the shared SDK bridge.
  write(path.join(plugin, SDK_BRIDGE_LOCATION, 'package.json'), JSON.stringify({ name: HOST_PEER_PACKAGE_NAME }));
  write(path.join(plugin, SDK_BRIDGE_LOCATION, 'large.bin'), 'unused host'.repeat(10000));
  pruneHostPeerLeftovers(plugin);
  ensureOpenClawPluginSdkBridge(runtime);
  const archive = path.join(tempDir(), 'runtime.tar');
  if (mode === 'single') packSingleSource(runtime, archive, 'cfmind');
  else packMultipleSources([{ dir: runtime, prefix: 'cfmind' }], archive);
  const entries: string[] = [];
  tar.list({ file: archive, sync: true, onentry: (entry: { path: string; type: string }) => {
    expect(entry.type).not.toBe('SymbolicLink');
    entries.push(entry.path);
  } });
  expect(entries.filter(entry => entry.endsWith('/dist/plugin-sdk/core.js'))).toHaveLength(1);
  expect(entries.some(entry => entry.includes('large.bin'))).toBe(false);
  expect(fs.statSync(archive).size).toBeLessThan(30000);
  const destination = path.join(tempDir(), '安装目录 with spaces #');
  fs.mkdirSync(destination);
  tar.extract({ file: archive, cwd: destination, sync: true });
  // The old location is gone: references must be relative to the installed host.
  fs.renameSync(runtime, `${runtime}-old`);
  const relocated = path.join(destination, 'cfmind');
  verifyOpenClawPluginSdkBridge(relocated);
  const result = probe(relocated);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});

test('is idempotent and refreshes SDK exports after a host upgrade', () => {
  const runtime = fixture();
  ensureOpenClawPluginSdkBridge(runtime);
  expect(ensureOpenClawPluginSdkBridge(runtime).changed).toBe(false);
  const manifestPath = path.join(runtime, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete manifest.exports['./plugin-sdk/default-value'];
  manifest.version = '2026.8.2';
  write(manifestPath, JSON.stringify(manifest));
  expect(() => verifyOpenClawPluginSdkBridge(runtime)).toThrow('stale');
  expect(ensureOpenClawPluginSdkBridge(runtime).changed).toBe(true);
  expect(fs.existsSync(path.join(runtime, SDK_BRIDGE_LOCATION, 'plugin-sdk/default-value.js'))).toBe(false);
  verifyOpenClawPluginSdkBridge(runtime);
});

test('packaging validation rejects missing and modified bridges', () => {
  const runtime = fixture();
  fs.mkdirSync(path.join(runtime, 'node_modules'));
  expect(() => verifyOpenClawPluginSdkBridge(runtime)).toThrow('missing or stale');
  ensureOpenClawPluginSdkBridge(runtime);
  write(path.join(runtime, SDK_BRIDGE_LOCATION, 'plugin-sdk/core.js'), 'export {};');
  expect(() => verifyOpenClawPluginSdkBridge(runtime)).toThrow('missing or stale');
});

test('fails if the host SDK target is missing instead of packaging a broken reference', () => {
  const runtime = fixture();
  fs.unlinkSync(path.join(runtime, 'dist/plugin-sdk/core.js'));
  expect(() => ensureOpenClawPluginSdkBridge(runtime)).toThrow('Missing or external SDK target');
  expect(fs.existsSync(path.join(runtime, SDK_BRIDGE_LOCATION))).toBe(false);
});

test.each(['../external.js', './dist/plugin-sdk/../../external.js', { import: './dist/plugin-sdk/core.js' }])(
  'rejects unsupported export targets and conditions: %j', target => {
    const runtime = fixture();
    const manifestPath = path.join(runtime, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.exports['./plugin-sdk/core'] = target;
    write(manifestPath, JSON.stringify(manifest));
    expect(() => ensureOpenClawPluginSdkBridge(runtime)).toThrow(/Invalid SDK target|Unsupported SDK export/);
  },
);

test('refuses to overwrite an unmanaged host package', () => {
  const runtime = fixture();
  const original = JSON.stringify({ name: HOST_PEER_PACKAGE_NAME, version: 'user-owned' });
  const manifest = path.join(runtime, SDK_BRIDGE_LOCATION, 'package.json');
  write(manifest, original);
  expect(() => ensureOpenClawPluginSdkBridge(runtime)).toThrow('unmanaged host package');
  expect(fs.readFileSync(manifest, 'utf8')).toBe(original);
});

test('refuses a host junction instead of letting packaging expand the runtime recursively', () => {
  const runtime = fixture();
  fs.mkdirSync(path.join(runtime, 'node_modules'));
  const external = tempDir();
  write(path.join(external, 'keep.txt'), 'keep');
  fs.symlinkSync(external, path.join(runtime, SDK_BRIDGE_LOCATION), 'junction');
  expect(() => ensureOpenClawPluginSdkBridge(runtime)).toThrow('host link');
  expect(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8')).toBe('keep');
});
