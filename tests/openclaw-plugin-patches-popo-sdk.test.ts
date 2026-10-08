import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

const { patchPopo, patchPopoSdkImports } = require('../scripts/openclaw-plugin-patches/popo.cjs');
const { ensureOpenClawPluginSdkBridge } = require('../scripts/openclaw-plugin-sdk-bridge.cjs');

const sdkFixture = fs.readFileSync(fileURLToPath(
  new URL('./fixtures/moltbot-popo-2.1.13-sdk.txt', import.meta.url),
), 'utf8');
const tempDirs: string[] = [];
const ProbeScenario = { Cold: 'cold', StatusPending: 'status-pending', AllPending: 'all-pending' } as const;
const sdkModules = {
  core: 'export const DEFAULT_ACCOUNT_ID = "default"; export const emptyPluginConfigSchema = () => ({ type: "object" });',
  'channel-core': 'export const defineSetupPluginEntry = (...args) => args;',
  'channel-status': 'export const PAIRING_APPROVED_MESSAGE = "approved";',
  'channel-reply-pipeline': [
    'export const state = { replies: [] };',
    'export function createChannelReplyPipeline(params) { state.replies.push(params); return { state, params }; }',
  ].join('\n'),
  'channel-feedback': 'export const logTypingFailure = (...args) => args;',
  'reply-history': [
    'export const DEFAULT_GROUP_HISTORY_LIMIT = 20;',
    'export const buildPendingHistoryContextFromMap = (params) => params;',
    'export const recordPendingHistoryEntryIfEnabled = (...args) => args;',
    'export const clearHistoryEntriesIfEnabled = (...args) => args;',
  ].join('\n'),
};
const publicExports = [
  'DEFAULT_ACCOUNT_ID', 'emptyPluginConfigSchema', 'defineSetupPluginEntry',
  'PAIRING_APPROVED_MESSAGE', 'createChannelReplyPipeline', 'logTypingFailure',
  'buildPendingHistoryContextFromMap', 'recordPendingHistoryEntryIfEnabled',
  'clearHistoryEntriesIfEnabled', 'DEFAULT_GROUP_HISTORY_LIMIT',
];
const adjacentSource = '// src/stomp-client.ts\nexport const unrelated = "preserved";\n';

function writeFile(root: string, relativePath: string, content: string): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function createFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'popo-sdk-patch-')));
  tempDirs.push(root);
  writeFile(root, 'package.json', JSON.stringify({
    name: 'openclaw', version: '2026.8.1', type: 'module',
    exports: Object.fromEntries(Object.keys(sdkModules).map(subpath => [
      `./plugin-sdk/${subpath}`, `./dist/plugin-sdk/${subpath}.js`,
    ])),
  }));
  for (const [subpath, source] of Object.entries(sdkModules)) {
    writeFile(root, `dist/plugin-sdk/${subpath}.js`, source);
  }
  ensureOpenClawPluginSdkBridge(root);
  const pluginDir = path.join(root, 'third-party-extensions/moltbot-popo');
  writeFile(pluginDir, 'package.json', JSON.stringify({ name: 'moltbot-popo', version: '2.1.13', type: 'module' }));
  const entry = writeFile(pluginDir, 'dist/sdk-fixture.js',
    `${sdkFixture}\n${adjacentSource}export { ${publicExports.join(', ')} };\n`);
  const probe = writeFile(root, 'probe.cjs', `
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const hostRequire = createRequire(path.join(__dirname, 'dist/plugins/loader.js'));
async function main() {
  const scenario = process.argv[2];
  const subpaths = scenario === ${JSON.stringify(ProbeScenario.AllPending)}
    ? ${JSON.stringify(Object.keys(sdkModules))}
    : scenario === ${JSON.stringify(ProbeScenario.StatusPending)} ? ['channel-status'] : [];
  const pending = Promise.all(subpaths.map(subpath =>
    import(pathToFileURL(hostRequire.resolve('openclaw/plugin-sdk/' + subpath)).href)));
  try {
    const plugin = hostRequire(path.join(__dirname, 'third-party-extensions/moltbot-popo/dist/sdk-fixture.js'));
    const params = { text: 'reply' };
    const history = new Map();
    assert.equal(plugin.DEFAULT_ACCOUNT_ID, 'default');
    assert.deepEqual(plugin.emptyPluginConfigSchema(), { type: 'object' });
    assert.deepEqual(plugin.defineSetupPluginEntry(params, 'setup'), [params, 'setup']);
    assert.equal(plugin.PAIRING_APPROVED_MESSAGE, 'approved');
    const pipeline = plugin.createChannelReplyPipeline(params);
    const host = hostRequire('openclaw/plugin-sdk/channel-reply-pipeline');
    assert.strictEqual(pipeline.state, host.state);
    assert.strictEqual(pipeline.params, params);
    assert.deepEqual(host.state.replies, [params]);
    assert.deepEqual(plugin.logTypingFailure('popo', params), ['popo', params]);
    assert.strictEqual(plugin.buildPendingHistoryContextFromMap(history), history);
    assert.deepEqual(plugin.recordPendingHistoryEntryIfEnabled(history, params), [history, params]);
    assert.deepEqual(plugin.clearHistoryEntriesIfEnabled(history, 'session'), [history, 'session']);
    assert.equal(plugin.DEFAULT_GROUP_HISTORY_LIMIT, 20);
    assert.equal(plugin.unrelated, 'preserved');
    console.log(JSON.stringify({ ok: true, node: process.versions.node }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, code: error.code, message: error.message }));
    process.exitCode = 1;
  } finally {
    await pending;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`);
  return { root, pluginDir, entry, probe };
}

