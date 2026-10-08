import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

const { patchLark } = require('../scripts/openclaw-plugin-patches/lark.cjs');
const { applyOpenClawPluginPatches } = require('../scripts/openclaw-plugin-patches/index.cjs');
const { copyPreinstalledPluginToRuntime } = require('../scripts/ensure-openclaw-plugins.cjs');

const LARK_VERSION = '2026.7.16';
const LARK_NAME = '@larksuite/openclaw-lark';
const moduleNames = ['version', 'token-store'] as const;
const fixturesDir = fileURLToPath(new URL('./fixtures/openclaw-lark-2026.7.16/', import.meta.url));
const tempDirs: string[] = [];

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-native-loading-'));
  tempDirs.push(root);
  const pluginDir = path.join(root, 'openclaw-lark');
  fs.mkdirSync(path.join(pluginDir, 'src/core'), { recursive: true });
  const packageFile = path.join(pluginDir, 'package.json');
  fs.writeFileSync(packageFile, JSON.stringify({
    name: LARK_NAME, version: LARK_VERSION, openclaw: { extensions: ['./index.js'] },
  }));
  for (const name of moduleNames) {
    fs.copyFileSync(path.join(fixturesDir, `${name}.txt`), path.join(pluginDir, `src/core/${name}.js`));
  }
  // Only the logger is substituted. The two modules retain the published code.
  fs.writeFileSync(path.join(pluginDir, 'src/core/lark-logger.js'),
    'exports.larkLogger = () => ({ info() {}, warn() {}, error() {}, debug() {} });');
  return { root, pluginDir, packageFile, context: { runtimeExtensionsDir: root, log: () => {} } };
}

