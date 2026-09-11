import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const { verifyOpenClawPluginLoad, isolatedProbeEnv } = require('../scripts/verify-openclaw-plugin-load.cjs');
const tempDirs: string[] = [];
const hostTarget = `${{ win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform]}-${process.arch}`;

function fixture({ fallback = false, deferredFailure = false, setupFailure = false, deferredFallback = false, registryError = false, pluginId = 'fixture' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-load-gate-'));
  tempDirs.push(root);
  const runtime = path.join(root, 'runtime # 中文 %');
  const plugin = path.join(runtime, 'third-party-extensions/fixture');
  fs.mkdirSync(plugin, { recursive: true });
  fs.mkdirSync(path.join(runtime, 'dist/plugins'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(runtime, 'runtime-build-info.json'), JSON.stringify({
    target: hostTarget, openclawVersion: 'v2026.8.1', patchHash: 'fixture',
  }));
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({
    openclaw: { extensions: ['./index.cjs'], setupEntry: './setup.cjs' },
  }));
  fs.writeFileSync(path.join(plugin, 'openclaw.plugin.json'), JSON.stringify({ id: pluginId }));
  fs.writeFileSync(path.join(plugin, 'setup.cjs'), `module.exports = {
    loadSetupPlugin: () => ${setupFailure ? 'require("./missing-setup.cjs")' : '({ id: "fixture" })'},
  };`);
  fs.writeFileSync(path.join(plugin, 'index.cjs'), `module.exports = {
    loadChannelPlugin: () => {
      if (${deferredFallback}) require('../../dist/plugins/build-smoke-entry.js').markFallback();
      return ${deferredFailure ? 'require("./missing-channel.cjs")' : '({ id: "fixture" })'};
    },
  };`);
  // A minimal built-loader facade makes counter/registry failures deterministic;
  // the child still loads real on-disk runtime and deferred entries natively.
  fs.writeFileSync(path.join(runtime, 'dist/plugins/build-smoke-entry.js'), `
    let called = false;
    let earlyFallback = false;
    export function markFallback() { earlyFallback = true; }
    export function getPluginModuleLoaderStats() {
      return { calls: Number(called), nativeHits: Number(called), nativeMisses: 0,
        sourceTransformForced: 0, sourceTransformFallbacks: Number(earlyFallback || called && ${fallback}) };
    }
    export function loadPluginRegistryHandle(options) {
      if (process.env.OPENCLAW_CONFIG_PATH.indexOf(process.env.OPENCLAW_STATE_DIR) !== 0) throw new Error('state isolation');
      if (process.env.NODE_OPTIONS) throw new Error('inherited runtime options');
      if (options.activate === true || options.channelPluginLoadIntent !== 'full') throw new Error('invalid load mode');
      const modelConfig = options.config.plugins.entries['lobsterai-model-compat'];
      if (modelConfig && modelConfig.config?.modelProfiles?.['native-load-probe/kimi-k3'] !== 'moonshot-kimi-k3') {
        throw new Error('missing required model compatibility fixture');
      }
      called = true;
      return { plugins: options.onlyPluginIds.map(id => ({ id, status: '${registryError ? 'error' : 'loaded'}', error: 'fixture registry error' })) };
    }
  `);
  return { runtime, plugin };
}

afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('Unexpected fixture path');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('packaged plugin load gate', () => {
  test('loads runtime and setup entries and emits a relocatable verification manifest', () => {
    const { runtime } = fixture();
    const report = verifyOpenClawPluginLoad(runtime, { executable: process.execPath });
    expect(report.nativeVerified).toBe(true);
    expect(report.entries.map((entry: { kind: string }) => entry.kind)).toEqual(['runtime', 'setup']);
    expect(report.proof.counters.nativeHits).toBe(1);
    expect(report.proof.counters.sourceTransformFallbacks).toBe(0);
    for (const entry of report.entries) {
      expect(path.isAbsolute(entry.source)).toBe(false);
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test('supplies a valid isolated configuration for the required model compatibility schema', () => {
    const { runtime } = fixture({ pluginId: 'lobsterai-model-compat' });
    const report = verifyOpenClawPluginLoad(runtime, { executable: process.execPath });
    expect(report.proof.registry).toEqual([{ id: 'lobsterai-model-compat', status: 'loaded' }]);
  });

  test.each([
    [{ fallback: true }, 'did not stay native'],
    [{ deferredFailure: true }, 'missing-channel.cjs'],
    [{ setupFailure: true }, 'missing-setup.cjs'],
    [{ deferredFallback: true }, 'did not stay native'],
    [{ registryError: true }, 'fixture registry error'],
  ] as const)('blocks a broken build: %j', (options, message) => {
    const { runtime } = fixture(options);
    const marker = path.join(runtime, 'plugin-load-verification.json');
    fs.writeFileSync(marker, '{"oldSuccess":true}');
    expect(() => verifyOpenClawPluginLoad(runtime, { executable: process.execPath })).toThrow(message);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('removes stale proof even if static entry validation fails', () => {
    const { runtime, plugin } = fixture();
    const marker = path.join(runtime, 'plugin-load-verification.json');
    fs.writeFileSync(marker, '{}');
    fs.rmSync(path.join(plugin, 'setup.cjs'));
    expect(() => verifyOpenClawPluginLoad(runtime, { executable: process.execPath })).toThrow('Plugin entry not found');
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('cross builds identify static-only validation and still reject TypeScript entries', () => {
    const { runtime, plugin } = fixture();
    fs.writeFileSync(path.join(runtime, 'runtime-build-info.json'), '{"target":"other-architecture"}');
    expect(verifyOpenClawPluginLoad(runtime).nativeVerified).toBe(false);
    fs.renameSync(path.join(plugin, 'index.cjs'), path.join(plugin, 'index.ts'));
    fs.writeFileSync(path.join(plugin, 'package.json'), '{"openclaw":{"extensions":["./index.ts"]}}');
    expect(() => verifyOpenClawPluginLoad(runtime)).toThrow('not compiled JavaScript');
  });

  test('isolates credentials, user configuration, and module-transform options', () => {
    const env = isolatedProbeEnv('/isolated-state', '/runtime');
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(env.HOME).toBe('/isolated-state');
    expect(env.OPENCLAW_STATE_DIR).toBe('/isolated-state');
    expect(env.OPENCLAW_CONFIG_PATH).toBe(path.join('/isolated-state', 'openclaw.json'));
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(env.JITI_NATIVE_MODULES).toBeUndefined();
  });
});
