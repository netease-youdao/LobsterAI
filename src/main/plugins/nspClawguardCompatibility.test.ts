import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { NSP_CLAWGUARD, patchEnabledNspClawguard } from './nspClawguardCompatibility';

// Published esbuild helper plus the minimal graceful-fs failure mechanism.
// Run this in a child process: the bug modifies the shared native fs object.
const pluginSource = `var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
const fs = __require('fs');
const queueKey = Symbol.for('graceful-fs.queue');
const queue = [];
Object.defineProperty(fs, queueKey, { get: () => queue });
const closeSync = fs.closeSync;
fs.closeSync = function(fd) {
  closeSync(fd);
  return fs[queueKey].length;
};
export default function register(api) { api.on('before_tool_call', () => {}); }
`;

const roots: string[] = [];
function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-nsp-compat-'));
  roots.push(root);
  return root;
}

function createPlugin(root: string, inStateDir = false): string {
  const pluginDir = path.join(root, inStateDir ? 'state/extensions' : 'third-party-extensions', NSP_CLAWGUARD.Id);
  fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
    name: NSP_CLAWGUARD.Id,
    version: NSP_CLAWGUARD.SupportedVersion,
    main: NSP_CLAWGUARD.Entry,
    type: 'module',
    openclaw: { extensions: [NSP_CLAWGUARD.Entry] },
  }));
  fs.writeFileSync(path.join(pluginDir, 'openclaw.plugin.json'), JSON.stringify({
    id: NSP_CLAWGUARD.Id,
    version: NSP_CLAWGUARD.SupportedVersion,
  }));
  const entryPath = path.join(pluginDir, NSP_CLAWGUARD.Entry);
  fs.writeFileSync(entryPath, pluginSource);
  return entryPath;
}

function patch(root: string, enabled = true): boolean {
  return patchEnabledNspClawguard({
    plugins: [{ pluginId: NSP_CLAWGUARD.Id, enabled }],
    userDataDir: root,
    stateDir: path.join(root, 'state'),
  });
}

