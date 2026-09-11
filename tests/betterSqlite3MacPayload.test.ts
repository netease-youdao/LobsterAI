import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const { Arch } = require('builder-util');
const { CancellationToken } = require('builder-util-runtime');
const { Platform } = require('app-builder-lib');
const { getMainFileMatchers, getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher');
const { computeFileSets, computeNodeModuleFileSets } = require('app-builder-lib/out/util/appFileCopier');
const { doMergeConfigs } = require('app-builder-lib/out/util/config');
const { AsarPackager } = require('app-builder-lib/out/asar/asarUtil');
const { configureBetterSqlite3MacPayload } = require('../scripts/better-sqlite3-mac-payload.cjs');
const tempDirs: string[] = [];
const sqlitePath = 'node_modules/better-sqlite3';
const nativeTargets = [
  'darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64',
  'linux-arm64', 'linux-x64', 'linuxmusl-arm64', 'linuxmusl-x64',
];
const macTargets = [
  { arch: Arch.arm64, native: 'darwin-arm64' },
  { arch: Arch.x64, native: 'darwin-x64' },
];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-sqlite-payload-'));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relative: string, content = relative): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture(arch: number = Arch.arm64, version = '13.0.3') {
  const appDir = tempDir();
  write(appDir, 'package.json', JSON.stringify({ name: 'fixture' }));
  write(appDir, `${sqlitePath}/package.json`, JSON.stringify({
    name: 'better-sqlite3', version, main: 'lib/index.js', gypfile: false,
  }));
  for (const relative of [
    'lib/index.js', 'lib/binding.js', 'lib/methods/transaction.js',
    'deps/sqlite3/sqlite3.c', 'deps/sqlite3/sqlite3.h', 'src/better_sqlite3.cpp',
    'node_modules/node-addon-api/napi.h',
    ...nativeTargets.map(target => `prebuilds/${target}.node`),
  ]) write(appDir, `${sqlitePath}/${relative}`);
  write(appDir, 'node_modules/another-addon/src/runtime.js');
  write(appDir, 'node_modules/another-addon/prebuilds/win32-x64.node');
  const config = doMergeConfigs([{ files: [
    'package.json', { from: 'dist', to: 'dist', filter: ['**/*'] },
    { from: 'dist-electron', to: 'dist-electron', filter: ['**/*'] }, '!**/*.map',
  ] }]);
  const info = {
    appDir, projectDir: appDir, buildResourcesDir: 'build',
    config, appInfo: { type: 'commonjs' }, debugLogger: { isEnabled: false },
    cancellationToken: new CancellationToken(),
    options: { targets: new Map() },
    getNodeDependencyInfo: () => ({ value: Promise.resolve([
      { dir: path.join(appDir, 'node_modules'), deps: [{ name: 'better-sqlite3' }, { name: 'another-addon' }] },
      { dir: path.join(appDir, sqlitePath, 'node_modules'), deps: [{ name: 'node-addon-api' }] },
    ]) }),
  };
  return {
    arch, electronPlatformName: 'darwin',
    packager: { info, config, platform: Platform.MAC, platformSpecificBuildOptions: { files: ['!private-file'] } },
  };
}

type Context = ReturnType<typeof fixture>;

