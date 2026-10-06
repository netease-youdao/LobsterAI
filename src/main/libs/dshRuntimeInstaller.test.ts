import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, test } from 'vitest';

import { DshInstallStage } from '../../shared/dshEngine/constants';
import {
  installDshRuntime,
  installedDshRuntimeRoot,
  isHttpSource,
  markInstalledDshRuntimeReady,
  parseDshRuntimeManifest,
  pruneInstalledDshRuntimes,
  resolveDshArtifactFromConfig,
  resolveDshArtifactFromManifest,
  resolveInstalledDshRuntime,
  resolveTarCommand,
} from './dshRuntimeInstaller';

const tempRoots: string[] = [];
const INSTALL_SENTINEL = '.lobsterai-install-ok.json';

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Minimal tree that passes validateDshRuntimeLayout.
function writeFakeRuntime(dir: string, label = 'fake dsh'): void {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), `console.log(${JSON.stringify(label)})\n`);
  const frontendDist = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist');
  fs.mkdirSync(frontendDist, { recursive: true });
  fs.writeFileSync(path.join(frontendDist, 'index.html'), '<!doctype html>\n');
}

function writeInstalledFakeRuntime(
  baseDir: string,
  version: string,
  target: string,
  sha256: string,
  installedAt: string,
  includeSentinelTarget = true,
  lastReadyAt?: string | null
): string {
  const root = installedDshRuntimeRoot(baseDir, version);
  writeFakeRuntime(root, version);
  fs.writeFileSync(
    path.join(root, 'runtime-build-info.json'),
    `${JSON.stringify({ target, dshVersion: version, patchHash: 'test' }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(root, INSTALL_SENTINEL),
    `${JSON.stringify(
      {
        installedAt,
        ...(lastReadyAt !== undefined ? { lastReadyAt } : {}),
        version,
        ...(includeSentinelTarget ? { target } : {}),
        sha256,
      },
      null,
      2
    )}\n`
  );
  return root;
}

function packFakeRuntime(runtimeDir: string, distDir: string, version: string, target: string): string {
  const archiveName = `dsh-runtime-${version}-${target}.tar.gz`;
  const archivePath = path.join(distDir, archiveName);
  // Same reason the installer resolves it: a GNU tar on PATH would read the
  // absolute archive path as `host:file` and refuse to write it.
  const tar = resolveTarCommand(process.platform, fs.existsSync, process.env.SystemRoot);
  const result = spawnSync(tar, ['-czf', archivePath, '-C', runtimeDir, '.']);
  expect(result.status).toBe(0);
  const bytes = fs.readFileSync(archivePath);
  const manifestName = `dsh-runtime-${version}-${target}.manifest.json`;
  fs.writeFileSync(
    path.join(distDir, manifestName),
    JSON.stringify({
      version,
      target,
      archive: archiveName,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    })
  );
  return manifestName;
}

describe('parseDshRuntimeManifest', () => {
  test('accepts a complete manifest and lowercases the digest', () => {
    const manifest = parseDshRuntimeManifest(
      JSON.stringify({ version: '1.0.0', target: 'mac-arm64', archive: 'a.tar.gz', sha256: 'ABCD', size: 10 })
    );
    expect(manifest).toMatchObject({ version: '1.0.0', target: 'mac-arm64', sha256: 'abcd', size: 10 });
  });

  test('rejects missing fields, path traversal, and invalid JSON', () => {
    expect(parseDshRuntimeManifest(JSON.stringify({ version: '1' }))).toBeNull();
    expect(
      parseDshRuntimeManifest(
        JSON.stringify({ version: '1', target: 't', archive: '../evil.tar.gz', sha256: 'a', size: 1 })
      )
    ).toBeNull();
    expect(parseDshRuntimeManifest('{nope')).toBeNull();
  });
});

describe('isHttpSource', () => {
  test('distinguishes URLs from local paths', () => {
    expect(isHttpSource('https://cdn.example.com/dsh')).toBe(true);
    expect(isHttpSource('http://127.0.0.1:8080')).toBe(true);
    expect(isHttpSource('/Users/me/vendor/dsh-dist')).toBe(false);
    expect(isHttpSource('C:\\dist')).toBe(false);
  });
});

describe('resolveTarCommand', () => {
  // GNU tar on PATH reads `-xzf C:\...` as `host:file`; the system bsdtar does
  // not, so Windows extracts must name it instead of trusting PATH order.
  test('names the system bsdtar on Windows and falls back to PATH', () => {
    const systemTar = path.win32.join('C:\\WINDOWS', 'System32', 'tar.exe');
    expect(resolveTarCommand('win32', (p) => p === systemTar, 'C:\\WINDOWS')).toBe(systemTar);
    expect(resolveTarCommand('win32', () => false, 'C:\\WINDOWS')).toBe('tar');
    expect(resolveTarCommand('win32', (p) => p === 'C:\\Windows\\System32\\tar.exe', undefined)).toBe(
      'C:\\Windows\\System32\\tar.exe'
    );
  });

  test('uses PATH on macOS and Linux', () => {
    expect(resolveTarCommand('darwin', () => true, undefined)).toBe('tar');
    expect(resolveTarCommand('linux', () => true, '/usr')).toBe('tar');
  });
});

describe('resolveDshArtifactFromConfig', () => {
  const sha = 'a'.repeat(64);

  test('accepts one absolute URL per target, appending nothing to it', () => {
    const artifact = resolveDshArtifactFromConfig(
      { 'mac-arm64': { url: 'https://cdn.example.com/opaque/xyz?token=1', sha256: sha.toUpperCase(), size: 10 } },
      'mac-arm64',
      '1.2.3'
    );
    expect(artifact).toEqual({
      version: '1.2.3',
      target: 'mac-arm64',
      sha256: sha,
      size: 10,
      url: 'https://cdn.example.com/opaque/xyz?token=1',
    });
  });

  test('returns null for an unconfigured target', () => {
    expect(resolveDshArtifactFromConfig({ 'mac-arm64': { url: 'https://x/y', sha256: sha, size: 1 } }, 'win-x64', '1')).toBeNull();
  });

  // A descriptor that cannot be trusted must not install anything.
  test('rejects a non-http url, a malformed digest, and a bad size', () => {
    expect(resolveDshArtifactFromConfig({ t: { url: 'file:///tmp/x', sha256: sha, size: 1 } }, 't', '1')).toBeNull();
    expect(resolveDshArtifactFromConfig({ t: { url: 'https://x/y', sha256: 'nope', size: 1 } }, 't', '1')).toBeNull();
    expect(resolveDshArtifactFromConfig({ t: { url: 'https://x/y', sha256: sha, size: 0 } }, 't', '1')).toBeNull();
    expect(resolveDshArtifactFromConfig(null, 't', '1')).toBeNull();
  });
});

describe('resolveInstalledDshRuntime', () => {
  test('resolves only the requested version and verifies target and digest', () => {
    const baseDir = makeTempDir('dsh-resolve-pin-');
    const rc9Sha = '9'.repeat(64);
    const rc10Sha = 'a'.repeat(64);
    const rc9 = writeInstalledFakeRuntime(baseDir, '0.1.0-rc.9', 'mac-arm64', rc9Sha, '2026-08-01T00:00:00Z');
    const rc10 = writeInstalledFakeRuntime(baseDir, '0.1.0-rc.10', 'mac-arm64', rc10Sha, '2026-08-02T00:00:00Z');

    expect(resolveInstalledDshRuntime(baseDir, '0.1.0-rc.9', { target: 'mac-arm64', sha256: rc9Sha })).toBe(rc9);
    expect(resolveInstalledDshRuntime(baseDir, '0.1.0-rc.10', { target: 'mac-arm64', sha256: rc10Sha })).toBe(rc10);
    expect(resolveInstalledDshRuntime(baseDir, '0.1.0-rc.10', { target: 'win-x64', sha256: rc10Sha })).toBeNull();
    expect(resolveInstalledDshRuntime(baseDir, '0.1.0-rc.10', { target: 'mac-arm64', sha256: rc9Sha })).toBeNull();
    expect(resolveInstalledDshRuntime(baseDir, '0.1.0-rc.11')).toBeNull();
  });

  test('uses runtime build info to validate legacy sentinels without a target field', () => {
    const baseDir = makeTempDir('dsh-resolve-legacy-');
    const sha = 'b'.repeat(64);
    const root = writeInstalledFakeRuntime(
      baseDir,
      '0.1.0-rc.6',
      'mac-arm64',
      sha,
      '2026-08-01T00:00:00Z',
      false
    );

    expect(resolveInstalledDshRuntime(baseDir, '0.1.0-rc.6', { target: 'mac-arm64', sha256: sha })).toBe(root);
  });
});

describe('installDshRuntime (local source round-trip)', () => {
  test('installs, is idempotent, and repairs a torn install', async () => {
    const runtimeDir = makeTempDir('dsh-inst-src-');
    const distDir = makeTempDir('dsh-inst-dist-');
    const baseDir = makeTempDir('dsh-inst-dest-');
    writeFakeRuntime(runtimeDir);
    const manifestName = packFakeRuntime(runtimeDir, distDir, '9.9.9', 'mac-arm64');

    const stages: string[] = [];
    const artifact = resolveDshArtifactFromManifest(distDir, manifestName);
    const first = await installDshRuntime({
      artifact,
      baseDir,
      expectedTarget: 'mac-arm64',
      onProgress: (p) => stages.push(p.stage),
    });
    expect(first.alreadyInstalled).toBe(false);
    expect(fs.existsSync(path.join(first.root, 'lib', 'bin.js'))).toBe(true);
    expect(stages).toContain(DshInstallStage.Download);
    expect(stages).toContain(DshInstallStage.Verify);
    expect(stages).toContain(DshInstallStage.Extract);
    expect(resolveInstalledDshRuntime(baseDir, '9.9.9')).toBe(first.root);

    const second = await installDshRuntime({ artifact, baseDir, expectedTarget: 'mac-arm64' });
    expect(second.alreadyInstalled).toBe(true);
    expect(second.root).toBe(first.root);

    // A torn install (missing node_modules) must not count as installed and
    // must be repaired by the next install call.
    fs.rmSync(path.join(first.root, 'node_modules'), { recursive: true, force: true });
    expect(resolveInstalledDshRuntime(baseDir, '9.9.9')).toBeNull();
    const third = await installDshRuntime({ artifact, baseDir, expectedTarget: 'mac-arm64' });
    expect(third.alreadyInstalled).toBe(false);
    expect(resolveInstalledDshRuntime(baseDir, '9.9.9')).toBe(third.root);
  });

  test('rejects a target mismatch and a corrupted archive', async () => {
    const runtimeDir = makeTempDir('dsh-inst-src2-');
    const distDir = makeTempDir('dsh-inst-dist2-');
    const baseDir = makeTempDir('dsh-inst-dest2-');
    writeFakeRuntime(runtimeDir);
    const manifestName = packFakeRuntime(runtimeDir, distDir, '9.9.8', 'win-x64');

    await expect(
      installDshRuntime({
        artifact: resolveDshArtifactFromManifest(distDir, manifestName),
        baseDir,
        expectedTarget: 'mac-arm64',
      })
    ).rejects.toThrow(/target/);

    // Corrupt the archive after the manifest recorded its hash.
    const manifest = JSON.parse(fs.readFileSync(path.join(distDir, manifestName), 'utf8')) as { archive: string };
    fs.appendFileSync(path.join(distDir, manifest.archive), 'garbage');
    await expect(
      installDshRuntime({
        artifact: resolveDshArtifactFromManifest(distDir, manifestName),
        baseDir,
        expectedTarget: 'win-x64',
      })
    ).rejects.toThrow(/size mismatch|sha256 mismatch/);
    expect(resolveInstalledDshRuntime(baseDir, '9.9.8')).toBeNull();
  });

  test('installs a newly pinned version beside the prior runtime', async () => {
    const distDir = makeTempDir('dsh-upgrade-dist-');
    const baseDir = makeTempDir('dsh-upgrade-dest-');
    const oldRuntime = makeTempDir('dsh-upgrade-old-');
    const newRuntime = makeTempDir('dsh-upgrade-new-');
    writeFakeRuntime(oldRuntime, 'old');
    writeFakeRuntime(newRuntime, 'new');
    const oldArtifact = resolveDshArtifactFromManifest(
      distDir,
      packFakeRuntime(oldRuntime, distDir, '0.1.0-rc.6', 'mac-arm64')
    );
    const newArtifact = resolveDshArtifactFromManifest(
      distDir,
      packFakeRuntime(newRuntime, distDir, '0.1.0-rc.7', 'mac-arm64')
    );

    const oldInstall = await installDshRuntime({ artifact: oldArtifact, baseDir, expectedTarget: 'mac-arm64' });
    const newInstall = await installDshRuntime({ artifact: newArtifact, baseDir, expectedTarget: 'mac-arm64' });

    expect(oldInstall.root).not.toBe(newInstall.root);
    expect(fs.existsSync(oldInstall.root)).toBe(true);
    expect(fs.existsSync(newInstall.root)).toBe(true);
    expect(
      resolveInstalledDshRuntime(baseDir, newArtifact.version, {
        target: newArtifact.target,
        sha256: newArtifact.sha256,
      })
    ).toBe(newInstall.root);
  });

  test('reinstalls the same version when its pinned digest changes', async () => {
    const distA = makeTempDir('dsh-repin-dist-a-');
    const distB = makeTempDir('dsh-repin-dist-b-');
    const baseDir = makeTempDir('dsh-repin-dest-');
    const runtimeA = makeTempDir('dsh-repin-a-');
    const runtimeB = makeTempDir('dsh-repin-b-');
    writeFakeRuntime(runtimeA, 'first artifact');
    writeFakeRuntime(runtimeB, 'replacement artifact');
    const artifactA = resolveDshArtifactFromManifest(
      distA,
      packFakeRuntime(runtimeA, distA, '0.1.0-rc.7', 'mac-arm64')
    );
    const artifactB = resolveDshArtifactFromManifest(
      distB,
      packFakeRuntime(runtimeB, distB, '0.1.0-rc.7', 'mac-arm64')
    );
    expect(artifactA.sha256).not.toBe(artifactB.sha256);

    await installDshRuntime({ artifact: artifactA, baseDir, expectedTarget: 'mac-arm64' });
    const replacement = await installDshRuntime({ artifact: artifactB, baseDir, expectedTarget: 'mac-arm64' });

    expect(replacement.alreadyInstalled).toBe(false);
    expect(fs.readFileSync(path.join(replacement.root, 'lib', 'bin.js'), 'utf8')).toContain('replacement artifact');
    expect(
      resolveInstalledDshRuntime(baseDir, artifactB.version, {
        target: artifactB.target,
        sha256: artifactB.sha256,
      })
    ).toBe(replacement.root);
  });

  test('marks an installed runtime only after it has reached readiness', async () => {
    const runtimeDir = makeTempDir('dsh-ready-src-');
    const distDir = makeTempDir('dsh-ready-dist-');
    const baseDir = makeTempDir('dsh-ready-dest-');
    writeFakeRuntime(runtimeDir);
    const artifact = resolveDshArtifactFromManifest(
      distDir,
      packFakeRuntime(runtimeDir, distDir, '0.1.0-rc.12', 'mac-arm64')
    );
    const installed = await installDshRuntime({ artifact, baseDir, expectedTarget: 'mac-arm64' });
    const sentinelPath = path.join(installed.root, INSTALL_SENTINEL);
    expect(JSON.parse(fs.readFileSync(sentinelPath, 'utf8')).lastReadyAt).toBeNull();

    expect(
      markInstalledDshRuntimeReady(baseDir, artifact.version, {
        target: artifact.target,
        sha256: artifact.sha256,
      })
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(sentinelPath, 'utf8')).lastReadyAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('pruneInstalledDshRuntimes', () => {
  test('keeps the active pin and the most recently installed previous version', async () => {
    const baseDir = makeTempDir('dsh-prune-');
    writeInstalledFakeRuntime(baseDir, '0.1.0-rc.8', 'mac-arm64', '8'.repeat(64), '2026-08-01T00:00:00Z');
    writeInstalledFakeRuntime(baseDir, '0.1.0-rc.9', 'mac-arm64', '9'.repeat(64), '2026-08-02T00:00:00Z');
    writeInstalledFakeRuntime(baseDir, '0.1.0-rc.10', 'mac-arm64', 'a'.repeat(64), '2026-08-03T00:00:00Z');
    writeInstalledFakeRuntime(baseDir, '0.1.0-rc.11', 'mac-arm64', 'b'.repeat(64), '2026-08-04T00:00:00Z');

    const result = await pruneInstalledDshRuntimes(baseDir, '0.1.0-rc.11', 1);

    expect(new Set(result.retained)).toEqual(new Set(['0.1.0-rc.10', '0.1.0-rc.11']));
    expect(new Set(result.removed)).toEqual(new Set(['0.1.0-rc.8', '0.1.0-rc.9']));
    expect(fs.existsSync(installedDshRuntimeRoot(baseDir, '0.1.0-rc.10'))).toBe(true);
    expect(fs.existsSync(installedDshRuntimeRoot(baseDir, '0.1.0-rc.11'))).toBe(true);
    expect(fs.existsSync(installedDshRuntimeRoot(baseDir, '0.1.0-rc.9'))).toBe(false);
  });

  test('does not retain a newer install that never became ready', async () => {
    const baseDir = makeTempDir('dsh-prune-failed-');
    writeInstalledFakeRuntime(
      baseDir,
      '0.1.0-rc.6',
      'mac-arm64',
      '6'.repeat(64),
      '2026-08-01T00:00:00Z',
      true,
      '2026-08-01T00:01:00Z'
    );
    writeInstalledFakeRuntime(
      baseDir,
      '0.1.0-rc.7',
      'mac-arm64',
      '7'.repeat(64),
      '2026-08-02T00:00:00Z',
      true,
      null
    );
    writeInstalledFakeRuntime(
      baseDir,
      '0.1.0-rc.8',
      'mac-arm64',
      '8'.repeat(64),
      '2026-08-03T00:00:00Z',
      true,
      '2026-08-03T00:01:00Z'
    );

    const result = await pruneInstalledDshRuntimes(baseDir, '0.1.0-rc.8', 1);

    expect(new Set(result.retained)).toEqual(new Set(['0.1.0-rc.6', '0.1.0-rc.8']));
    expect(result.removed).toEqual(['0.1.0-rc.7']);
  });
});
