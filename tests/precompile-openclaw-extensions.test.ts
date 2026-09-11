import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const developmentApp = vi.hoisted(() => ({ appPath: '' }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => developmentApp.appPath },
}));

import { syncLocalOpenClawExtensionsIntoRuntime } from '../src/main/libs/openclawLocalExtensions';

const { precompileOpenClawExtensions } = require('../scripts/precompile-openclaw-extensions.cjs');
const { ENTRY_KIND, collectPluginRuntimeEntries } = require('../scripts/openclaw-plugin-entries.cjs');

let runtimeRoot: string;
beforeEach(() => { runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'precompile-extensions-')); });
afterEach(() => { fs.rmSync(runtimeRoot, { recursive: true, force: true }); });
const quiet = { log: () => {} };

// Exercise the existing private packaging predicate without executing unrelated
// Electron packaging hooks or changing their public exports just for a test.
const hookSource = fs.readFileSync(path.resolve(__dirname, '../scripts/electron-builder-hooks.cjs'), 'utf8');
const predicate = hookSource.match(/function hasCompiledLocalExtension\([\s\S]*?\n}/)?.[0];
if (!predicate) throw new Error('Missing compiled local extension packaging predicate');
const hasCompiledLocalExtension = runInNewContext(`(${predicate})`, {
  path, existsSync: fs.existsSync, ENTRY_KIND, collectPluginRuntimeEntries,
}) as (runtimeRoot: string, extensionId: string) => boolean;

function fixture(name: string, metadata: Record<string, unknown>, files: Record<string, string>, type?: string, bundled = false) {
  const directory = path.join(runtimeRoot, bundled ? 'dist/extensions' : 'third-party-extensions', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, type, openclaw: metadata }));
  fs.writeFileSync(path.join(directory, 'openclaw.plugin.json'), JSON.stringify({ id: name }));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return directory;
}

function readPackage(directory: string) {
  return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
}

