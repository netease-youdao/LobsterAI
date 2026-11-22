import fs from 'fs';
import os from 'os';
import path from 'path';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  hasBundledRuntimeEntry,
  INSTALLER_RESOURCES_MARKER,
  INSTALLER_RESOURCES_TAR,
  recoverInstallerResourcesFromTar,
} from './installerResourceRecovery';

describe('installerResourceRecovery', () => {
  let workDir: string;
  let resourcesDir: string;

  const tarPath = () => path.join(resourcesDir, INSTALLER_RESOURCES_TAR);
  const markerPath = () => path.join(resourcesDir, INSTALLER_RESOURCES_MARKER);
  const dshEntryPath = () => path.join(resourcesDir, 'dsh-runtime', 'lib', 'bin.js');
  const hostBundleManifestPath = () => path.join(resourcesDir, 'dsh-bundles', 'lobsterai-host', 'package.json');

  const createInstallerTar = async (): Promise<void> => {
    const stagingDir = path.join(workDir, 'staging');
    fs.mkdirSync(path.join(stagingDir, 'dsh-runtime', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(stagingDir, 'dsh-bundles', 'lobsterai-host'), { recursive: true });
    fs.mkdirSync(path.join(stagingDir, 'python-win'), { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'dsh-runtime', 'lib', 'bin.js'), 'export async function runCli() {}\n');
    fs.writeFileSync(
      path.join(stagingDir, 'dsh-bundles', 'lobsterai-host', 'package.json'),
      JSON.stringify({ name: '@lobsterai/dsh-host', version: '1.0.0' }),
    );
    fs.writeFileSync(path.join(stagingDir, 'python-win', 'python.exe'), 'fake-binary');
    await tar.create(
      { file: tarPath(), cwd: stagingDir },
      ['dsh-runtime', 'dsh-bundles', 'python-win'],
    );
  };

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-recovery-'));
    resourcesDir = path.join(workDir, 'resources');
    // The installer pre-creates dsh-runtime as an empty directory before extraction
    // starts, so a broken install has the directory but no entry files.
    fs.mkdirSync(path.join(resourcesDir, 'dsh-runtime'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('recovers the DSH runtime and host bundle from a leftover installer tar and cleans up', async () => {
    await createInstallerTar();
    expect(hasBundledRuntimeEntry(resourcesDir)).toBe(false);

    const progressCalls: number[] = [];
    const result = await recoverInstallerResourcesFromTar(resourcesDir, 'test', (progress) => {
      progressCalls.push(progress.bytes);
    });

    expect(result.attempted).toBe(true);
    expect(result.success).toBe(true);
    expect(result.entries).toBeGreaterThan(0);
    expect(hasBundledRuntimeEntry(resourcesDir)).toBe(true);
    expect(fs.existsSync(dshEntryPath())).toBe(true);
    expect(fs.existsSync(hostBundleManifestPath())).toBe(true);
    expect(fs.existsSync(path.join(resourcesDir, 'python-win', 'python.exe'))).toBe(true);
    // Mirrors the installer success path: marker stamped, archive removed.
    expect(fs.existsSync(markerPath())).toBe(true);
    expect(fs.existsSync(tarPath())).toBe(false);
    // Initial progress callback fires so callers can surface an installing state.
    expect(progressCalls[0]).toBe(0);
  });

  test('is a no-op when both DSH runtime entry and host bundle manifest are already present', async () => {
    await createInstallerTar();
    fs.mkdirSync(path.dirname(dshEntryPath()), { recursive: true });
    fs.mkdirSync(path.dirname(hostBundleManifestPath()), { recursive: true });
    fs.writeFileSync(dshEntryPath(), 'export async function runCli() {}\n');
    fs.writeFileSync(hostBundleManifestPath(), '{"name":"@lobsterai/dsh-host"}');

    const result = await recoverInstallerResourcesFromTar(resourcesDir, 'test');

    expect(result.attempted).toBe(false);
    expect(result.success).toBe(true);
    expect(fs.existsSync(tarPath())).toBe(true);
  });

  test('recovers when dsh-runtime/lib/bin.js exists without dsh-bundles/lobsterai-host/package.json', async () => {
    await createInstallerTar();
    fs.mkdirSync(path.dirname(dshEntryPath()), { recursive: true });
    fs.writeFileSync(dshEntryPath(), 'export const incomplete = true;\n');
    expect(hasBundledRuntimeEntry(resourcesDir)).toBe(false);

    const result = await recoverInstallerResourcesFromTar(resourcesDir, 'test');

    expect(result.attempted).toBe(true);
    expect(result.success).toBe(true);
    expect(hasBundledRuntimeEntry(resourcesDir)).toBe(true);
    expect(JSON.parse(fs.readFileSync(hostBundleManifestPath(), 'utf8'))).toMatchObject({
      name: '@lobsterai/dsh-host',
    });
  });

  test('recovers when dsh-bundles/lobsterai-host/package.json exists without dsh-runtime/lib/bin.js', async () => {
    await createInstallerTar();
    fs.mkdirSync(path.dirname(hostBundleManifestPath()), { recursive: true });
    fs.writeFileSync(hostBundleManifestPath(), '{"name":"@lobsterai/dsh-host"}');
    expect(hasBundledRuntimeEntry(resourcesDir)).toBe(false);

    const result = await recoverInstallerResourcesFromTar(resourcesDir, 'test');

    expect(result.attempted).toBe(true);
    expect(result.success).toBe(true);
    expect(hasBundledRuntimeEntry(resourcesDir)).toBe(true);
    expect(fs.existsSync(dshEntryPath())).toBe(true);
  });

  test('does not treat legacy cfmind files as a valid bundled DSH runtime', () => {
    fs.mkdirSync(path.join(resourcesDir, 'cfmind'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, 'cfmind', 'gateway-bundle.mjs'), 'export const legacy = true;\n');
    fs.writeFileSync(path.join(resourcesDir, 'cfmind', 'web-tree-sitter.wasm'), 'legacy-wasm');

    expect(hasBundledRuntimeEntry(resourcesDir)).toBe(false);
  });

  test('reports failure when no tar is left to recover from', async () => {
    const result = await recoverInstallerResourcesFromTar(resourcesDir, 'test');

    expect(result.attempted).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('keeps the tar when extraction fails so it can be retried', async () => {
    fs.writeFileSync(tarPath(), 'this is not a tar archive');

    const result = await recoverInstallerResourcesFromTar(resourcesDir, 'test');

    expect(result.attempted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(fs.existsSync(tarPath())).toBe(true);
    expect(fs.existsSync(markerPath())).toBe(false);
  });

  test('keeps the tar when the archive does not contain required DSH runtime entries', async () => {
    const stagingDir = path.join(workDir, 'staging');
    fs.mkdirSync(path.join(stagingDir, 'SKILLs'), { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'SKILLs', 'readme.txt'), 'no runtime here');
    await tar.create({ file: tarPath(), cwd: stagingDir }, ['SKILLs']);

    const result = await recoverInstallerResourcesFromTar(resourcesDir, 'test');

    expect(result.attempted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.error).toContain('still missing');
    expect(fs.existsSync(tarPath())).toBe(true);
  });

  test('concurrent callers share a single in-flight recovery', async () => {
    await createInstallerTar();

    const first = recoverInstallerResourcesFromTar(resourcesDir, 'test-a');
    const second = recoverInstallerResourcesFromTar(resourcesDir, 'test-b');

    expect(second).toBe(first);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.success).toBe(true);
    expect(secondResult).toBe(firstResult);
  });
});
