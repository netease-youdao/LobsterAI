import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, test } from 'vitest';

const {
  assertPopoPluginVersion,
  patchPopoBackgroundPrewarm,
  patchPopoFabricManager,
} = require('../scripts/openclaw-plugin-patches/popo.cjs');

function createFabricManagerFixture(filePath: string): void {
  fs.writeFileSync(filePath, [
    'var execCallCount = 0;',
    'var execCalls = [];',
    'var _cp2 = { execFile: (command, args, _options, callback) => {',
    '  execCallCount += 1;',
    '  execCalls.push({ command, args });',
    '  setTimeout(() => callback(null), 25);',
    '} };',
    'function getFabricCliTestOverrides() { return undefined; }',
    'var _isWin = globalThis.__popoFabricCliTestIsWin === true;',
    'var FABRIC_CLI_NPM_PACKAGE = "@fabric/cli";',
    'var FABRIC_CLI_NPM_REGISTRY = "https://npm.invalid";',
    'var INSTALL_TIMEOUT_MS = 6e4;',
    'var _CACHE_KEY = "__popo_fabricCliCache__";',
    'var _gCache = globalThis;',
    'if (!_gCache[_CACHE_KEY]) _gCache[_CACHE_KEY] = { checked: false, available: false };',
    'var _cache = _gCache[_CACHE_KEY];',
    'var logger = { info: () => {}, warn: () => {} };',
    'function ensureFabricCli(channel) {',
    '  if (_cache.checked) return _cache.available;',
    '  _cache.checked = true;',
    '  return Boolean(channel);',
    '}',
    'async function loadFabricSdk() { return {}; }',
    'async function sealAgentCtx() {',
    '  if (!ensureFabricCli()) {',
    '    return null;',
    '  }',
    '  return loadFabricSdk();',
    '}',
    'function getExecCallCount() { return execCallCount; }',
    'function getExecCalls() { return execCalls; }',
    'export { ensureFabricCli, getExecCallCount, getExecCalls, sealAgentCtx };',
    '',
  ].join('\n'));
}

describe('OpenClaw POPO plugin startup patches', () => {
  test('runs Fabric CLI maintenance asynchronously and shares the in-flight promise', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'popo-plugin-patch-'));
    const managerPath = path.join(tempDir, 'manager.mjs');
    createFabricManagerFixture(managerPath);

    patchPopoFabricManager(managerPath, () => {});
    patchPopoFabricManager(managerPath, () => {});

    const patched = fs.readFileSync(managerPath, 'utf8');
    expect(patched.match(/lobster_popo_async_fabric_cli/g)).toHaveLength(1);
    expect(patched).toContain('if (!await ensureFabricCli())');

    delete (globalThis as Record<string, unknown>).__popo_fabricCliCache__;
    delete (globalThis as Record<string, unknown>).__popo_fabricCliAsyncPromise__;
    (globalThis as Record<string, unknown>).__popoFabricCliTestIsWin = true;
    const moduleUrl = `${pathToFileURL(managerPath).href}?test=${Date.now()}`;
    const manager = await import(moduleUrl);
    const startedAt = Date.now();
    const first = manager.ensureFabricCli('test');
    const second = manager.ensureFabricCli('test');

    expect(Date.now() - startedAt).toBeLessThan(20);
    expect(second).toBe(first);
    await expect(first).resolves.toBe(true);
    expect(manager.getExecCallCount()).toBe(2);
    expect(manager.getExecCalls()).toEqual([
      {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', 'fabric "--help"'],
      },
      {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', 'fabric "upgrade" "-g" "--channel" "test"'],
      },
    ]);

    delete (globalThis as Record<string, unknown>).__popo_fabricCliCache__;
    delete (globalThis as Record<string, unknown>).__popo_fabricCliAsyncPromise__;
    delete (globalThis as Record<string, unknown>).__popoFabricCliTestIsWin;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('starts Fabric pre-warm without awaiting channel startup', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'popo-plugin-patch-'));
    const startupPath = path.join(tempDir, 'startup.js');
    fs.writeFileSync(startupPath, [
      'async function start(popoCfg, logFn) {',
      '  try {',
      '    const fabricCliChannel = popoCfg?.fabricCliChannel;',
      '    ensureFabricCli(fabricCliChannel);',
      '  } catch (e) {',
      '    logFn(`[POPO] fabric-cli pre-warm failed: ${e}`);',
      '  }',
      '}',
      '',
    ].join('\n'));

    patchPopoBackgroundPrewarm(startupPath, () => {});
    patchPopoBackgroundPrewarm(startupPath, () => {});

    const patched = fs.readFileSync(startupPath, 'utf8');
    expect(patched.match(/lobster_popo_background_fabric_prewarm/g)).toHaveLength(1);
    expect(patched).toContain('void ensureFabricCli(fabricCliChannel).catch');
    expect(patched).not.toContain('try {\n    const fabricCliChannel');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('fails closed when the pinned plugin version changes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'popo-plugin-patch-'));
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ version: '2.2.0' }));

    expect(() => assertPopoPluginVersion(tempDir)).toThrow(
      'moltbot-popo Fabric patch expects 2.1.13, found 2.2.0',
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
