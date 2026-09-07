import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const tar = require('tar');
const {
  patchHostPeerPackageDirectory,
  prepareHostPeerPackage,
} = require('../scripts/openclaw-plugin-preparers/host-peer.cjs');

function writePackageJson(dir: string, pkg: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
}

function readPackageJson(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
}

function createTarball(tempDir: string, pkg: Record<string, unknown>): string {
  const packageDir = path.join(tempDir, 'package');
  writePackageJson(packageDir, pkg);
  fs.writeFileSync(path.join(packageDir, 'index.js'), 'export {};\n');
  const tgzPath = path.join(tempDir, 'fixture.tgz');
  tar.c({ gzip: true, file: tgzPath, cwd: tempDir, sync: true }, ['package']);
  return tgzPath;
}

describe('prepare-openclaw-host-peer', () => {
  test('marks a required openclaw peerDependency optional', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-host-peer-'));
    writePackageJson(tempDir, {
      name: '@clawemail/email',
      version: '0.9.13',
      dependencies: { ws: '^8.20.0' },
      peerDependencies: { openclaw: '>=2026.3.22' },
    });

    const logs: string[] = [];
    expect(patchHostPeerPackageDirectory(tempDir, { log: (message: string) => logs.push(message) }))
      .toEqual({ changed: true, peerRange: '>=2026.3.22' });

    const pkg = readPackageJson(tempDir);
    expect(pkg.peerDependencies).toEqual({ openclaw: '>=2026.3.22' });
    expect(pkg.peerDependenciesMeta).toEqual({ openclaw: { optional: true } });
    expect(pkg.dependencies).toEqual({ ws: '^8.20.0' });
    expect(logs.join('\n')).toContain('@clawemail/email');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('keeps unrelated peerDependenciesMeta entries', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-host-peer-'));
    writePackageJson(tempDir, {
      name: 'fixture-plugin',
      version: '1.0.0',
      peerDependencies: { openclaw: '>=2026.3.22', zod: '^4.0.0' },
      peerDependenciesMeta: { zod: { optional: true }, openclaw: { note: 'host' } },
    });

    expect(patchHostPeerPackageDirectory(tempDir)).toEqual({ changed: true, peerRange: '>=2026.3.22' });
    expect(readPackageJson(tempDir).peerDependenciesMeta).toEqual({
      zod: { optional: true },
      openclaw: { note: 'host', optional: true },
    });

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('leaves manifests without a required openclaw peer untouched', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-host-peer-'));

    const noPeerDir = path.join(tempDir, 'no-peer');
    writePackageJson(noPeerDir, { name: 'no-peer', version: '1.0.0', dependencies: { zod: '^4.0.0' } });
    const noPeerBefore = fs.readFileSync(path.join(noPeerDir, 'package.json'), 'utf-8');
    expect(patchHostPeerPackageDirectory(noPeerDir)).toEqual({ changed: false, peerRange: null });
    expect(fs.readFileSync(path.join(noPeerDir, 'package.json'), 'utf-8')).toBe(noPeerBefore);

    const optionalDir = path.join(tempDir, 'optional');
    writePackageJson(optionalDir, {
      name: 'optional-peer',
      version: '1.0.0',
      peerDependencies: { openclaw: '>=2026.6.1' },
      peerDependenciesMeta: { openclaw: { optional: true } },
    });
    const optionalBefore = fs.readFileSync(path.join(optionalDir, 'package.json'), 'utf-8');
    expect(patchHostPeerPackageDirectory(optionalDir)).toEqual({ changed: false, peerRange: '>=2026.6.1' });
    expect(fs.readFileSync(path.join(optionalDir, 'package.json'), 'utf-8')).toBe(optionalBefore);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('repacks a tarball only when its manifest changed', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-host-peer-'));
    const outputDir = path.join(tempDir, 'staging');
    fs.mkdirSync(outputDir, { recursive: true });

    const requiredTgz = createTarball(path.join(tempDir, 'required'), {
      name: 'host-peer-fixture',
      version: '1.0.0',
      files: ['index.js'],
      peerDependencies: { openclaw: '>=2026.3.22' },
    });
    const patchedTgz = prepareHostPeerPackage(requiredTgz, outputDir, { packageLabel: 'fixture' });
    expect(patchedTgz).not.toBe(requiredTgz);
    expect(patchedTgz.endsWith('.tgz')).toBe(true);

    const extractDir = path.join(tempDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    tar.x({ file: patchedTgz, cwd: extractDir, strip: 1, sync: true });
    expect(readPackageJson(extractDir).peerDependenciesMeta).toEqual({ openclaw: { optional: true } });
    expect(fs.existsSync(path.join(extractDir, 'index.js'))).toBe(true);

    const optionalTgz = createTarball(path.join(tempDir, 'optional'), {
      name: 'host-peer-fixture',
      version: '1.0.0',
      peerDependencies: { openclaw: '>=2026.3.22' },
      peerDependenciesMeta: { openclaw: { optional: true } },
    });
    expect(prepareHostPeerPackage(optionalTgz, outputDir)).toBe(optionalTgz);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
