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
// The exact helper written by the previous release, retained as an upgrade fixture.
const nativeRequireV1 = `// LobsterAI: nsp-clawguard 2.5.0 native require compatibility v1.
import { createRequire as __lobsteraiNspCreateRequire } from 'node:module';
var __require = __lobsteraiNspCreateRequire(import.meta.url);`;
const legacyRequire = pluginSource.slice(0, pluginSource.indexOf('\nconst fs'));
const startupSource = pluginSource.replace(
  "export default function register(api) { api.on('before_tool_call', () => {}); }",
  `export default function register(api) {
  api.on('gateway_start', async () => {
    // SQL.js first touches these paths asynchronously, after registration.
    await Promise.resolve();
    const result = { dirname: __dirname, filename: __filename, bytes: fs.readFileSync(__filename).length };
    fs.writeFileSync(__require('node:path').join(__dirname, 'startup-result.json'), JSON.stringify(result));
  });
}`,
);

const roots: string[] = [];
function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-nsp-compat-'));
  roots.push(root);
  return root;
}

function createPlugin(root: string, inStateDir = false, release: typeof NSP_CLAWGUARD.Releases[number] = NSP_CLAWGUARD.Releases[1]): string {
  const pluginDir = path.join(root, inStateDir ? 'state/extensions' : 'third-party-extensions', NSP_CLAWGUARD.Id);
  fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
    name: NSP_CLAWGUARD.Id,
    version: release.version,
    main: NSP_CLAWGUARD.Entry,
    type: 'module',
    openclaw: { extensions: [NSP_CLAWGUARD.Entry] },
  }));
  fs.writeFileSync(path.join(pluginDir, 'openclaw.plugin.json'), JSON.stringify({
    id: NSP_CLAWGUARD.Id,
    version: release.manifestVersion,
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

test.each(NSP_CLAWGUARD.Releases.flatMap(release => [false, true].map(inStateDir => ({ release, inStateDir }))))(
  'patches $release.version (state directory: $inStateDir) with a byte-exact backup', ({ release, inStateDir }) => {
  const root = createRoot();
  const entry = createPlugin(root, inStateDir, release);
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

describe.each(NSP_CLAWGUARD.Releases)('runtime require compatibility $version', release => {
  test.each([false, true])('preserves registration and host fs.closeSync (interop proxy: %s)', interopProxy => {
    const root = createRoot();
    const entry = createPlugin(root, false, release);
    expect(() => runPlugin(entry, interopProxy)).toThrow(
      interopProxy ? /Cannot read properties of undefined/ : /Dynamic require/,
    );
    expect(patch(root)).toBe(true);
    expect(JSON.parse(runPlugin(entry, interopProxy))).toEqual({ closed: 0, hooks: ['before_tool_call'] });
  });
});

test.each(NSP_CLAWGUARD.Releases.flatMap(release => [false, true].map(previouslyPatched => ({ release, previouslyPatched }))))(
  'initializes $release.version async startup in a decoded module directory (previous v1: $previouslyPatched)', ({ release, previouslyPatched }) => {
  const root = path.join(createRoot(), '插件 #100%');
  const entry = createPlugin(root, false, release);
  const original = previouslyPatched ? startupSource.replace(legacyRequire, nativeRequireV1) : startupSource;
  fs.writeFileSync(entry, original);
  const runStartup = () => execFileSync(process.execPath, ['--input-type=module', '--eval', `
    (async () => {
      const plugin = await import(${JSON.stringify(pathToFileURL(entry).href)});
      let startup;
      plugin.default({ on: (name, callback) => { if (name === 'gateway_start') startup = callback; } });
      await startup();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: 'utf8', windowsHide: true, stdio: 'pipe', timeout: 10_000 });
  expect(runStartup).toThrow(previouslyPatched ? /__dirname is not defined/ : /Dynamic require/);

  // Keep the previous release's pristine backup when upgrading its helper.
  const previousBackup = `${entry}.lobsterai-native-require-v1.original.bak`;
  if (previouslyPatched) fs.writeFileSync(previousBackup, startupSource);
  expect(patch(root)).toBe(true);
  expect(runStartup).not.toThrow();
  expect(JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'startup-result.json'), 'utf8'))).toEqual({
    dirname: path.dirname(entry), filename: entry, bytes: fs.statSync(entry).size,
  });
  const backups = fs.readdirSync(path.dirname(entry)).filter(name => name.includes('.lobsterai-native-module-v2.'));
  expect(backups).toHaveLength(1);
  expect(fs.readFileSync(path.join(path.dirname(entry), backups[0]), 'utf8')).toBe(original);
  if (previouslyPatched) expect(fs.readFileSync(previousBackup, 'utf8')).toBe(startupSource);
  const patchedStat = fs.statSync(entry);
  expect(patch(root)).toBe(false);
  expect(fs.statSync(entry).mtimeMs).toBe(patchedStat.mtimeMs);
});

test.each([
  `${nativeRequireV1}\n${pluginSource}`,
  `${nativeRequireV1}\n${nativeRequireV1}`,
  `${pluginSource}\nconst __dirname = '/custom';`,
  `${pluginSource}\nconst __filename = '/custom/index.mjs';`,
])('does not inject a module context into conflicting or already modified source %#', source => {
  const root = createRoot();
  const entry = createPlugin(root);
  fs.writeFileSync(entry, source);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(patch(root)).toBe(false);
  expect(fs.readFileSync(entry, 'utf8')).toBe(source);
  expect(fs.readdirSync(path.dirname(entry))).toEqual(['index.mjs']);
});

test.each([false, true])('retains CRLF line endings (previous v1 patch: %s)', previouslyPatched => {
  const root = createRoot();
  const entry = createPlugin(root);
  const original = previouslyPatched ? pluginSource.replace(legacyRequire, nativeRequireV1) : pluginSource;
  fs.writeFileSync(entry, original.replace(/\n/g, '\r\n'));
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

test.each([
  ['2.4.13', '2.4.13'], ['2.5.0', '2.4.12'], ['2.4.12', '2.4.12'],
])('rejects an unpublished package/manifest pair %s / %s', (version, manifestVersion) => {
  const root = createRoot();
  const entry = createPlugin(root);
  const pluginDir = path.dirname(path.dirname(entry));
  for (const [file, value] of [['package.json', version], ['openclaw.plugin.json', manifestVersion]]) {
    const filePath = path.join(pluginDir, file);
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    fs.writeFileSync(filePath, JSON.stringify({ ...json, version: value }));
  }
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(patch(root)).toBe(false);
  expect(fs.readFileSync(entry, 'utf8')).toBe(pluginSource);
});

test('does not turn an unknown 2.4.13 async registration into a synchronous function', () => {
  const root = createRoot();
  const entry = createPlugin(root, false, NSP_CLAWGUARD.Releases[0]);
  const source = `${legacyRequire}\nasync function register(api) { await Promise.resolve(); api.on('gateway_start', () => {}); }\nexport {\n  register as default\n};`;
  fs.writeFileSync(entry, source);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(patch(root)).toBe(false);
  expect(fs.readFileSync(entry, 'utf8')).toBe(source);
  expect(fs.readdirSync(path.dirname(entry))).toEqual(['index.mjs']);
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
