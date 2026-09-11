import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const { patchLarkNativeModules } = require('../scripts/openclaw-plugin-patches/lark-native-modules.cjs');
const tempDirs: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-native-'));
  tempDirs.push(root);
  const plugin = path.join(root, '飞书 # % package');
  const core = path.join(plugin, 'src', 'core');
  fs.mkdirSync(core, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ version: '2026.7.16' }));
  fs.writeFileSync(path.join(core, 'version.js'), `
const node_url_1 = require('node:url');
const node_path_1 = require('node:path');
exports.version = () => {
        const __filename = (0, node_url_1.fileURLToPath)(import.meta.url);
        const __dirname = (0, node_path_1.dirname)(__filename);
        return require(node_path_1.join(__dirname, '..', '..', 'package.json')).version;
};
`);
  fs.writeFileSync(path.join(core, 'token-store.js'), `
const node_module_1 = require('node:module');
const _require = (0, node_module_1.createRequire)(typeof __filename !== 'undefined' ? __filename : import.meta.url);
exports.relative = () => _require('./marker.cjs');
`);
  fs.writeFileSync(path.join(core, 'marker.cjs'), 'module.exports = "fixture";');
  return { root, plugin, core };
}

function load(plugin: string) {
  return spawnSync(process.execPath, ['-e', [
    'const path = require("node:path");',
    'const root = process.argv[1];',
    'const version = require(path.join(root, "src/core/version.js")).version();',
    'const relative = require(path.join(root, "src/core/token-store.js")).relative();',
    'console.log(JSON.stringify({ version, relative }));',
  ].join('\n'), plugin], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Lark published CommonJS modules', () => {
  test('repairs native loading and preserves relative resolution after relocation', () => {
    const { root, plugin, core } = fixture();
    expect(load(plugin).status).not.toBe(0);
    patchLarkNativeModules(plugin, () => {});
    const contents = ['version.js', 'token-store.js'].map(file => fs.readFileSync(path.join(core, file), 'utf8'));
    patchLarkNativeModules(plugin, () => {});
    expect(['version.js', 'token-store.js'].map(file => fs.readFileSync(path.join(core, file), 'utf8'))).toEqual(contents);
    const relocated = path.join(root, 'relocated 飞书');
    fs.renameSync(plugin, relocated);
    const result = load(relocated);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ version: '2026.7.16', relative: 'fixture' });
  });

  test('rejects a changed reviewed artifact before modifying either module', () => {
    const { plugin, core } = fixture();
    const original = fs.readFileSync(path.join(core, 'version.js'), 'utf8');
    fs.writeFileSync(path.join(core, 'token-store.js'), 'exports.changed = true;');
    expect(() => patchLarkNativeModules(plugin, () => {})).toThrow('Unrecognized token-store.js');
    expect(fs.readFileSync(path.join(core, 'version.js'), 'utf8')).toBe(original);
  });

  test('leaves other published versions to their own artifact validation', () => {
    const { plugin, core } = fixture();
    fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ version: '9999.1.1' }));
    const original = fs.readFileSync(path.join(core, 'version.js'), 'utf8');
    patchLarkNativeModules(plugin, () => {});
    expect(fs.readFileSync(path.join(core, 'version.js'), 'utf8')).toBe(original);
  });
});
