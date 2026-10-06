import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, test, vi } from 'vitest';

const electronPaths = vi.hoisted(() => ({ appPath: '', userData: '' }));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: () => electronPaths.appPath,
    getPath: (name: string) => (name === 'userData' ? electronPaths.userData : '/tmp'),
    isReady: () => true,
    whenReady: async () => undefined,
    on: () => undefined,
  },
}));

import { DshEngineManager } from './dshEngineManager';
import { installedDshRuntimeRoot } from './dshRuntimeInstaller';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-pin-'));
const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

afterAll(() => {
  if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath);
  else Reflect.deleteProperty(process, 'resourcesPath');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function hostTarget(): string {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (process.platform === 'win32') return 'win-x64';
  return 'linux-x64';
}

function writeInstalledRuntime(version: string, target: string, sha256: string): string {
  const root = installedDshRuntimeRoot(path.join(electronPaths.userData, 'dsh-runtime'), version);
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'bin.js'), 'console.log("fake dsh")\n');
  const frontend = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist');
  fs.mkdirSync(frontend, { recursive: true });
  fs.writeFileSync(path.join(frontend, 'index.html'), '<!doctype html>\n');
  fs.writeFileSync(
    path.join(root, 'runtime-build-info.json'),
    `${JSON.stringify({ target, dshVersion: version, patchHash: 'test' }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(root, '.lobsterai-install-ok.json'),
    `${JSON.stringify(
      { installedAt: new Date().toISOString(), version, target, sha256 },
      null,
      2
    )}\n`
  );
  return root;
}

describe('DshEngineManager pinned runtime resolution', () => {
  test('ignores a valid old install and selects only the package-pinned identity', () => {
    electronPaths.appPath = path.join(tempRoot, 'app');
    electronPaths.userData = path.join(tempRoot, 'user-data');
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: path.join(tempRoot, 'resources'),
    });
    fs.mkdirSync(electronPaths.appPath, { recursive: true });
    const target = hostTarget();
    const pinnedVersion = '0.1.0-rc.10';
    const pinnedSha = 'a'.repeat(64);
    fs.writeFileSync(
      path.join(electronPaths.appPath, 'package.json'),
      `${JSON.stringify({
        dsh: {
          version: pinnedVersion,
          runtimes: {
            [target]: { url: 'https://cdn.example.com/dsh.tar.gz', sha256: pinnedSha, size: 123 },
          },
        },
      })}\n`
    );

    writeInstalledRuntime('0.1.0-rc.9', target, '9'.repeat(64));
    const manager = new DshEngineManager();
    expect(manager.resolveRuntime()).toBeNull();

    writeInstalledRuntime(pinnedVersion, target, 'b'.repeat(64));
    expect(manager.resolveRuntime()).toBeNull();

    const pinnedRoot = writeInstalledRuntime(pinnedVersion, target, pinnedSha);
    expect(manager.resolveRuntime()?.root).toBe(pinnedRoot);
  });
});