function loadExport(file: string, key: string) {
  const script = `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); console.log(JSON.stringify(m[${JSON.stringify(key)}] ?? m.default?.[${JSON.stringify(key)}]));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true }).trim());
}

describe('plugin precompilation', () => {
  test('compiles every TS runtime/setup entry, preserving CJS and ESM semantics and source declarations', async () => {
    const extensions = ['./first.mts', './second.cts'];
    const directory = fixture('multiple', { extensions, setupEntry: './setup.ts' }, {
      'first.mts': 'export const location: string = import.meta.url;',
      'second.cts': 'export const location: string = __dirname;',
      'setup.ts': 'export const setup: number = 7;',
    }, 'module');
    const result = await precompileOpenClawExtensions(runtimeRoot, quiet);
    expect(result.compiled).toBe(3);
    const pkg = readPackage(directory);
    expect(pkg.openclaw).toEqual({
      extensions, runtimeExtensions: ['./first.mjs', './second.cjs'], setupEntry: './setup.ts', runtimeSetupEntry: './setup.mjs',
    });
    expect(loadExport(path.join(directory, 'first.mjs'), 'location')).toBe(pathToFileURL(path.join(directory, 'first.mjs')).href);
    expect(loadExport(path.join(directory, 'second.cjs'), 'location')).toBe(directory);
    expect(loadExport(path.join(directory, 'setup.mjs'), 'setup')).toBe(7);
    expect(collectPluginRuntimeEntries(runtimeRoot).map((entry: { kind: string }) => entry.kind)).toEqual([
      ENTRY_KIND.Runtime, ENTRY_KIND.Runtime, ENTRY_KIND.Setup,
    ]);
  });

  test('rebuilds owned sources and dependencies after an earlier compile, with stable metadata and unchanged output mtimes', async () => {
    const directory = fixture('ask-user-question', { extensions: ['./index.ts'] }, {
      'index.ts': 'export { value } from "./value";',
      'value.ts': 'export const value: number = 1;',
      'index.js': 'export const value = "old output from the previous precompiler";',
    }, 'module');
    await precompileOpenClawExtensions(runtimeRoot, quiet);
    const firstPackage = fs.readFileSync(path.join(directory, 'package.json'), 'utf8');
    const output = path.join(directory, 'index.js');
    const mtime = fs.statSync(output).mtimeMs;
    expect(loadExport(output, 'value')).toBe(1);
    await precompileOpenClawExtensions(runtimeRoot, quiet);
    expect(fs.statSync(output).mtimeMs).toBe(mtime);
    expect(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).toBe(firstPackage);
    fs.writeFileSync(path.join(directory, 'value.ts'), 'export const value: number = 2;');
    await precompileOpenClawExtensions(runtimeRoot, quiet);
    expect(loadExport(output, 'value')).toBe(2);
    expect(readPackage(directory).openclaw.extensions).toEqual(['./index.ts']);
  });

  test('rebuilds third-party TS that this script owns after creating runtime overrides', async () => {
    const directory = fixture('source-only', { extensions: ['./index.ts'] }, { 'index.ts': 'export const value: number = 1;' });
    await precompileOpenClawExtensions(runtimeRoot, quiet);
    fs.writeFileSync(path.join(directory, 'index.ts'), 'export const value: number = 3;');
    await precompileOpenClawExtensions(runtimeRoot, quiet);
    expect(loadExport(path.join(directory, 'index.cjs'), 'value')).toBe(3);
    expect(readPackage(directory).openclaw.extensions).toEqual(['./index.ts']);
    const provenance = fs.readFileSync(path.join(directory, 'openclaw-precompile-info.json'), 'utf8');
    expect(provenance).not.toContain(directory);
  });

  test.each([
    { type: 'module', stale: 'export const value = 1;' },
    { type: 'commonjs', stale: 'module.exports = { value: 1 };' },
  ])('loads the current compiled local entry after development sync overwrites runtime overrides ($type)', async ({ type, stale }) => {
    const source = 'export const value: number = 2;';
    const directory = fixture('ask-user-question', { extensions: ['./index.ts'] }, {
      'index.ts': source, 'index.js': stale,
    }, type);
    const sourcePackage = readPackage(directory);
    developmentApp.appPath = path.join(runtimeRoot, 'development-app');
    const sourceDir = path.join(developmentApp.appPath, 'openclaw-extensions/ask-user-question');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify(sourcePackage));
    fs.writeFileSync(path.join(sourceDir, 'index.ts'), source);
    fs.writeFileSync(path.join(sourceDir, 'openclaw.plugin.json'), JSON.stringify({ id: 'ask-user-question' }));

    await precompileOpenClawExtensions(runtimeRoot, quiet);
    const packagedEntry = collectPluginRuntimeEntries(runtimeRoot)[0];
    expect(loadExport(packagedEntry.source, 'value')).toBe(2);

    // Use the real Electron-startup copy path: it replaces package.json but
    // leaves compiled files from previous builds beside the copied TS source.
    expect(syncLocalOpenClawExtensionsIntoRuntime(runtimeRoot).copied).toEqual(['ask-user-question']);
    expect(readPackage(directory)).toEqual(sourcePackage);
    const developmentEntry = collectPluginRuntimeEntries(runtimeRoot)[0];
    expect(loadExport(developmentEntry.source, 'value')).toBe(2);
    expect(developmentEntry.source).toBe(packagedEntry.source);
  });

  test('bundles local build dependencies into a runtime outside the repository', async () => {
    const directory = fixture('ask-user-question', { extensions: ['./index.ts'] }, {
      'index.ts': 'import { Type } from "@sinclair/typebox"; export const schema = Type.String();',
    }, 'module');
    await precompileOpenClawExtensions(runtimeRoot, quiet);
    expect(loadExport(path.join(directory, 'index.js'), 'schema')).toMatchObject({ type: 'string' });
    expect(fs.existsSync(path.join(runtimeRoot, 'node_modules'))).toBe(false);
  });

  test('prepares manifest-only TS with explicit runtime metadata and preserves its inherited module mode on rebuild', async () => {
    fs.writeFileSync(path.join(runtimeRoot, 'package.json'), JSON.stringify({ type: 'module' }));
    const directory = fixture('conventional', { extensions: ['./index.ts'] }, {
      'index.ts': 'export const value: number = 1;', 'index.js': 'export const value = "stale";',
    });
    fs.rmSync(path.join(directory, 'package.json'));
    await precompileOpenClawExtensions(runtimeRoot, quiet);
    expect(readPackage(directory)).toEqual({ private: true, type: 'module', openclaw: {
      extensions: ['./index.ts'], runtimeExtensions: ['./index.mjs'],
    } });
    fs.writeFileSync(path.join(directory, 'index.ts'), 'export const value: number = 4;');
    await precompileOpenClawExtensions(runtimeRoot, quiet);
    expect(loadExport(path.join(directory, 'index.mjs'), 'value')).toBe(4);
    expect(readPackage(directory).type).toBe('module');
  });

  test('packaging accepts source declarations with generated runtime overrides and checks every setup/runtime entry', async () => {
    const directory = fixture('ask-user-question', { extensions: ['./first.ts', './second.cts'], setupEntry: './setup.mts' }, {
      'first.ts': 'export const value: number = 1;',
      'second.cts': 'export const value: number = 2;',
      'setup.mts': 'export const setup: boolean = true;',
    }, 'module');
    expect(hasCompiledLocalExtension(runtimeRoot, 'ask-user-question')).toBe(false);
    await precompileOpenClawExtensions(runtimeRoot, quiet);
    expect(fs.existsSync(path.join(directory, 'index.js'))).toBe(false);
    expect(hasCompiledLocalExtension(runtimeRoot, 'ask-user-question')).toBe(true);
    fs.rmSync(path.join(directory, 'setup.mjs'));
    expect(hasCompiledLocalExtension(runtimeRoot, 'ask-user-question')).toBe(false);
  });

  test('preserves published explicit/inferred JS entries, ordinary JS packages and the official bundled layout', async () => {
    const explicit = fixture('official', { extensions: ['./index.ts'], runtimeExtensions: ['./dist/index.js'] }, {
      'index.ts': 'This is source that must never be rebuilt', 'dist/index.js': 'export const published = true;',
    }, 'module', true);
    const inferred = fixture('publisher', { extensions: ['./index.ts'], setupEntry: './setup.cts' }, {
      'index.ts': 'This is source that must never be rebuilt', 'dist/index.mjs': 'export const published = true;',
      'setup.cts': 'This is source that must never be rebuilt', 'dist/setup.cjs': 'module.exports = {};',
    });
    const ordinary = fixture('ordinary', { extensions: ['./index.cjs'] }, { 'index.cjs': 'module.exports = {};' });
    const originals = [explicit, inferred, ordinary].map(directory => fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const result = await precompileOpenClawExtensions(runtimeRoot, quiet);
    expect(result.compiled).toBe(0);
    expect(result.preserved).toBe(4);
    [explicit, inferred, ordinary].forEach((directory, index) => {
      expect(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).toBe(originals[index]);
      expect(fs.existsSync(path.join(directory, 'openclaw-precompile-info.json'))).toBe(false);
    });
  });

  test('keeps SDK and installed package dependencies external', async () => {
    const directory = fixture('external', { extensions: ['./index.ts'] }, {
      'index.ts': 'export { definePlugin } from "openclaw/plugin-sdk/plugin-entry"; export { value } from "some-dependency";',
    }, 'module');
    fs.mkdirSync(path.join(directory, 'node_modules'));
    await precompileOpenClawExtensions(runtimeRoot, quiet);
    const output = fs.readFileSync(path.join(directory, 'index.mjs'), 'utf8');
    expect(output).toContain('"openclaw/plugin-sdk/plugin-entry"');
    expect(output).toContain('"some-dependency"');
  });

  test('fails the build without rewriting metadata or earlier package outputs when any entry fails compilation', async () => {
    const directory = fixture('broken', { extensions: ['./first.ts', './broken.ts'] }, {
      'first.ts': 'export const value: number = 1;', 'broken.ts': 'export const value: = ;',
    }, 'module');
    const original = fs.readFileSync(path.join(directory, 'package.json'), 'utf8');
    await expect(precompileOpenClawExtensions(runtimeRoot, quiet)).rejects.toThrow('Failed to precompile plugin broken');
    expect(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(directory, 'first.mjs'))).toBe(false);
    expect(fs.existsSync(path.join(directory, 'openclaw-precompile-info.json'))).toBe(false);
    const cli = path.resolve(__dirname, '../scripts/precompile-openclaw-extensions.cjs');
    expect(() => execFileSync(process.execPath, [cli, runtimeRoot], { stdio: 'pipe', windowsHide: true })).toThrow();
  });

  test('does not hide broken promised runtime output with TS fallback', async () => {
    fixture('promised', { extensions: ['./index.ts'], runtimeExtensions: ['./dist/missing.js'] }, { 'index.ts': 'export const value = 1;' });
    await expect(precompileOpenClawExtensions(runtimeRoot, quiet)).rejects.toThrow('Plugin entry not found: ./dist/missing.js');
  });

  test('refuses to silently erase import.meta when producing a CommonJS entry', async () => {
    fixture('invalid-commonjs', { extensions: ['./index.cts'] }, { 'index.cts': 'export const location = import.meta.url;' });
    await expect(precompileOpenClawExtensions(runtimeRoot, quiet)).rejects.toThrow('Failed to precompile plugin invalid-commonjs');
  });
});