function runNative(file: string) {
  // A real CommonJS file keeps exports/require local to its wrapper. Node -e
  // exposes those names globally and can mask the plugin's ESM detection bug.
  const probe = path.join(path.dirname(file), 'native-probe.cjs');
  fs.writeFileSync(probe, [
    'const mod = require(process.argv[2]);',
    'console.log(JSON.stringify({',
    '  exports: Object.keys(mod),',
    '  version: mod.getPluginVersion?.(),',
    '  userAgent: mod.getUserAgent?.(),',
    '  masked: mod.maskToken?.("offline-test-1234"),',
    '}));',
  ].join('\n'));
  return spawnSync(process.execPath, [probe, file], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
}

function readModules(pluginDir: string) {
  return moduleNames.map(name => fs.readFileSync(path.join(pluginDir, `src/core/${name}.js`), 'utf8'));
}

afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    const relative = path.relative(os.tmpdir(), root);
    if (!relative.startsWith('lark-native-loading-') || relative.includes(path.sep) || path.isAbsolute(relative)) {
      throw new Error(`Unexpected fixture cleanup path: ${root}`);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Lark CommonJS native module compatibility', () => {
  test.each(moduleNames)('reproduces the published %s failure and loads the patched module natively', (name) => {
    const { pluginDir, context } = createFixture();
    const file = path.join(pluginDir, `src/core/${name}.js`);
    const before = runNative(file);
    expect(before.error).toBeUndefined();
    expect(before.status).not.toBe(0);
    expect(before.stderr).toContain('ReferenceError: exports is not defined in ES module scope');

    patchLark(context);
    const after = runNative(file);
    expect(after.error).toBeUndefined();
    expect(after.stderr).toBe('');
    expect(after.status).toBe(0);
    const output = JSON.parse(after.stdout);
    if (name === 'version') {
      expect(output.version).toBe(LARK_VERSION);
      expect(output.userAgent).toMatch(new RegExp(`^openclaw-lark/${LARK_VERSION}/(windows|mac|linux)$`));
    } else {
      expect(output.masked).toBe('****1234');
      expect(output.exports).toEqual(expect.arrayContaining([
        'getStoredToken', 'setStoredToken', 'removeStoredToken', 'tokenStatus',
      ]));
    }
  });

  test('resolves version metadata from the relocated package, including spaces and non-ASCII paths', () => {
    const { root, pluginDir, context } = createFixture();
    patchLark(context);
    const relocated = path.join(root, '飞书 plugin # relocated');
    fs.cpSync(pluginDir, relocated, { recursive: true });
    fs.writeFileSync(path.join(relocated, 'package.json'), JSON.stringify({ name: LARK_NAME, version: 'relocated-version' }));
    const result = runNative(path.join(relocated, 'src/core/version.js'));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).version).toBe('relocated-version');
  });

  test.each(['\n', '\r\n'])('is idempotent with %j line endings and preserves unrelated ESM', (lineEnding) => {
    const { pluginDir, context } = createFixture();
    for (const name of moduleNames) {
      const file = path.join(pluginDir, `src/core/${name}.js`);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r?\n/g, lineEnding));
    }
    const unrelated = path.join(pluginDir, 'unrelated.mjs');
    const esm = 'export const url = import.meta.url;\n';
    fs.writeFileSync(unrelated, esm);
    patchLark(context);
    const firstPass = readModules(pluginDir);
    patchLark(context);
    expect(readModules(pluginDir)).toEqual(firstPass);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe(esm);
    for (const name of moduleNames) {
      expect(runNative(path.join(pluginDir, `src/core/${name}.js`)).status).toBe(0);
    }
  });

  test('repairs a partially patched cached package through the build pipeline', () => {
    const { root, pluginDir, context } = createFixture();
    const originalTokenStore = fs.readFileSync(path.join(pluginDir, 'src/core/token-store.js'), 'utf8');
    patchLark(context);
    fs.writeFileSync(path.join(pluginDir, 'src/core/token-store.js'), originalTokenStore);
    const cacheBefore = readModules(pluginDir);
    const runtimeRoot = path.join(root, 'runtime');
    const declaration = { id: 'openclaw-lark', npm: LARK_NAME, version: LARK_VERSION };
    const target = copyPreinstalledPluginToRuntime(pluginDir, runtimeRoot, declaration);
    const buildContext = { runtimeExtensionsDir: path.dirname(target), log: () => {} };
    applyOpenClawPluginPatches(buildContext);
    const firstPass = readModules(target);
    copyPreinstalledPluginToRuntime(pluginDir, runtimeRoot, declaration);
    applyOpenClawPluginPatches(buildContext);
    expect(readModules(target)).toEqual(firstPass);
    expect(readModules(pluginDir)).toEqual(cacheBefore);
    for (const name of moduleNames) {
      expect(runNative(path.join(target, `src/core/${name}.js`)).status).toBe(0);
    }
  });

  test.each([
    { label: 'different version', change: { version: '2026.8.5' } },
    { label: 'different package', change: { name: 'another-plugin' } },
    { label: 'ESM package', change: { type: 'module' } },
  ])('rejects a $label before changing files', ({ change }) => {
    const { pluginDir, packageFile, context } = createFixture();
    const before = readModules(pluginDir);
    const metadata = JSON.stringify({ name: LARK_NAME, version: LARK_VERSION, ...change });
    fs.writeFileSync(packageFile, metadata);
    expect(() => patchLark(context)).toThrow(/native module patch expects/);
    expect(readModules(pluginDir)).toEqual(before);
    expect(fs.readFileSync(packageFile, 'utf8')).toBe(metadata);
    expect(fs.existsSync(path.join(pluginDir, 'setup-entry.js'))).toBe(false);
  });

  test.each([
    { label: 'unknown expression', change: (source: string) => source.replace('typeof __filename', 'typeof movedFilename') },
    { label: 'duplicate expression', change: (source: string) => source + source },
    { label: 'missing CommonJS marker', change: (source: string) => source.replace('Object.defineProperty(exports,', 'Object.defineProperty(otherExports,') },
  ])('rejects a token-store $label without partially patching version.js', ({ change }) => {
    const { pluginDir, context } = createFixture();
    const file = path.join(pluginDir, 'src/core/token-store.js');
    fs.writeFileSync(file, change(fs.readFileSync(file, 'utf8')));
    const before = readModules(pluginDir);
    expect(() => patchLark(context)).toThrow(/unsupported.*token-store/);
    expect(readModules(pluginDir)).toEqual(before);
  });

  test('rejects a missing target instead of leaving a partially patched package', () => {
    const { pluginDir, context } = createFixture();
    const versionFile = path.join(pluginDir, 'src/core/version.js');
    const version = fs.readFileSync(versionFile, 'utf8');
    fs.unlinkSync(path.join(pluginDir, 'src/core/token-store.js'));
    expect(() => patchLark(context)).toThrow(/missing.*token-store/);
    expect(fs.readFileSync(versionFile, 'utf8')).toBe(version);
  });

  test('skips an absent optional plugin', () => {
    const { root } = createFixture();
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    patchLark({ runtimeExtensionsDir: empty, log: () => {} });
    expect(fs.readdirSync(empty)).toEqual([]);
  });
});
