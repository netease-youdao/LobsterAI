import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const { applyOpenClawPluginPatches } = require('../scripts/openclaw-plugin-patches/index.cjs');
const { patchNimAndBee } = require('../scripts/openclaw-plugin-patches/nim-bee.cjs');
const { patchNimPackageDirectory } = require('../scripts/openclaw-plugin-preparers/nim-channel.cjs');
const { patchBeePackageDirectory } = require('../scripts/openclaw-plugin-preparers/netease-bee.cjs');

const tempDirs: string[] = [];
const pluginCases = [
  {
    directory: 'openclaw-nim-channel',
    packageName: '@nimsuite/openclaw-nim-channel',
    pluginId: 'nimsuite-openclaw-nim-channel',
    channelId: 'nim',
    prepare: patchNimPackageDirectory,
  },
  {
    directory: 'openclaw-netease-bee',
    packageName: 'openclaw-netease-bee',
    pluginId: 'openclaw-netease-bee',
    channelId: 'netease-bee',
    prepare: patchBeePackageDirectory,
  },
];

function makeRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-nim-bee-'));
  tempDirs.push(root);
  const sdkDir = path.join(root, 'node_modules', 'openclaw');
  fs.mkdirSync(sdkDir, { recursive: true });
  fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({
    name: 'openclaw',
    type: 'module',
    exports: { './plugin-sdk/plugin-entry': './plugin-entry.js' },
  }));
  fs.writeFileSync(path.join(sdkDir, 'plugin-entry.js'),
    'export const emptyPluginConfigSchema = () => ({ type: "object", additionalProperties: false });\n');
  return root;
}

function loadPlugin(entry: string) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', [
    'import { pathToFileURL } from "node:url";',
    'const { default: plugin } = await import(pathToFileURL(process.argv[1]).href);',
    'const channels = [];',
    'plugin.register({ registerChannel: ({ plugin }) => channels.push(plugin.id) });',
    'console.log(JSON.stringify({ id: plugin.id, schema: plugin.configSchema, channels }));',
  ].join('\n'), entry], { encoding: 'utf8' });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('NIM and Bee OpenClaw SDK patches', () => {
  test.each(pluginCases)('repairs fresh prepared $directory packages through the install patch pipeline', (plugin) => {
    const root = makeRuntime();
    const pluginDir = path.join(root, plugin.directory);
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
      name: plugin.packageName,
      openclaw: { extensions: ['./index.ts'] },
    }));
    const sourcePath = path.join(pluginDir, 'index.ts');
    fs.writeFileSync(sourcePath, [
      'import type { OpenClawPluginApi } from "openclaw/plugin-sdk";',
      'import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";',
      'export default {',
      `  id: ${JSON.stringify(plugin.pluginId)},`,
      '  configSchema: emptyPluginConfigSchema(),',
      `  register(api: OpenClawPluginApi) { api.registerChannel({ plugin: { id: ${JSON.stringify(plugin.channelId)} } }); },`,
      '};',
    ].join('\n'));
    plugin.prepare(pluginDir);
    const entry = path.join(pluginDir, 'index.mjs');
    const before = loadPlugin(entry);
    expect(before.status).not.toBe(0);
    expect(before.stderr).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');

    applyOpenClawPluginPatches({ runtimeExtensionsDir: root, log: () => {} });
    expect(fs.readFileSync(sourcePath, 'utf8')).not.toContain('from "openclaw/plugin-sdk"');
    const after = loadPlugin(entry);
    expect(after.stderr).toBe('');
    expect(after.status).toBe(0);
    expect(JSON.parse(after.stdout)).toEqual({
      id: plugin.pluginId,
      schema: { type: 'object', additionalProperties: false },
      channels: [plugin.channelId],
    });
  });

  test.each(pluginCases)('repairs cached $directory bundles without source and leaves other plugins intact', (plugin) => {
    const root = makeRuntime();
    const pluginDir = path.join(root, plugin.directory);
    fs.mkdirSync(pluginDir);
    const source = [
      'import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";',
      `export default { id: ${JSON.stringify(plugin.pluginId)}, configSchema: emptyPluginConfigSchema(),`,
      `register(api) { api.registerChannel({ plugin: { id: ${JSON.stringify(plugin.channelId)} } }); } };`,
    ].join('\n');
    const entry = path.join(pluginDir, 'index.mjs');
    fs.writeFileSync(entry, source);
    const unrelatedDir = path.join(root, 'another-plugin');
    fs.mkdirSync(unrelatedDir);
    const unrelatedEntry = path.join(unrelatedDir, 'index.mjs');
    fs.writeFileSync(unrelatedEntry, source);
    const context = { runtimeExtensionsDir: root, log: () => {} };
    patchNimAndBee(context);
    const firstPass = fs.readFileSync(entry, 'utf8');
    patchNimAndBee(context);
    expect(fs.readFileSync(entry, 'utf8')).toBe(firstPass);
    expect(fs.readFileSync(unrelatedEntry, 'utf8')).toBe(source);
    expect(loadPlugin(entry).status).toBe(0);
  });

  test('does not create entries for missing optional plugins', () => {
    const root = makeRuntime();
    const before = fs.readdirSync(root);
    patchNimAndBee({ runtimeExtensionsDir: root, log: () => {} });
    expect(fs.readdirSync(root)).toEqual(before);
  });
});
