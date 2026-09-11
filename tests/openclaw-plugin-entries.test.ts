import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const {
  ENTRY_KIND,
  collectPluginRuntimeEntries,
  listBuiltRuntimeEntryCandidates,
} = require('../scripts/openclaw-plugin-entries.cjs');

let runtimeRoot: string;
beforeEach(() => { runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-entries-')); });
afterEach(() => { fs.rmSync(runtimeRoot, { recursive: true, force: true }); });

function fixture(name: string, openclaw: Record<string, unknown> | undefined, files: string[], bundled = false) {
  const directory = path.join(runtimeRoot, bundled ? 'dist/extensions' : 'third-party-extensions', name);
  fs.mkdirSync(directory, { recursive: true });
  if (openclaw) fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: `@scope/${name}`, openclaw }));
  fs.writeFileSync(path.join(directory, 'openclaw.plugin.json'), JSON.stringify({ id: name }));
  for (const file of files) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'export default {};');
  }
  return directory;
}

describe('packaged OpenClaw entry inventory', () => {
  test('uses all explicit runtime overrides and setup output even when source is absent', () => {
    const directory = fixture('multiple', {
      extensions: ['./src/first.ts', './src/second.ts'],
      runtimeExtensions: ['./dist/first.mjs', './dist/second.cjs'],
      setupEntry: './src/setup.ts', runtimeSetupEntry: './dist/setup.cjs',
    }, ['dist/first.mjs', 'dist/second.cjs', 'dist/setup.cjs'], true);
    const before = fs.readFileSync(path.join(directory, 'package.json'), 'utf8');
    expect(collectPluginRuntimeEntries(runtimeRoot)).toEqual([
      { id: 'multiple/first', pluginDir: directory, source: path.join(directory, 'dist/first.mjs'), kind: ENTRY_KIND.Runtime, origin: 'bundled' },
      { id: 'multiple/second', pluginDir: directory, source: path.join(directory, 'dist/second.cjs'), kind: ENTRY_KIND.Runtime, origin: 'bundled' },
      { id: 'multiple', pluginDir: directory, source: path.join(directory, 'dist/setup.cjs'), kind: ENTRY_KIND.Setup, origin: 'bundled' },
    ]);
    expect(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).toBe(before);
  });

  test('matches upstream inferred candidates and their config-versus-bundled precedence', () => {
    expect(listBuiltRuntimeEntryCandidates('./src/nested/index.mts')).toEqual([
      './dist/nested/index.js', './dist/nested/index.mjs', './dist/nested/index.cjs',
      './src/nested/index.js', './src/nested/index.mjs', './src/nested/index.cjs',
    ]);
    const config = fixture('config', { extensions: ['./src/index.ts'], setupEntry: './src/setup.cts' }, [
      'src/index.ts', 'src/index.js', 'dist/index.mjs', 'src/setup.cts', 'dist/setup.cjs',
    ]);
    const bundled = fixture('bundled', { extensions: ['./index.ts'] }, ['index.ts', 'dist/index.js'], true);
    const entries = collectPluginRuntimeEntries(runtimeRoot);
    expect(entries.map((entry: { source: string }) => entry.source)).toEqual([
      path.join(bundled, 'index.ts'), path.join(config, 'dist/index.mjs'), path.join(config, 'dist/setup.cjs'),
    ]);
  });

  test('supports manifest-bearing conventional entries and ignores helper/dependency packages', () => {
    const talk = fixture('talk-voice', undefined, ['index.js'], true);
    const helper = path.join(runtimeRoot, 'dist/extensions/helper');
    fs.mkdirSync(helper);
    fs.writeFileSync(path.join(helper, 'package.json'), JSON.stringify({ name: 'helper' }));
    fs.writeFileSync(path.join(helper, 'index.ts'), 'throw new Error("not a plugin");');
    const dependency = path.join(talk, 'node_modules/nested');
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(path.join(dependency, 'openclaw.plugin.json'), JSON.stringify({ id: 'nested' }));
    expect(collectPluginRuntimeEntries(runtimeRoot)).toEqual([
      { id: 'talk-voice', pluginDir: talk, source: path.join(talk, 'index.js'), kind: ENTRY_KIND.Runtime, origin: 'bundled' },
    ]);
  });

  test('keeps manifest-only conventional discovery source-first even for config-origin plugins', () => {
    const directory = fixture('conventional', undefined, ['index.ts', 'index.js']);
    expect(collectPluginRuntimeEntries(runtimeRoot)).toEqual([
      { id: 'conventional', pluginDir: directory, source: path.join(directory, 'index.ts'), kind: ENTRY_KIND.Runtime, origin: 'config' },
    ]);
  });

  test.each([
    { metadata: { extensions: ['./index.ts'], runtimeExtensions: ['./missing.js'] }, files: ['index.ts'], error: 'Plugin entry not found: ./missing.js' },
    { metadata: { extensions: ['./first.js', './second.js'], runtimeExtensions: ['./first.js'] }, files: ['first.js', 'second.js'], error: 'must match openclaw.extensions length' },
    { metadata: { extensions: ['./index.js'], runtimeSetupEntry: './setup.js' }, files: ['index.js', 'setup.js'], error: 'requires openclaw.setupEntry' },
    { metadata: { extensions: ['./index.js'], setupEntry: './missing.js' }, files: ['index.js'], error: 'Plugin entry not found: ./missing.js' },
    { metadata: { extensions: ['./a/index.js', './b/index.js'] }, files: ['a/index.js', 'b/index.js'], error: 'collide on derived id' },
    { metadata: { extensions: ['./index.js', ' '] }, files: ['index.js'], error: 'must be a non-empty string' },
  ])('rejects broken promised entries and ambiguous metadata: $error', ({ metadata, files, error }) => {
    fixture('broken', metadata, files);
    expect(() => collectPluginRuntimeEntries(runtimeRoot)).toThrow(error);
  });

  test.each(['../escape.ts', '/absolute.ts', 'C:\\absolute.ts', 'file:///absolute.ts'])(
    'rejects unsafe source declaration %s even with a valid runtime override', (source) => {
      fixture('unsafe', { extensions: [source], runtimeExtensions: ['./index.js'] }, ['index.js']);
      expect(() => collectPluginRuntimeEntries(runtimeRoot)).toThrow(/relative plugin entry|escapes plugin directory/);
    },
  );

  test('rejects symlinked entry directories, including missing outputs through that directory', () => {
    const directory = fixture('unsafe', { extensions: ['./index.ts'], runtimeExtensions: ['./linked/index.js'] }, ['index.ts']);
    const outside = path.join(runtimeRoot, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => collectPluginRuntimeEntries(runtimeRoot)).toThrow('escapes plugin directory');
  });
});
