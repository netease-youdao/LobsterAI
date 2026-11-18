import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { Arch } = require('builder-util');
const { getFileMatchers, copyFiles } = require('app-builder-lib/out/fileMatcher');
const minimatch = createRequire(require.resolve('@electron/universal'))('minimatch');
const builderConfig = require('../electron-builder.json');
const { prepareMacSkills, verifyPackagedMacSkills, verifyMacBinary } = require('../scripts/skill-mac-dependencies.cjs');
const roots: string[] = [];
const ARCHES = ['arm64', 'x64'] as const;
type MacArch = typeof ARCHES[number];

function json(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function native(root: string, arch: MacArch, libvips = false) {
  const name = `${libvips ? 'sharp-libvips' : 'sharp'}-darwin-${arch}`;
  const directory = path.join(root, 'node_modules', '@img', name);
  json(path.join(directory, 'package.json'), { version: libvips ? '1.2.4' : '0.34.5' });
  fs.mkdirSync(path.join(directory, 'lib'), { recursive: true });
  const file = path.join(directory, 'lib', libvips ? 'libvips-cpp.8.17.3.dylib' : `${name}.node`);
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  fs.writeFileSync(file, bytes);
  return file;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-mac-test-'));
  roots.push(root);
  const source = path.join(root, 'SKILLs', 'pptx');
  const packages: Record<string, unknown> = { '': {}, 'node_modules/sharp': { version: '0.34.5' } };
  for (const arch of ARCHES) {
    packages[`node_modules/@img/sharp-darwin-${arch}`] = { version: '0.34.5', optional: true };
    packages[`node_modules/@img/sharp-libvips-darwin-${arch}`] = { version: '1.2.4', optional: true };
  }
  json(path.join(source, 'package.json'), { dependencies: { sharp: '^0.34.5' } });
  json(path.join(source, 'package-lock.json'), { lockfileVersion: 3, packages });
  native(source, 'arm64');
  const install = vi.fn((directory: string, arch: MacArch) => {
    json(path.join(directory, 'node_modules/sharp/package.json'), { version: '0.34.5' });
    fs.mkdirSync(path.join(directory, 'node_modules/sharp/lib'), { recursive: true });
    for (const file of ['index.js', 'sharp.js', 'libvips.js']) {
      fs.writeFileSync(path.join(directory, 'node_modules/sharp/lib', file), '// fixture');
    }
    native(directory, arch);
    native(directory, arch, true);
    fs.mkdirSync(path.join(directory, 'node_modules/.bin'), { recursive: true });
    if (process.platform !== 'win32') {
      fs.symlinkSync('../sharp/package.json', path.join(directory, 'node_modules/.bin/fixture'));
    }
  });
  const context = (arch: MacArch, universal = false) => ({
    arch: Arch[arch],
    electronPlatformName: 'darwin',
    appOutDir: path.join(root, 'release', arch),
    packager: {
      projectDir: root,
      platform: 'mac',
      info: { options: { targets: new Map([['mac', new Map(universal ? [[Arch.universal, []]] : [])]]) } },
      appInfo: { productFilename: 'LobsterAI' },
      platformSpecificBuildOptions: {
        extraResources: [{ from: 'SKILLs', to: 'SKILLs', filter: ['**/*'] }],
        x64ArchFiles: '',
      },
    },
  });
  return { root, source, install, context };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Mac skill dependency packaging', () => {
  test.each([['arm64', 'x64'], ['x64', 'arm64']] as const)('isolates %s → %s and reuses validated caches', (first, second) => {
    const f = fixture();
    for (const arch of [first, second, first, second]) {
      const context = f.context(arch);
      const payload = prepareMacSkills(context, { install: f.install });
      if (process.platform !== 'win32') {
        expect(fs.readlinkSync(path.join(payload, 'pptx/node_modules/.bin/fixture'))).toBe('../sharp/package.json');
      }
      const names = fs.readdirSync(path.join(payload, 'pptx/node_modules/@img'));
      expect(names.sort()).toEqual([`sharp-darwin-${arch}`, `sharp-libvips-darwin-${arch}`].sort());
      expect(context.packager.platformSpecificBuildOptions.extraResources[0].from).toBe(payload);
      expect(context.packager.platformSpecificBuildOptions.extraResources[0].filter).toEqual(['**/*']);
    }
    expect(f.install).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(path.join(f.source, 'node_modules/@img'))).toEqual(['sharp-darwin-arm64']);
  });

  test('rebuilds after native cache corruption, missing libvips, or lock changes', () => {
    const f = fixture();
    const prepare = () => prepareMacSkills(f.context('x64'), { projectDir: f.root, install: f.install });
    prepare();
    const cache = f.install.mock.calls[0][0];
    fs.writeFileSync(path.join(cache, 'node_modules/@img/sharp-darwin-x64/lib/sharp-darwin-x64.node'), Buffer.alloc(32));
    prepare();
    fs.rmSync(path.join(cache, 'node_modules/@img/sharp-libvips-darwin-x64'), { recursive: true });
    prepare();
    fs.appendFileSync(path.join(f.source, 'package-lock.json'), '\n');
    prepare();
    fs.rmSync(path.join(cache, 'node_modules/sharp/lib/sharp.js'));
    prepare();
    expect(f.install).toHaveBeenCalledTimes(5);
  });

  test('fails closed on install failure and missing target optional dependencies', () => {
    const f = fixture();
    expect(() => prepareMacSkills(f.context('x64'), {
      projectDir: f.root, install: () => { throw new Error('offline'); },
    })).toThrow('Failed to prepare pptx for darwin-x64');
    expect(() => prepareMacSkills(f.context('x64'), {
      projectDir: f.root,
      install: (directory: string) => json(path.join(directory, 'node_modules/sharp/package.json'), { version: '0.34.5' }),
    })).toThrow();
  });

  test('checks the copied app resources, rejecting wrong architecture and version', () => {
    const f = fixture();
    const context = f.context('x64');
    const payload = prepareMacSkills(context, { projectDir: f.root, install: f.install });
    const resources = path.join(context.appOutDir, 'LobsterAI.app/Contents/Resources/SKILLs');
    fs.mkdirSync(path.dirname(resources), { recursive: true });
    fs.cpSync(payload, resources, { recursive: true });
    expect(() => verifyPackagedMacSkills(context)).not.toThrow();
    const skill = path.join(resources, 'pptx');
    const armBinary = native(f.source, 'arm64');
    const x64Binary = path.join(skill, 'node_modules/@img/sharp-darwin-x64/lib/sharp-darwin-x64.node');
    fs.copyFileSync(armBinary, x64Binary);
    expect(() => verifyPackagedMacSkills(context, f.root)).toThrow('Expected x64 Mach-O');
    native(skill, 'x64');
    json(path.join(skill, 'node_modules/@img/sharp-darwin-x64/package.json'), { version: '0.34.4' });
    expect(() => verifyPackagedMacSkills(context, f.root)).toThrow('Version mismatch');
  });

  test('universal inputs contain identical platform packages and a scoped merge rule', () => {
    const f = fixture();
    for (const arch of ARCHES) {
      const context = f.context(arch, true);
      const payload = prepareMacSkills(context, { projectDir: f.root, install: f.install });
      expect(fs.readdirSync(path.join(payload, 'pptx/node_modules/@img'))).toHaveLength(4);
      expect(context.packager.platformSpecificBuildOptions.x64ArchFiles).toContain('SKILLs/**/node_modules/@img/sharp-');
    }
    expect(f.install).toHaveBeenCalledTimes(2);
  });

  test('Windows and Linux leave resource mappings and the filesystem untouched', () => {
    const f = fixture();
    for (const platform of ['win32', 'linux']) {
      const context = { ...f.context('x64'), electronPlatformName: platform };
      const before = JSON.stringify(context.packager.platformSpecificBuildOptions);
      expect(prepareMacSkills(context, { projectDir: f.root, install: f.install })).toBeUndefined();
      verifyPackagedMacSkills(context, f.root);
      expect(JSON.stringify(context.packager.platformSpecificBuildOptions)).toBe(before);
    }
    expect(f.install).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.root, 'node_modules'))).toBe(false);
  });

  test('validates resources copied by electron-builder with the shipping filters', async () => {
    const f = fixture();
    const context = f.context('x64');
    context.packager.platformSpecificBuildOptions.extraResources = builderConfig.mac.extraResources
      .filter((resource: { to: string }) => resource.to === 'SKILLs');
    fs.writeFileSync(path.join(f.source, '.env'), 'fixture secret');
    prepareMacSkills(context, { projectDir: f.root, install: f.install });
    const resources = path.join(context.appOutDir, 'LobsterAI.app/Contents/Resources');
    const matchers = getFileMatchers({}, 'extraResources', resources, {
      defaultSrc: f.root, globalOutDir: context.appOutDir,
      customBuildOptions: context.packager.platformSpecificBuildOptions,
      macroExpander: (value: string) => value,
    });
    await copyFiles(matchers);
    expect(fs.existsSync(path.join(resources, 'SKILLs/pptx/.env'))).toBe(false);
    expect(() => verifyPackagedMacSkills(context, f.root)).not.toThrow();
  });

  test('native validation reads bounded headers and closes descriptors on failure', () => {
    const f = fixture();
    const file = native(f.source, 'x64');
    const read = vi.spyOn(fs, 'readSync');
    const close = vi.spyOn(fs, 'closeSync');
    verifyMacBinary(file, 'x64');
    expect(read).toHaveBeenCalledTimes(1);
    expect((read.mock.calls[0][1] as Buffer).length).toBe(32);
    expect(close).toHaveBeenCalledTimes(1);
    read.mockImplementationOnce(() => { throw new Error('read failed'); });
    expect(() => verifyMacBinary(file, 'x64')).toThrow('read failed');
    expect(close).toHaveBeenCalledTimes(2);
  });

  test('universal rule preserves existing matches and does not exempt unrelated binaries', () => {
    const f = fixture();
    const context = f.context('x64', true);
    context.packager.platformSpecificBuildOptions.x64ArchFiles = 'Contents/Resources/existing.node';
    prepareMacSkills(context, { projectDir: f.root, install: f.install });
    const rule = context.packager.platformSpecificBuildOptions.x64ArchFiles;
    expect(minimatch('Contents/Resources/existing.node', rule)).toBe(true);
    expect(minimatch('Contents/Resources/SKILLs/pptx/node_modules/@img/sharp-darwin-x64/lib/sharp-darwin-x64.node', rule)).toBe(true);
    expect(minimatch('Contents/Resources/unrelated.node', rule)).toBe(false);
  });

});