function runPlugin(entryPath: string, interopProxy: boolean): string {
  return execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(pathToFileURL(entryPath).href)});
    const fs = require('node:fs');
    if (${interopProxy}) {
      globalThis.require = (id) => id === 'fs'
        ? new Proxy(fs, { get: (target, key) => typeof key === 'symbol' ? undefined : target[key] })
        : require(id);
    }
    const plugin = await import(${JSON.stringify(pathToFileURL(entryPath).href)});
    const hooks = [];
    plugin.default({ on: name => hooks.push(name) });
    const fd = fs.openSync(${JSON.stringify(entryPath)}, 'r');
    console.log(JSON.stringify({ closed: fs.closeSync(fd), hooks }));
  `], { encoding: 'utf8', windowsHide: true, stdio: 'pipe', timeout: 10_000 });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('without an enabled plugin, performs no plugin filesystem operations or installation', () => {
  const root = createRoot();
  const exists = vi.spyOn(fs, 'existsSync');
  const read = vi.spyOn(fs, 'readFileSync');
  const mkdir = vi.spyOn(fs, 'mkdirSync');
  const write = vi.spyOn(fs, 'writeFileSync');
  for (const plugins of [[], [{ pluginId: 'another-plugin', enabled: true }], [{ pluginId: NSP_CLAWGUARD.Id, enabled: false }]]) {
    expect(patchEnabledNspClawguard({ plugins, userDataDir: root, stateDir: path.join(root, 'state') })).toBe(false);
  }
  expect(exists).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(mkdir).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(fs.readdirSync(root)).toEqual([]);
});

test('disabled installed plugin stays untouched until enabled; disabling later keeps the patch inert', () => {
  const root = createRoot();
  const entry = createPlugin(root);
  const originalStat = fs.statSync(entry);
  expect(patch(root, false)).toBe(false);
  expect(fs.readFileSync(entry, 'utf8')).toBe(pluginSource);
  expect(fs.statSync(entry).mtimeMs).toBe(originalStat.mtimeMs);
  expect(fs.readdirSync(path.dirname(entry))).toEqual(['index.mjs']);

  expect(patch(root)).toBe(true);
  const patched = fs.readFileSync(entry, 'utf8');
  expect(patch(root, false)).toBe(false);
  expect(fs.readFileSync(entry, 'utf8')).toBe(patched);
});

test.each([false, true])('patches a supported enabled installation (state directory: %s) with a byte-exact backup', inStateDir => {
  const root = createRoot();
  const entry = createPlugin(root, inStateDir);
  const manifest = path.join(path.dirname(path.dirname(entry)), 'openclaw.plugin.json');
  const originalManifest = fs.readFileSync(manifest);
  expect(patch(root)).toBe(true);
  const patched = fs.readFileSync(entry, 'utf8');
  expect(patched).toContain('var __require = __lobsteraiNspCreateRequire(import.meta.url);');
  expect(fs.readFileSync(manifest)).toEqual(originalManifest);
  const backups = fs.readdirSync(path.dirname(entry)).filter(name => name.endsWith('.bak'));
  expect(backups).toHaveLength(1);
  expect(fs.readFileSync(path.join(path.dirname(entry), backups[0]), 'utf8')).toBe(pluginSource);
  const patchedStat = fs.statSync(entry);
  expect(patch(root)).toBe(false);
  expect(fs.statSync(entry).mtimeMs).toBe(patchedStat.mtimeMs);
  expect(fs.readFileSync(entry, 'utf8')).toBe(patched);

  // A reinstall/update restores the published bundle. Reapply using the same
  // original backup, while a disabled update must wait until the next enable.
  fs.writeFileSync(entry, pluginSource);
  expect(patch(root, false)).toBe(false);
  expect(patch(root)).toBe(true);
  expect(fs.readFileSync(entry, 'utf8')).toBe(patched);
  expect(fs.readdirSync(path.dirname(entry)).filter(name => name.endsWith('.bak'))).toEqual(backups);
});

describe('runtime require compatibility', () => {
  test.each([false, true])('preserves registration and host fs.closeSync (interop proxy: %s)', interopProxy => {
    const root = createRoot();
    const entry = createPlugin(root);
    expect(() => runPlugin(entry, interopProxy)).toThrow(
      interopProxy ? /Cannot read properties of undefined/ : /Dynamic require/,
    );
    expect(patch(root)).toBe(true);
    expect(JSON.parse(runPlugin(entry, interopProxy))).toEqual({ closed: 0, hooks: ['before_tool_call'] });
  });
});

test('retains CRLF line endings', () => {
  const root = createRoot();
  const entry = createPlugin(root);
  fs.writeFileSync(entry, pluginSource.replace(/\n/g, '\r\n'));
  expect(patch(root)).toBe(true);
  expect(fs.readFileSync(entry, 'utf8').replace(/\r\n/g, '')).not.toContain('\n');
});

test.each(['version', 'identity', 'entry', 'source'])('leaves unsupported plugin %s unchanged', field => {
  const root = createRoot();
  const entry = createPlugin(root);
  const pkgPath = path.join(path.dirname(path.dirname(entry)), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (field === 'version') pkg.version = '2.6.0';
  if (field === 'identity') pkg.name = 'another-plugin';
  if (field === 'entry') pkg.openclaw.extensions = ['./another-entry.mjs'];
  if (field === 'source') fs.writeFileSync(entry, 'export default function register() {}\n');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  const original = fs.readFileSync(entry);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(patch(root)).toBe(false);
  expect(fs.readFileSync(entry)).toEqual(original);
  expect(fs.readdirSync(path.dirname(entry))).toEqual(['index.mjs']);
});

test('does not recreate a missing installation from a stale enabled record', () => {
  const root = createRoot();
  expect(patch(root)).toBe(false);
  expect(fs.readdirSync(root)).toEqual([]);
});

test('does not follow a plugin junction into an external installation', () => {
  const root = createRoot();
  const external = createRoot();
  const entry = createPlugin(external);
  const pluginDir = path.dirname(path.dirname(entry));
  fs.mkdirSync(path.join(root, 'third-party-extensions'));
  fs.symlinkSync(pluginDir, path.join(root, 'third-party-extensions', NSP_CLAWGUARD.Id), 'junction');
  expect(patch(root)).toBe(false);
  expect(fs.readFileSync(entry, 'utf8')).toBe(pluginSource);
});

test('an atomic replacement failure retains the original and backup and cleans up the temporary file', () => {
  const root = createRoot();
  const entry = createPlugin(root);
  const error = new Error('simulated replacement failure');
  vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw error; });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(patch(root)).toBe(false);
  expect(fs.readFileSync(entry, 'utf8')).toBe(pluginSource);
  const files = fs.readdirSync(path.dirname(entry));
  expect(files).toHaveLength(2);
  expect(files.some(name => name.endsWith('.tmp'))).toBe(false);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('[PluginCompatibility]'), error);
});

test('uses the existing Windows file replacement fallback when rename-over-existing is denied', () => {
  const root = createRoot();
  const entry = createPlugin(root);
  vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw Object.assign(new Error('simulated Windows rename restriction'), { code: 'EPERM' });
  });
  expect(patch(root)).toBe(true);
  expect(JSON.parse(runPlugin(entry, true))).toEqual({ closed: 0, hooks: ['before_tool_call'] });
  expect(fs.readdirSync(path.dirname(entry))).toHaveLength(2);
});

test('refuses to overwrite a mismatched existing backup', () => {
  const root = createRoot();
  const entry = createPlugin(root);
  expect(patch(root)).toBe(true);
  const backupName = fs.readdirSync(path.dirname(entry)).find(name => name.endsWith('.bak'))!;
  fs.writeFileSync(path.join(path.dirname(entry), backupName), 'different backup');
  fs.writeFileSync(entry, pluginSource);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(patch(root)).toBe(false);
  expect(fs.readFileSync(entry, 'utf8')).toBe(pluginSource);
  expect(fs.readFileSync(path.join(path.dirname(entry), backupName), 'utf8')).toBe('different backup');
});

test('patches both supported install locations without touching another plugin or the enabled state', () => {
  const root = createRoot();
  const userEntry = createPlugin(root);
  const stateEntry = createPlugin(root, true);
  const otherEntry = path.join(root, 'third-party-extensions/another-plugin/index.mjs');
  fs.mkdirSync(path.dirname(otherEntry));
  fs.writeFileSync(otherEntry, pluginSource);
  const plugins = Object.freeze([Object.freeze({ pluginId: NSP_CLAWGUARD.Id, enabled: true })]);
  expect(patchEnabledNspClawguard({ plugins, userDataDir: root, stateDir: path.join(root, 'state') })).toBe(true);
  expect(fs.readFileSync(userEntry)).toEqual(fs.readFileSync(stateEntry));
  expect(fs.readFileSync(otherEntry, 'utf8')).toBe(pluginSource);
  expect(fs.readdirSync(path.dirname(otherEntry))).toEqual(['index.mjs']);
  expect(plugins[0].enabled).toBe(true);
});
