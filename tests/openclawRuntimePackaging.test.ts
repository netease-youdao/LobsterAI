import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  pruneBareDistAfterGatewayPack,
  pruneGatewayAsarStage,
  resolvePreinstalledPluginDir,
  summarizeGatewayAsarEntries,
  verifyRuntimeBundledPlugin,
} = require('../scripts/openclaw-runtime-packaging.cjs');
const { openclaw } = require('../package.json');
const { shouldKeepBundledExtension } = require('../scripts/prune-openclaw-runtime.cjs');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test('only Discord opts into the official runtime-bundled preinstall layout', () => {
  expect(openclaw.plugins.filter((plugin: { runtimeBundled?: boolean }) => plugin.runtimeBundled === true))
    .toEqual([{ id: 'discord', npm: '@openclaw/discord', version: '2026.8.1', runtimeBundled: true }]);
  for (const plugin of openclaw.plugins) {
    if (plugin.runtimeBundled === true) expect(shouldKeepBundledExtension(plugin.id)).toBe(true);
    expect(resolvePreinstalledPluginDir('/runtime', plugin)).toBe(path.join('/runtime',
      plugin.runtimeBundled === true ? 'dist/extensions' : 'third-party-extensions', plugin.id));
  }
});

test('rejects unreviewed package names and escaping directory ids for trusted preinstalls', () => {
  expect(() => resolvePreinstalledPluginDir('/runtime', {
    id: 'discord', npm: 'unofficial-discord', runtimeBundled: true,
  })).toThrow('official @openclaw package');
  expect(() => resolvePreinstalledPluginDir('/runtime', {
    id: '../discord', npm: '@openclaw/discord', runtimeBundled: true,
  })).toThrow('directory id');
});

test('validates the shipped Discord package and rejects a stale shadowing copy', () => {
  const root = makeTempDir('openclaw-bundled-validation-');
  const declaration = { id: 'discord', npm: '@openclaw/discord', version: '2026.8.1', runtimeBundled: true };
  const pluginDir = resolvePreinstalledPluginDir(root, declaration);
  fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
  const pkg = {
    name: declaration.npm, version: declaration.version,
    openclaw: { runtimeExtensions: ['./dist/index.js'] },
  };
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(pluginDir, 'openclaw.plugin.json'), JSON.stringify({ id: declaration.id }));
  expect(() => verifyRuntimeBundledPlugin(root, declaration)).toThrow('compiled runtime entry');
  fs.writeFileSync(path.join(pluginDir, 'dist', 'index.js'), '');
  expect(() => verifyRuntimeBundledPlugin(root, declaration)).not.toThrow();
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ ...pkg, version: '2026.7.1' }));
  expect(() => verifyRuntimeBundledPlugin(root, declaration)).toThrow('pinned official package');
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify(pkg));
  fs.mkdirSync(path.join(root, 'third-party-extensions', declaration.id), { recursive: true });
  expect(() => verifyRuntimeBundledPlugin(root, declaration)).toThrow('Stale config-origin copy');
});

test('rejects a bundled directory link pointing outside the runtime', () => {
  const root = makeTempDir('openclaw-bundled-containment-');
  const external = makeTempDir('openclaw-external-plugin-');
  const declaration = { id: 'discord', npm: '@openclaw/discord', runtimeBundled: true };
  const pluginDir = resolvePreinstalledPluginDir(root, declaration);
  fs.mkdirSync(path.dirname(pluginDir), { recursive: true });
  fs.symlinkSync(external, pluginDir, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => verifyRuntimeBundledPlugin(root, declaration)).toThrow('must be inside');
});

test('summarizeGatewayAsarEntries flags bundled extensions inside gateway.asar', () => {
  const summary = summarizeGatewayAsarEntries([
    '/openclaw.mjs',
    '/dist/entry.js',
    '/dist/control-ui/index.html',
    '\\dist\\extensions\\browser\\index.js',
  ]);

  expect(summary).toEqual({
    hasOpenClawEntry: true,
    hasControlUiIndex: true,
    hasGatewayEntry: true,
    hasBundledExtensions: true,
  });
});

test('pruneGatewayAsarStage removes dist/extensions before packing', () => {
  const stageRoot = makeTempDir('openclaw-gateway-stage-');
  fs.mkdirSync(path.join(stageRoot, 'dist', 'extensions', 'browser'), { recursive: true });
  fs.mkdirSync(path.join(stageRoot, 'dist', 'control-ui'), { recursive: true });
  fs.writeFileSync(path.join(stageRoot, 'dist', 'extensions', 'browser', 'index.js'), '');
  fs.writeFileSync(path.join(stageRoot, 'dist', 'control-ui', 'index.html'), '');

  pruneGatewayAsarStage(stageRoot);

  expect(fs.existsSync(path.join(stageRoot, 'dist', 'extensions'))).toBe(false);
  expect(fs.existsSync(path.join(stageRoot, 'dist', 'control-ui', 'index.html'))).toBe(true);
});

test('pruneBareDistAfterGatewayPack keeps bundled extensions but removes diffs', () => {
  const runtimeRoot = makeTempDir('openclaw-runtime-');
  fs.mkdirSync(path.join(runtimeRoot, 'dist', 'control-ui'), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, 'dist', 'extensions', 'browser'), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, 'dist', 'extensions', 'diffs'), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, 'dist', 'control-ui', 'index.html'), '');
  fs.writeFileSync(path.join(runtimeRoot, 'dist', 'extensions', 'browser', 'index.js'), '');
  fs.writeFileSync(path.join(runtimeRoot, 'dist', 'extensions', 'diffs', 'index.js'), '');
  fs.writeFileSync(path.join(runtimeRoot, 'dist', 'entry.js'), '');
  fs.writeFileSync(path.join(runtimeRoot, 'dist', 'client.js'), '');

  pruneBareDistAfterGatewayPack(runtimeRoot);

  expect(fs.existsSync(path.join(runtimeRoot, 'dist', 'control-ui', 'index.html'))).toBe(true);
  expect(fs.existsSync(path.join(runtimeRoot, 'dist', 'extensions', 'browser', 'index.js'))).toBe(true);
  expect(fs.existsSync(path.join(runtimeRoot, 'dist', 'extensions', 'diffs'))).toBe(false);
  expect(fs.existsSync(path.join(runtimeRoot, 'dist', 'entry.js'))).toBe(false);
  expect(fs.existsSync(path.join(runtimeRoot, 'dist', 'client.js'))).toBe(false);
});
