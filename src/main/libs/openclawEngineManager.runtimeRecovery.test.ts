import fs from 'fs';
import os from 'os';
import path from 'path';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OpenClawEngineErrorCode, OpenClawEnginePhase } from '../../shared/openclawEngine/constants';

const electronState = vi.hoisted(() => ({
  appPath: process.cwd(),
  isPackaged: true,
  userDataPath: process.cwd(),
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => electronState.appPath,
    getPath: () => electronState.userDataPath,
    get isPackaged() {
      return electronState.isPackaged;
    },
  },
  utilityProcess: {
    fork: vi.fn(),
  },
}));

import { INSTALLER_RESOURCES_TAR } from './installerResourceRecovery';
import { OpenClawEngineManager } from './openclawEngineManager';
import { spawnOpenClawGatewayProcess } from './openclawGatewayProcess';
import { OPENCLAW_WORKER_SHIM_TARGETS } from './openclawWorkerShims';

vi.mock('./openclawGatewayProcess', async (importOriginal) => ({
  ...await importOriginal<typeof import('./openclawGatewayProcess')>(),
  spawnOpenClawGatewayProcess: vi.fn(),
}));
import {
  migrateLegacyOpenClawPluginInstalls,
  OpenClawPluginInstallMigrationStatus,
} from './openclawPluginInstallMigration';

describe('OpenClawEngineManager startup runtime recovery', () => {
  let tempDir: string;
  let resourcesDir: string;
  let originalPlatform: PropertyDescriptor | undefined;
  let originalResourcesPath: PropertyDescriptor | undefined;

  const setProcessProperty = (key: 'platform' | 'resourcesPath', value: string): void => {
    Object.defineProperty(process, key, {
      configurable: true,
      enumerable: true,
      value,
    });
  };

  const restoreProcessProperty = (
    key: 'platform' | 'resourcesPath',
    descriptor: PropertyDescriptor | undefined,
  ): void => {
    if (descriptor) {
      Object.defineProperty(process, key, descriptor);
    } else {
      delete (process as NodeJS.Process & { resourcesPath?: string })[key];
    }
  };

  const createInstallerTar = async (): Promise<void> => {
    const stagingDir = path.join(tempDir, 'staging');
    fs.mkdirSync(path.join(stagingDir, 'cfmind'), { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'cfmind', 'openclaw.mjs'), 'export {}\n');
    await tar.create(
      { file: path.join(resourcesDir, INSTALLER_RESOURCES_TAR), cwd: stagingDir },
      ['cfmind'],
    );
  };

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-startup-recovery-'));
    resourcesDir = path.join(tempDir, 'resources');
    fs.mkdirSync(path.join(resourcesDir, 'cfmind'), { recursive: true });
    electronState.appPath = tempDir;
    electronState.isPackaged = true;
    electronState.userDataPath = path.join(tempDir, 'user-data');
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    setProcessProperty('platform', 'win32');
    setProcessProperty('resourcesPath', resourcesDir);
    await createInstallerTar();
  });

  afterEach(() => {
    restoreProcessProperty('platform', originalPlatform);
    restoreProcessProperty('resourcesPath', originalResourcesPath);
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('recovers an empty runtime before legacy plugin migration and remains idempotent', async () => {
    const manager = new OpenClawEngineManager();
    const runtimeRoot = fs.realpathSync(path.join(resourcesDir, 'cfmind'));
    const cliPath = path.join(runtimeRoot, 'openclaw.mjs');
    const configPath = manager.getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify({
      plugins: {
        installs: {
          demo: { source: 'npm', spec: 'demo@1.0.0' },
        },
      },
    }));

    // The empty directory resolves as a root, but cannot run the migration yet.
    expect(manager.getRuntimeRoot()).toBe(runtimeRoot);
    expect(fs.existsSync(cliPath)).toBe(false);

    await manager.prepareRuntimeForStartupConfigSync();

    expect(fs.existsSync(cliPath)).toBe(true);
    expect(fs.existsSync(path.join(resourcesDir, INSTALLER_RESOURCES_TAR))).toBe(false);

    const runner = vi.fn(async () => {
      fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }));
      return { code: 0, stdout: '', stderr: '' };
    });
    const migration = await migrateLegacyOpenClawPluginInstalls({
      configPath,
      stateDir: manager.getStateDir(),
      runtimeRoot: manager.getRuntimeRoot(),
      electronNodeRuntimePath: '/electron/node',
      env: {},
      runner,
    });

    expect(migration).toEqual({ status: OpenClawPluginInstallMigrationStatus.Migrated });
    expect(runner).toHaveBeenCalledOnce();

    // Gateway startup may call the same recovery path later; it must not
    // extract again or require the installer archive after the first success.
    await manager.prepareRuntimeForStartupConfigSync('second-check');
    expect(fs.readFileSync(cliPath, 'utf8')).toBe('export {}\n');
  });

  test('does not extract installer resources on macOS', async () => {
    setProcessProperty('platform', 'darwin');
    const manager = new OpenClawEngineManager();
    const tarPath = path.join(resourcesDir, INSTALLER_RESOURCES_TAR);

    await manager.prepareRuntimeForStartupConfigSync();

    expect(fs.existsSync(path.join(resourcesDir, 'cfmind', 'openclaw.mjs'))).toBe(false);
    expect(fs.existsSync(tarPath)).toBe(true);
  });

  test('blocks a damaged bundled runtime before migrations or spawning and retains the cause on retry', async () => {
    const runtimeRoot = path.join(resourcesDir, 'cfmind');
    fs.writeFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'export {};\n');
    // Root shims can survive while every dist worker has been deleted.
    for (const { shimFile } of OPENCLAW_WORKER_SHIM_TARGETS) {
      fs.writeFileSync(path.join(runtimeRoot, shimFile), 'import "./dist/missing.js";\n');
    }
    const manager = new OpenClawEngineManager();
    const originalConfig = '{"gateway":{"mode":"local"}}\n';
    fs.writeFileSync(manager.getConfigPath(), originalConfig);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(manager.startGateway('worker-integrity-test')).resolves.toMatchObject({
        phase: OpenClawEnginePhase.Error,
        errorCode: OpenClawEngineErrorCode.RuntimeFilesMissing,
        canRetry: false,
      });
    }
    expect(spawnOpenClawGatewayProcess).not.toHaveBeenCalled();
    expect(fs.readFileSync(manager.getConfigPath(), 'utf8')).toBe(originalConfig);
    expect(fs.existsSync(path.join(manager.getStateDir(), 'gateway-token'))).toBe(false);
  });
});