async function packagedFiles(context: Context) {
  const { packager, arch } = context;
  const resources = path.join(tempDir(), '安装目录 with spaces #', 'LobsterAI.app/Contents/Resources');
  const matcher = getNodeModuleFileMatcher(
    packager.info.appDir, path.join(resources, 'app'),
    (pattern: string) => pattern.replaceAll('${arch}', Arch[arch]),
    packager.platformSpecificBuildOptions, packager.info,
  );
  const fileSets = await computeNodeModuleFileSets(packager, matcher);
  await new AsarPackager(packager.info.appDir, resources, { smartUnpack: false }, (file: string) => (
    file.startsWith(path.join(packager.info.appDir, sqlitePath) + path.sep)
  )).pack(fileSets, packager);
  const archive = path.join(resources, 'app.asar');
  const entries: string[] = asar.listPackage(archive).map((entry: string) => entry.replaceAll('\\', '/').replace(/^\//, ''));
  return { archive, entries };
}

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[path.relative(root, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  }
  walk(root);
  return result;
}

afterEach(() => {
  asar.uncacheAll();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test.each(macTargets)('packs only $native with consistent ASAR entries and an intact source tree', async ({ arch, native }) => {
  const context = fixture(arch);
  const appDir = context.packager.info.appDir;
  const before = snapshot(appDir);
  configureBetterSqlite3MacPayload(context);
  const once = [...context.packager.platformSpecificBuildOptions.files];
  configureBetterSqlite3MacPayload(context);
  expect(context.packager.platformSpecificBuildOptions.files).toEqual(once);
  expect(once).toContain('!private-file');
  const { archive, entries } = await packagedFiles(context);
  expect(entries.filter(entry => entry.startsWith(`${sqlitePath}/prebuilds/`))).toEqual([`${sqlitePath}/prebuilds/${native}.node`]);
  expect(entries.some(entry => entry.startsWith(`${sqlitePath}/deps`) || entry.startsWith(`${sqlitePath}/src`))).toBe(false);
  for (const entry of entries) {
    const metadata = asar.statFile(archive, entry);
    if (metadata.files) continue;
    expect(asar.extractFile(archive, entry)).toEqual(fs.readFileSync(path.join(appDir, entry)));
    if (metadata.unpacked) expect(fs.existsSync(path.join(`${archive}.unpacked`, entry))).toBe(true);
  }
  for (const kept of [
    `${sqlitePath}/lib/index.js`, `${sqlitePath}/lib/binding.js`, `${sqlitePath}/lib/methods/transaction.js`,
    `${sqlitePath}/node_modules/node-addon-api/napi.h`,
    'node_modules/another-addon/src/runtime.js', 'node_modules/another-addon/prebuilds/win32-x64.node',
  ]) expect(entries).toContain(kept);
  expect(snapshot(appDir)).toEqual(before);
});

test('resolves the target macro again when one packager builds both macOS architectures', async () => {
  const context = fixture(Arch.arm64);
  for (const { arch, native } of macTargets) {
    context.arch = arch;
    configureBetterSqlite3MacPayload(context);
    const { entries } = await packagedFiles(context);
    expect(entries.filter(entry => entry.startsWith(`${sqlitePath}/prebuilds/`))).toEqual([`${sqlitePath}/prebuilds/${native}.node`]);
  }
});

test('preserves the complete normalized app file selection without collecting source, release or cache files', async () => {
  const context = fixture();
  context.packager.platformSpecificBuildOptions.files = [];
  const { appDir } = context.packager.info;
  for (const file of ['dist/app.js', 'dist-electron/main.js', 'src/private.ts', 'release/old.dmg', 'vendor/cache.dat', '.work/qa.dat']) {
    write(appDir, file);
  }
  async function mainFiles() {
    const matchers = getMainFileMatchers(appDir, path.join(appDir, 'output/app'),
      (pattern: string) => pattern.replaceAll('${arch}', 'arm64'),
      context.packager.platformSpecificBuildOptions, context.packager, path.join(appDir, 'output'), false);
    const fileSets: { files: string[] }[] = await computeFileSets(matchers, null, context.packager, false);
    return fileSets.flatMap(set => set.files.map(file => path.relative(appDir, file).replaceAll('\\', '/'))).sort();
  }
  const before = await mainFiles();
  expect(before).toEqual(['dist-electron/main.js', 'dist/app.js', 'package.json']);
  configureBetterSqlite3MacPayload(context);
  expect(await mainFiles()).toEqual(before);
  // Root config representation is shared across platforms; its file selection
  // must also remain the same without the mac-only exclusions.
  context.packager.platformSpecificBuildOptions.files = [];
  expect(await mainFiles()).toEqual(before);
});

test.each(['lib/index.js', 'lib/binding.js', 'prebuilds/darwin-arm64.node'])('rejects missing %s before changing package filters', relative => {
  const context = fixture();
  fs.unlinkSync(path.join(context.packager.info.appDir, sqlitePath, relative));
  const before = [...context.packager.platformSpecificBuildOptions.files];
  expect(() => configureBetterSqlite3MacPayload(context)).toThrow('Missing SQLite runtime file');
  expect(context.packager.platformSpecificBuildOptions.files).toEqual(before);
});

test.each(['win32', 'linux'])('does not alter %s packaging', electronPlatformName => {
  const context = fixture();
  context.electronPlatformName = electronPlatformName;
  const before = [...context.packager.platformSpecificBuildOptions.files];
  configureBetterSqlite3MacPayload(context);
  expect(context.packager.platformSpecificBuildOptions.files).toEqual(before);
});

test.each([Arch.arm64, Arch.x64, Arch.universal])('keeps the universal payload in its arch=%s hook', async arch => {
  const context = fixture(arch);
  context.packager.info.options.targets.set(Platform.MAC, new Map([[Arch.universal, ['dmg']]]));
  configureBetterSqlite3MacPayload(context);
  const { entries } = await packagedFiles(context);
  expect(entries.filter(entry => entry.startsWith(`${sqlitePath}/prebuilds/`))).toHaveLength(nativeTargets.length);
  expect(entries).toContain(`${sqlitePath}/deps/sqlite3/sqlite3.c`);
});

test('retains unreviewed versions and removes earlier generated exclusions on reuse', async () => {
  const context = fixture();
  configureBetterSqlite3MacPayload(context);
  write(context.packager.info.appDir, `${sqlitePath}/package.json`, JSON.stringify({ name: 'better-sqlite3', version: '14.0.0' }));
  configureBetterSqlite3MacPayload(context);
  expect(context.packager.platformSpecificBuildOptions.files).toEqual(['!private-file']);
  const { entries } = await packagedFiles(context);
  expect(entries.filter(entry => entry.startsWith(`${sqlitePath}/prebuilds/`))).toHaveLength(nativeTargets.length);
  expect(entries).toContain(`${sqlitePath}/deps/sqlite3/sqlite3.c`);
});