function runProbe(executable: string, probe: string, scenario: string) {
  return spawnSync(executable, [probe, scenario], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '', NODE_PATH: '' },
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const runtimes = [
  { name: 'Node', executable: process.execPath },
  ...(process.platform === 'win32' ? [{ name: 'Electron', executable: require('electron') as string }] : []),
];

describe.each(runtimes)('POPO SDK loading with $name', ({ executable }) => {
  test('reproduces the original SDK loading race in a fresh process', () => {
    const { probe } = createFixture();
    const result = runProbe(executable, probe, ProbeScenario.StatusPending);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      message: expect.stringContaining('channel-status.js because it is not yet fully loaded'),
    });
  });

  test.each(Object.values(ProbeScenario))('links the SDK safely for %s and shares host state', (scenario) => {
    const { entry, probe } = createFixture();
    patchPopoSdkImports(entry, () => {});
    const result = runProbe(executable, probe, scenario);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
  });
});

test('applies through the plugin preparation entry point and remains idempotent', () => {
  const { root, entry, pluginDir } = createFixture();
  writeFile(pluginDir, 'dist/fabric-fixture.js', [
    '// src/fabric-cli-manager.ts',
    'function ensureFabricCli(channel) {\n  return Boolean(channel);\n}',
    'async function loadFabricSdk() {}',
    'async function sealAgentCtx() {',
    '  if (!ensureFabricCli()) { return null; }',
    '}',
  ].join('\n'));
  writeFile(pluginDir, 'dist/monitor-fixture.js', [
    '// [POPO] Starting monitor',
    'async function start(popoCfg, logFn) {',
    '  try {',
    '    const fabricCliChannel = popoCfg?.fabricCliChannel;',
    '    ensureFabricCli(fabricCliChannel);',
    '  } catch (e) {',
    '    logFn(`[POPO] fabric-cli pre-warm failed: ${e}`);',
    '  }',
    '}',
  ].join('\n'));
  const context = { runtimeExtensionsDir: path.join(root, 'third-party-extensions'), log: () => {} };
  patchPopo(context);
  const firstPass = fs.readFileSync(entry, 'utf8');
  patchPopo(context);
  expect(fs.readFileSync(entry, 'utf8')).toBe(firstPass);
  expect(firstPass).toContain(adjacentSource);
  expect(firstPass).not.toContain('createRequire');
  expect(runProbe(process.execPath, path.join(root, 'probe.cjs'), ProbeScenario.AllPending).status).toBe(0);
});

test.each([
  { name: 'missing boundary', change: (source: string) => source.replace('// src/stomp-client.ts', '// moved section') },
  { name: 'unknown helper', change: (source: string) => source.replace('// src/stomp-client.ts', 'var newSdkHelper = () => {};\n// src/stomp-client.ts') },
  { name: 'changed SDK subpath', change: (source: string) => source.replace('requireSdk("channel-status")', 'requireSdk("new-status")') },
  { name: 'duplicate facade', change: (source: string) => source + source },
])('rejects a $name without rewriting the plugin', ({ change }) => {
  const { entry } = createFixture();
  const source = change(fs.readFileSync(entry, 'utf8'));
  fs.writeFileSync(entry, source);
  expect(() => patchPopoSdkImports(entry, () => {})).toThrow();
  expect(fs.readFileSync(entry, 'utf8')).toBe(source);
});

test('supports CRLF bundles without changing adjacent source', () => {
  const { entry, probe } = createFixture();
  fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replace(/\r?\n/g, '\r\n'));
  patchPopoSdkImports(entry, () => {});
  const patched = fs.readFileSync(entry, 'utf8');
  patchPopoSdkImports(entry, () => {});
  expect(fs.readFileSync(entry, 'utf8')).toBe(patched);
  expect(patched).toContain(adjacentSource.replace(/\n/g, '\r\n'));
  expect(runProbe(process.execPath, probe, ProbeScenario.StatusPending).status).toBe(0);
});
