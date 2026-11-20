import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { DshHostPhase } from '../../../shared/dshEngine/hostConstants';
import { DshHostManager, resolveBundledDshPaths } from './dshHostManager';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-dsh-host-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveBundledDshPaths', () => {
  test('resolves dev layout under vendor/dsh-runtime/current and dsh-bundles/', () => {
    const root = createTempDir();
    const res = resolveBundledDshPaths({ isPackaged: false, appRootDir: root });
    expect(res.runtimeDir).toBe(path.join(root, 'vendor', 'dsh-runtime', 'current'));
    expect(res.hostBundleDir).toBe(path.join(root, 'dsh-bundles', 'lobsterai-host'));
    expect(res.channelsBundleDir).toBeNull();
  });

  test('resolves packaged layout under resourcesPath and detects channels bundle when present', () => {
    const resources = createTempDir();
    const channelsDir = path.join(resources, 'dsh-bundles', 'lobsterai-channels');
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.writeFileSync(path.join(channelsDir, 'package.json'), '{"name":"@lobsterai/dsh-channels"}');

    const res = resolveBundledDshPaths({
      isPackaged: true,
      appRootDir: '/ignored',
      resourcesDir: resources,
    });
    expect(res.runtimeDir).toBe(path.join(resources, 'dsh-runtime'));
    expect(res.hostBundleDir).toBe(path.join(resources, 'dsh-bundles', 'lobsterai-host'));
    expect(res.channelsBundleDir).toBe(channelsDir);
  });
});

describe('DshHostManager', () => {
  test('reports initial stopped status and fails clearly when runtime binary is missing', async () => {
    const temp = createTempDir();
    const manager = new DshHostManager({
      userDataDir: path.join(temp, 'userData'),
      runtimeDir: path.join(temp, 'missing-runtime'),
      hostBundleDir: path.join(temp, 'host-bundle'),
      skillsDir: path.join(temp, 'skills'),
      executablePath: process.execPath,
      skipElectronRunAsNode: true,
    });

    expect(manager.getStatus().phase).toBe(DshHostPhase.Stopped);
    expect(manager.isReady()).toBe(false);

    // Attach error listener so EventEmitter does not throw unhandled error.
    const errors: Error[] = [];
    manager.on('error', (err: Error) => errors.push(err));

    await expect(manager.start()).rejects.toThrow(/DSH runtime binary not found/);
    expect(manager.getStatus().phase).toBe(DshHostPhase.Failed);
    expect(errors.length).toBe(1);

    await manager.stop();
    expect(manager.getStatus().phase).toBe(DshHostPhase.Stopped);
  });

  test('caches sync payloads safely while stopped before host is ready', async () => {
    const temp = createTempDir();
    const manager = new DshHostManager({
      userDataDir: path.join(temp, 'userData'),
      runtimeDir: path.join(temp, 'runtime'),
      hostBundleDir: path.join(temp, 'host-bundle'),
      skillsDir: path.join(temp, 'skills'),
      executablePath: process.execPath,
      skipElectronRunAsNode: true,
    });

    const provRes = await manager.syncProviders({ providers: [] });
    const mcpRes = await manager.syncMcpServers([]);
    const skillRes = await manager.syncSkillsPolicy({ disabledIds: ['foo'] });
    const toolsRes = await manager.syncHostTools([]);

    expect(provRes).toEqual({ deferred: true });
    expect(mcpRes).toEqual({ deferred: true });
    expect(skillRes).toEqual({ deferred: true });
    expect(toolsRes).toEqual({ deferred: true });
  });
});
