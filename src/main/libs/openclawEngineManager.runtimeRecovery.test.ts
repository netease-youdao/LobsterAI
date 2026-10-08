import fs from 'fs';
import os from 'os';
import path from 'path';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OpenClawEngineErrorCode, OpenClawEnginePhase } from '../../shared/openclawEngine/constants';
import { OpenClawStartupCompatibilityMode } from '../../shared/openclawEngine/startupCompatibility';
import { OpenClawStartupMigrationStatus } from '../../shared/openclawEngine/startupMigration';

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
import { runOpenClawStartupCompatibility } from './openclawStartupCompatibility';
import { OPENCLAW_WORKER_SHIM_TARGETS } from './openclawWorkerShims';

vi.mock('./openclawGatewayProcess', async (importOriginal) => ({
  ...await importOriginal<typeof import('./openclawGatewayProcess')>(),
  spawnOpenClawGatewayProcess: vi.fn(),
}));
vi.mock('./openclawStartupCompatibility', async (importOriginal) => ({
  ...await importOriginal<typeof import('./openclawStartupCompatibility')>(),
  runOpenClawStartupCompatibility: vi.fn(),
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

  test('repair can resolve a stable gateway token before the first successful startup', () => {
    const manager = new OpenClawEngineManager();
    expect(manager.getGatewayToken()).toBeNull();

    const token = manager.ensureGatewayToken();

    expect(token).toMatch(/^[a-f0-9]{48}$/);
    expect(manager.getGatewayToken()).toBe(token);
    expect(manager.ensureGatewayToken()).toBe(token);
    expect(fs.readFileSync(path.join(manager.getStateDir(), 'gateway-token'), 'utf8')).toBe(token);
    expect(spawnOpenClawGatewayProcess).not.toHaveBeenCalled();
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

  test.each([false, true])('prepares existing SQLite before spawning, with legacy discovery=%s', async legacyDiscovery => {
    setProcessProperty('platform', 'darwin');
    fs.writeFileSync(path.join(resourcesDir, 'cfmind', 'openclaw.mjs'), 'export {};\n');
    const manager = new OpenClawEngineManager();
    vi.spyOn(manager, 'ensureReady').mockResolvedValue({ phase: OpenClawEnginePhase.Ready } as ReturnType<typeof manager.getStatus>);
    const internals = manager as unknown as { resolveGatewayPort: () => Promise<number>; ensureBundledCliShims: () => string };
    vi.spyOn(internals, 'resolveGatewayPort').mockResolvedValue(19763);
    vi.spyOn(internals, 'ensureBundledCliShims').mockReturnValue('');
    const databasePath = path.join(manager.getStateDir(), 'state', 'openclaw.sqlite');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(databasePath, 'migration owns this database');
    fs.writeFileSync(manager.getConfigPath(), JSON.stringify({ gateway: { mode: 'local' },
      plugins: legacyDiscovery ? { bundledDiscovery: 'compat' } : {} }));
    vi.mocked(runOpenClawStartupCompatibility).mockResolvedValueOnce({
      status: OpenClawStartupMigrationStatus.Failed, error: 'Shared-state snapshot failed',
    });

    await expect(manager.startGateway('schema-migration-test')).resolves.toMatchObject({
      phase: OpenClawEnginePhase.Error, errorCode: OpenClawEngineErrorCode.StartupCompatibilityFailed,
      message: 'Shared-state snapshot failed',
    });
    expect(runOpenClawStartupCompatibility).toHaveBeenLastCalledWith(expect.objectContaining({
      stateDir: manager.getStateDir(), mode: OpenClawStartupCompatibilityMode.PrepareStartup,
    }));
    expect(spawnOpenClawGatewayProcess).not.toHaveBeenCalled();
    expect(fs.readFileSync(databasePath, 'utf8')).toBe('migration owns this database');
  });

  const prepareSpawnlessStartup = () => {
    setProcessProperty('platform', 'darwin');
    fs.writeFileSync(path.join(resourcesDir, 'cfmind', 'openclaw.mjs'), 'export {};\n');
    const manager = new OpenClawEngineManager();
    vi.spyOn(manager, 'ensureReady').mockResolvedValue({ phase: OpenClawEnginePhase.Ready } as ReturnType<typeof manager.getStatus>);
    const internals = manager as unknown as {
      resolveGatewayPort: () => Promise<number>;
      ensureBundledCliShims: () => string;
    };
    vi.spyOn(internals, 'resolveGatewayPort').mockResolvedValue(19763);
    vi.spyOn(internals, 'ensureBundledCliShims').mockReturnValue('');
    const databasePath = path.join(manager.getStateDir(), 'state', 'openclaw.sqlite');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(databasePath, 'migration owns this database');
    fs.writeFileSync(manager.getConfigPath(), JSON.stringify({ gateway: { mode: 'local' } }));
    const order: string[] = [];
    vi.mocked(runOpenClawStartupCompatibility).mockImplementationOnce(async () => {
      order.push('startup-compatibility');
      return { status: OpenClawStartupMigrationStatus.Failed, error: 'stop after preparation' };
    });
    return { manager, internals, order };
  };

  test('ordinary startup preserves retired config and unreadable session indexes for Quick Repair', async () => {
    const { manager, order } = prepareSpawnlessStartup();
    const legacyStore = path.join(manager.getStateDir(), 'agents', 'main', 'sessions', 'sessions.json');
    fs.mkdirSync(path.dirname(legacyStore), { recursive: true });
    fs.writeFileSync(legacyStore, '\uFEFFnot json');
    const config = JSON.stringify({ gateway: { mode: 'local' }, session: { maintenance: { rotateBytes: 1000 } } });
    fs.writeFileSync(manager.getConfigPath(), config);

    await manager.startGateway('legacy-data-test');

    expect(order).toEqual(['startup-compatibility']);
    expect(fs.readFileSync(manager.getConfigPath(), 'utf8')).toBe(config);
    expect(fs.readFileSync(legacyStore, 'utf8')).toBe('\uFEFFnot json');
    expect(fs.readdirSync(path.dirname(legacyStore))).toEqual(['sessions.json']);
    expect(spawnOpenClawGatewayProcess).not.toHaveBeenCalled();
  });

  test('leaves missing managed plugin load paths for backed-up Quick Repair', async () => {
    const { manager } = prepareSpawnlessStartup();
    // Left by a previous install location; a failed config sync never rewrites it.
    const missingRuntimeDir = path.join(tempDir, 'old-install', 'resources', 'cfmind', 'third-party-extensions');
    const userDataDir = path.join(tempDir, 'user-data', 'third-party-extensions');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(manager.getConfigPath(), JSON.stringify({
      gateway: { mode: 'local', port: 18789 },
      plugins: { load: { paths: [missingRuntimeDir, userDataDir] }, entries: { browser: { enabled: true } } },
    }));
    let configSeenByHelper: unknown;
    vi.mocked(runOpenClawStartupCompatibility).mockReset().mockImplementationOnce(async () => {
      configSeenByHelper = JSON.parse(fs.readFileSync(manager.getConfigPath(), 'utf8'));
      return { status: OpenClawStartupMigrationStatus.Failed, error: 'stop after preparation' };
    });

    await manager.startGateway('missing-plugin-load-path-test');

    expect(configSeenByHelper).toEqual({
      gateway: { mode: 'local', port: 18789 },
      plugins: { load: { paths: [missingRuntimeDir, userDataDir] }, entries: { browser: { enabled: true } } },
    });
    expect(spawnOpenClawGatewayProcess).not.toHaveBeenCalled();
  });
});
