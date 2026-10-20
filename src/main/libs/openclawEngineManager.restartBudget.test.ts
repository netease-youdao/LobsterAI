import { type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OpenClawEnginePhase } from '../../shared/openclawEngine/constants';
import { PythonEncodingEnv } from './pythonEncodingEnv';

// These tests drive the real startGateway -> doStartGateway success path, so a
// healthy start that refills the restart budget too early fails them. Only the
// disk, runtime and process I/O around the spawn is stubbed.
const spawnState = vi.hoisted(() => ({ children: [] as unknown[] }));

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => '/test-profile', isPackaged: false, getVersion: () => '2026.9.24' },
}));
vi.mock('./openclawLocalExtensions', () => ({
  syncLocalOpenClawExtensionsIntoRuntime: () => ({ copied: [] }),
  cleanupStaleThirdPartyPluginsFromBundledDir: () => [],
  listLocalOpenClawExtensionIds: () => [],
}));
vi.mock('./coworkUtil', () => ({
  ensureElectronNodeShim: () => null,
  getElectronNodeRuntimePath: () => '/electron/node',
  getSkillsRoot: () => '/skills',
}));
vi.mock('./openaiCodexAuth', () => ({ getCodexHomeDir: () => '/codex' }));
vi.mock('./systemProxy', () => ({
  isSystemProxyEnabled: () => false,
  resolveSystemProxyUrlForTargets: async () => ({ proxyUrl: null, targetUrl: null }),
  setActiveSystemProxyUrl: () => {},
}));
vi.mock('./openclawWorkerShims', async (importOriginal) => ({
  ...await importOriginal<typeof import('./openclawWorkerShims')>(),
  getMissingOpenClawWorkerTargets: () => [],
}));
vi.mock('./openclawStartupPrep', async (importOriginal) => ({
  ...await importOriginal<typeof import('./openclawStartupPrep')>(),
  resolveStartupPrepIdentity: () => 'identity',
}));
vi.mock('./openclawCronLegacyMigration', () => ({ migrateLegacyCronStorageWithDoctor: async () => undefined }));
vi.mock('./openclawSessionLegacyMigration', () => ({
  migrateLegacySessionStorageWithDoctor: async () => ({ status: 'skipped', reason: 'no-legacy-session-files' }),
}));
vi.mock('./openclawMemoryIndexMigration', () => ({ migrateAllFtsOnlyMemoryIndexes: vi.fn(async () => undefined) }));
vi.mock('./openclawStartupCheckpoint', () => ({
  describeStartupMigrationCheckpoint: () => 'unchanged',
  readStartupMigrationCheckpointStamp: vi.fn(() => null),
}));
vi.mock('./openclawGatewayProcess', async (importOriginal) => {
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  return {
    ...await importOriginal<typeof import('./openclawGatewayProcess')>(),
    spawnOpenClawGatewayProcess: vi.fn(() => {
      const child = Object.assign(new EventEmitter(), {
        pid: 1000 + spawnState.children.length,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: vi.fn(() => true),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      spawnState.children.push(child);
      return child;
    }),
  };
});

import { OpenClawAccountRecovery } from './openclawAccountRecovery';
import { OpenClawEngineManager } from './openclawEngineManager';
import { spawnOpenClawGatewayProcess } from './openclawGatewayProcess';
import { migrateAllFtsOnlyMemoryIndexes } from './openclawMemoryIndexMigration';
import { readStartupMigrationCheckpointStamp } from './openclawStartupCheckpoint';

const originalPlatform = process.platform;

interface BudgetInternals {
  gatewayProcess: ChildProcess | null;
  gatewayRecentOutput: WeakMap<ChildProcess, string[]>;
  gatewayRestartAttempt: number;
  stopGatewayProcess: (child: ChildProcess) => Promise<void>;
  isGatewayStartupReady: (port: number) => Promise<boolean>;
}

function makeManager() {
  const fixtures = path.join(process.cwd(), 'fixtures');
  // Avoid the constructor's user-data/runtime setup, as the restart tests do.
  const manager = Object.assign(Object.create(OpenClawEngineManager.prototype), {
    status: { phase: OpenClawEnginePhase.Ready, version: '2026.8.1', canRetry: false },
    desiredVersion: '2026.8.1',
    baseDir: fixtures,
    stateDir: path.join(fixtures, 'state'),
    configPath: path.join(fixtures, 'state', 'openclaw.json'),
    logsDir: path.join(fixtures, 'logs'),
    secretEnvVars: {},
    gatewayProcessSecretEnvVars: null,
    gatewayProcessConfigRaw: null,
    gatewayProcess: null,
    gatewayGeneration: 0,
    gatewaySpawnedAt: null,
    gatewayRecentOutput: new WeakMap(),
    gatewayLastOutputAt: new WeakMap(),
    gatewayGenerationByProcess: new WeakMap(),
    gatewayFailureByProcess: new WeakMap(),
    expectedGatewayExits: new WeakSet(),
    gatewayReadyProcesses: new WeakSet(),
    startupPrepSkippedProcesses: new WeakSet(),
    startupPrepMarker: { check: vi.fn(), record: vi.fn(), clear: vi.fn() },
    startupPrerequisite: null,
    startupCompatibilityRunner: null,
    gatewayRestartTimer: null,
    gatewayRestartWait: null,
    gatewayRestartAttempt: 0,
    gatewayRestartBudgetResetTimer: null,
    gatewayLifecycleGeneration: 0,
    gatewayMaintenanceActive: false,
    gatewayStartupBlock: null,
    shutdownRequested: false,
    gatewayPort: 18789,
    startGatewayPromise: null,
    stopGatewayPromise: null,
    restartGatewayPromise: null,
    gatewaySelfRestartNotedAt: null,
    resolveRuntimeMetadata: () => ({ root: '/runtime', version: '2026.8.1' }),
    cleanupStaleGatewayLocksSafely: vi.fn(),
    maybeRecoverInstallerResources: vi.fn(async () => {}),
    ensureBareEntryFiles: vi.fn(),
    resolveOpenClawEntry: vi.fn(() => '/runtime/openclaw.mjs'),
    ensureGatewayToken: vi.fn(() => 'token'),
    resolveGatewayPort: vi.fn(async () => 18789),
    writeGatewayPort: vi.fn(),
    ensureConfigFile: vi.fn(() => false),
    ensureBundledCliShims: vi.fn(() => ''),
    attachGatewayProcessLogs: vi.fn(),
    checkStartupPrep: vi.fn(() => ({ skip: true })),
    isGatewayStartupReady: vi.fn(async () => true),
  }) as OpenClawEngineManager;
  const internals = manager as unknown as BudgetInternals;
  // A plugin that fails some time after the gateway reported ready.
  const crashRunningGateway = () => {
    const child = internals.gatewayProcess!;
    internals.gatewayRecentOutput.set(child, ['[stderr] Error: extension driver crashed']);
    child.exitCode = 1;
    child.emit('exit', 1);
    child.emit('close', 1);
  };
  return { manager, internals, crashRunningGateway };
}

beforeEach(() => {
  spawnState.children.length = 0;
  vi.mocked(migrateAllFtsOnlyMemoryIndexes).mockReset().mockResolvedValue(undefined);
  vi.mocked(readStartupMigrationCheckpointStamp).mockReset().mockReturnValue(null);
  vi.useFakeTimers();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OpenClaw gateway Python environment', () => {
  test('startup and restart supply UTF-8 even when the Electron parent has no encoding variables', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv(PythonEncodingEnv.Utf8, undefined);
    vi.stubEnv(PythonEncodingEnv.IoEncoding, undefined);
    const { manager, crashRunningGateway } = makeManager();

    await manager.startGateway('initial-start');
    expect(vi.mocked(spawnOpenClawGatewayProcess).mock.lastCall?.[0].env)
      .toMatchObject({ [PythonEncodingEnv.Utf8]: '1', [PythonEncodingEnv.IoEncoding]: 'utf-8' });

    crashRunningGateway();
    await manager.restartGateway('encoding-regression');
    expect(vi.mocked(spawnOpenClawGatewayProcess).mock.lastCall?.[0].env)
      .toMatchObject({ [PythonEncodingEnv.Utf8]: '1', [PythonEncodingEnv.IoEncoding]: 'utf-8' });
    expect(process.env[PythonEncodingEnv.Utf8]).toBeUndefined();
    expect(process.env[PythonEncodingEnv.IoEncoding]).toBeUndefined();
  });

  test('startup preserves explicit Python encoding settings', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv(PythonEncodingEnv.Utf8, '0');
    vi.stubEnv(PythonEncodingEnv.IoEncoding, 'gbk');
    const { manager } = makeManager();

    await manager.startGateway('initial-start');
    expect(vi.mocked(spawnOpenClawGatewayProcess).mock.lastCall?.[0].env)
      .toMatchObject({ [PythonEncodingEnv.Utf8]: '0', [PythonEncodingEnv.IoEncoding]: 'gbk' });
  });
});

// Crashes the gateway 1s after every healthy start until the supervisor gives
// up, and returns the restart attempt counter seen after each crash.
async function crashUntilSupervisorGivesUp(harness: ReturnType<typeof makeManager>): Promise<number[]> {
  const { manager, internals, crashRunningGateway } = harness;
  await expect(manager.startGateway('initial-start')).resolves.toMatchObject({ phase: OpenClawEnginePhase.Running });
  const attempts: number[] = [];
  for (let cycle = 0; cycle < 12; cycle += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
    crashRunningGateway();
    attempts.push(internals.gatewayRestartAttempt);
    if (manager.getStatus().phase === OpenClawEnginePhase.Error) break;
    // Longer than any backoff step, shorter than the stability window.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(manager.getStatus().phase).toBe(OpenClawEnginePhase.Running);
  }
  return attempts;
}

describe('OpenClaw gateway restart budget across healthy starts', () => {
  test('a gateway that crashes soon after every healthy start exhausts the budget and stays stopped', async () => {
    const harness = makeManager();
    const { manager } = harness;

    expect(await crashUntilSupervisorGivesUp(harness)).toEqual([1, 2, 3, 4, 5, 5]);
    expect(spawnState.children).toHaveLength(6);
    expect(manager.getStatus()).toMatchObject({ phase: OpenClawEnginePhase.Error, canRetry: true });
    expect(manager.isGatewayStartupBlocked()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    // The WS reconnect loop, session startup and config sync must not relaunch
    // the crashing gateway behind the error.
    for (const reason of ['channel-sync-ensure-ready', 'ensure-running-for-cowork']) {
      await expect(manager.startGateway(reason)).resolves.toMatchObject({ phase: OpenClawEnginePhase.Error });
    }
    await expect(manager.restartGateway('config-sync:test')).resolves.toMatchObject({ phase: OpenClawEnginePhase.Error });
    expect(spawnState.children).toHaveLength(6);
  });

  test('a gateway that stays healthy past the stability window gets a fresh budget', async () => {
    const { manager, internals, crashRunningGateway } = makeManager();
    await manager.startGateway('initial-start');
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      crashRunningGateway();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(internals.gatewayRestartAttempt).toBe(4);

    await vi.advanceTimersByTimeAsync(61_000);
    crashRunningGateway();

    expect(internals.gatewayRestartAttempt).toBe(1);
    expect(manager.getStatus().phase).toBe(OpenClawEnginePhase.Starting);
  });

  test('a manual restart clears the exhausted budget', async () => {
    const harness = makeManager();
    const { manager, internals, crashRunningGateway } = harness;
    await crashUntilSupervisorGivesUp(harness);

    await expect(manager.restartGateway('ipc-manual', { retryBlocked: true }))
      .resolves.toMatchObject({ phase: OpenClawEnginePhase.Running });
    expect(manager.isGatewayStartupBlocked()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    crashRunningGateway();

    expect(internals.gatewayRestartAttempt).toBe(1);
    expect(manager.getStatus().phase).toBe(OpenClawEnginePhase.Starting);
  });

  test('Quick Repair clears the exhausted budget', async () => {
    const harness = makeManager();
    const { manager, internals, crashRunningGateway } = harness;
    await crashUntilSupervisorGivesUp(harness);

    await manager.withGatewayStoppedForRepair(async () => undefined);
    await expect(manager.startGateway('manual-repair', { retryBlocked: true }))
      .resolves.toMatchObject({ phase: OpenClawEnginePhase.Running });
    expect(manager.isGatewayStartupBlocked()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    crashRunningGateway();

    expect(internals.gatewayRestartAttempt).toBe(1);
    expect(manager.getStatus().phase).toBe(OpenClawEnginePhase.Starting);
  });
});

describe('OpenClaw gateway spawn secrets', () => {
  test('the live process keeps the secrets it was spawned with until it exits', async () => {
    const { manager, crashRunningGateway } = makeManager();
    manager.setSecretEnvVars({ LOBSTER_APIKEY_QWEN: 'spawned-key' });
    await manager.startGateway('initial-start');
    manager.setSecretEnvVars({ LOBSTER_APIKEY_QWEN: 'rotated-key' });

    expect(vi.mocked(spawnOpenClawGatewayProcess).mock.lastCall?.[0].env)
      .toMatchObject({ LOBSTER_APIKEY_QWEN: 'spawned-key' });
    expect(manager.getGatewayProcessSecretEnvVars()).toEqual({ LOBSTER_APIKEY_QWEN: 'spawned-key' });

    crashRunningGateway();
    expect(manager.getGatewayProcessSecretEnvVars()).toBeNull();
  });
});

describe('OpenClaw gateway spawn config', () => {
  test('the live process keeps the config file content it was spawned with until it exits', async () => {
    const { manager, crashRunningGateway } = makeManager();
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-spawn-config-'));
    const configPath = path.join(configDir, 'openclaw.json');
    Object.assign(manager, { configPath });
    try {
      fs.writeFileSync(configPath, '{"mcp":{"servers":{}}}\n');
      await manager.startGateway('initial-start');
      // Later writes reach the running process only through config RPC.
      fs.writeFileSync(configPath, '{"mcp":{"servers":{"computer-use":{}}}}\n');

      expect(manager.getGatewayProcessConfigRaw()).toBe('{"mcp":{"servers":{}}}\n');

      crashRunningGateway();
      expect(manager.getGatewayProcessConfigRaw()).toBeNull();
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('a gateway spawned without a config file has no spawn config', async () => {
    const { manager } = makeManager();
    Object.assign(manager, { configPath: path.join(os.tmpdir(), 'openclaw-missing-config', 'openclaw.json') });

    await manager.startGateway('initial-start');

    expect(manager.getGatewayProcessConfigRaw()).toBeNull();
  });
});


describe('gateway account startup permits', () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }

  function accountPermit(manager: OpenClawEngineManager) {
    let epoch = 1;
    const provider = vi.fn(() => {
      const captured = epoch;
      return () => captured === epoch;
    });
    manager.setStartPermitProvider(provider);
    return { provider, changeAccount: () => { epoch += 1; } };
  }

  test('denies direct and manual starts while the account is not prepared, preserving startup blocks', async () => {
    const { manager } = makeManager();
    manager.setStartPermitProvider(() => null);
    Object.assign(manager, {
      gatewayStartupBlock: { phase: OpenClawEnginePhase.Error, message: 'plugin consent required', canRetry: true },
      status: { phase: OpenClawEnginePhase.Error, message: 'plugin consent required', canRetry: true },
    });

    await manager.startGateway('channel-sync-ensure-ready', { retryBlocked: true });
    await manager.restartGateway('ipc-manual', { retryBlocked: true });

    expect(manager.isGatewayStartupBlocked()).toBe(true);
    expect(manager.getStatus().message).toBe('plugin consent required');
    expect(spawnState.children).toHaveLength(0);
  });

  async function committedAccountPermit(manager: OpenClawEngineManager, recovered: boolean) {
    const recovery = new OpenClawAccountRecovery({
      identity: () => 'account-A',
      canRun: () => true,
      allowCredentials: () => {},
      prepare: async () => {},
      start: async () => {},
      confirm: async () => {},
      complete: () => {},
      changed: () => {},
      canRetry: () => false,
    });
    if (recovered) await recovery.request({ resume: true, fence: async () => {} });
    manager.setStartPermitProvider(() => recovery.captureStartPermit());
    return recovery;
  }

  test.each([false, true])('same-owner profile refresh cannot strand a permitted startup (recovered=%s)', async recovered => {
    const { manager } = makeManager();
    const recovery = await committedAccountPermit(manager, recovered);
    const preparation = deferred();
    vi.mocked(migrateAllFtsOnlyMemoryIndexes).mockImplementationOnce(() => preparation.promise);
    const starting = manager.startGateway('committed-account');
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.getStatus().phase).toBe(OpenClawEnginePhase.Starting);

    const revision = recovery.beginAuthMutation();
    expect(recovery.captureStartPermit()).toBeNull();
    preparation.resolve();
    expect((await starting).phase).toBe(OpenClawEnginePhase.Running);
    recovery.commitAuthMutation(revision);
    expect(manager.getStatus().phase).toBe(OpenClawEnginePhase.Running);
    expect(spawnState.children).toHaveLength(1);
  });

  test.each([false, true])('same-owner profile refresh preserves an existing crash retry (recovered=%s)', async recovered => {
    const { manager, crashRunningGateway } = makeManager();
    const recovery = await committedAccountPermit(manager, recovered);
    await manager.startGateway('committed-account');
    crashRunningGateway();
    const revision = recovery.beginAuthMutation();
    expect(recovery.captureStartPermit()).toBeNull();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(manager.getStatus().phase).toBe(OpenClawEnginePhase.Running);
    recovery.commitAuthMutation(revision);
    expect(spawnState.children).toHaveLength(2);
  });

  test('discards a pending startup even when A switches to B and back to A before preparation finishes', async () => {
    const { manager } = makeManager();
    const account = accountPermit(manager);
    const preparation = deferred();
    vi.mocked(migrateAllFtsOnlyMemoryIndexes).mockImplementationOnce(() => preparation.promise);
    const starting = manager.startGateway('account-A');
    await vi.advanceTimersByTimeAsync(0);
    expect(migrateAllFtsOnlyMemoryIndexes).toHaveBeenCalledOnce();
    account.changeAccount();
    account.changeAccount();
    preparation.resolve();
    await starting;

    expect(spawnState.children).toHaveLength(0);
    await manager.startGateway('latest-account-A');
    expect(spawnState.children).toHaveLength(1);
    expect(account.provider).toHaveBeenCalledTimes(2);
  });

  test('rechecks the permit after the initial config prerequisite resolves', async () => {
    const { manager } = makeManager();
    const account = accountPermit(manager);
    const prerequisite = deferred();
    manager.setStartupPrerequisite(() => prerequisite.promise);
    const starting = manager.startGateway('old-config');
    await vi.advanceTimersByTimeAsync(0);
    account.changeAccount();
    prerequisite.resolve();
    await starting;
    expect(spawnState.children).toHaveLength(0);
  });

  test('checks the permit at the actual spawn boundary after reading startup inputs', async () => {
    const { manager } = makeManager();
    const account = accountPermit(manager);
    vi.mocked(readStartupMigrationCheckpointStamp).mockImplementationOnce(() => {
      account.changeAccount();
      return null;
    });
    await manager.startGateway('last-boundary');
    expect(spawnState.children).toHaveLength(0);
  });

  test('ordinary stop still cancels an in-flight preparation without waiting for account recovery', async () => {
    const { manager } = makeManager();
    const account = accountPermit(manager);
    const preparation = deferred();
    vi.mocked(migrateAllFtsOnlyMemoryIndexes).mockImplementationOnce(() => preparation.promise);
    const starting = manager.startGateway('old-account');
    await vi.advanceTimersByTimeAsync(0);
    account.changeAccount();
    const stopping = manager.stopGateway();
    preparation.resolve();
    await Promise.all([starting, stopping]);
    expect(spawnState.children).toHaveLength(0);
    expect(manager.getStatus().phase).toBe(OpenClawEnginePhase.Ready);
  });

  test('a restart cannot publish config or replace the process after its original permit expires', async () => {
    const { manager, internals } = makeManager();
    const account = accountPermit(manager);
    await manager.startGateway('account-A');
    const termination = deferred();
    const oldChild = internals.gatewayProcess!;
    vi.spyOn(internals, 'stopGatewayProcess').mockImplementation(async () => {
      await termination.promise;
      oldChild.exitCode = 0;
    });
    const beforeStart = vi.fn();
    const restarting = manager.restartGateway('account-A-config', { beforeStart });
    account.changeAccount();
    termination.resolve();
    await restarting;

    expect(beforeStart).not.toHaveBeenCalled();
    expect(spawnState.children).toHaveLength(1);
    expect(account.provider).toHaveBeenCalledTimes(2);
  });

  test('a crash retry keeps the crashed process permit instead of obtaining the next account permit', async () => {
    const { manager, crashRunningGateway } = makeManager();
    const account = accountPermit(manager);
    await manager.startGateway('account-A');
    crashRunningGateway();
    account.changeAccount();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(spawnState.children).toHaveLength(1);
    expect(account.provider).toHaveBeenCalledOnce();
    await manager.startGateway('account-B');
    expect(spawnState.children).toHaveLength(2);
  });

  test('the in-flight startup loop cannot retry a child with a revoked account permit', async () => {
    const { manager, internals, crashRunningGateway } = makeManager();
    const account = accountPermit(manager);
    vi.spyOn(internals, 'isGatewayStartupReady').mockResolvedValue(false);
    const starting = manager.startGateway('account-A');
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnState.children).toHaveLength(1);
    crashRunningGateway();
    await vi.advanceTimersByTimeAsync(600);
    account.changeAccount();
    await vi.advanceTimersByTimeAsync(2_400);
    await starting;

    expect(spawnState.children).toHaveLength(1);
    expect(account.provider).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('readiness from a revoked account cannot report the old process running', async () => {
    const { manager, internals, crashRunningGateway } = makeManager();
    const account = accountPermit(manager);
    const probe = deferred();
    vi.spyOn(internals, 'isGatewayStartupReady').mockImplementation(async () => {
      await probe.promise;
      return true;
    });
    const starting = manager.startGateway('account-A');
    await vi.advanceTimersByTimeAsync(0);
    account.changeAccount();
    probe.resolve();
    await starting;

    expect(manager.getStatus().phase).toBe(OpenClawEnginePhase.Starting);
    crashRunningGateway();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a late old-account exit neither restarts nor replaces the latest failure state', async () => {
    const { manager, internals, crashRunningGateway } = makeManager();
    const account = accountPermit(manager);
    await manager.startGateway('account-A');
    account.changeAccount();
    manager.setExternalError('latest account config failure');
    internals.gatewayRecentOutput.set(internals.gatewayProcess!, ['old account failure']);
    crashRunningGateway();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(spawnState.children).toHaveLength(1);
    expect(manager.getStatus().message).toBe('latest account config failure');
  });

  test('records the startup input revision captured with the real child environment', async () => {
    const { manager, crashRunningGateway } = makeManager();
    manager.setGatewayStartupInputRevision('input-A');
    manager.setSecretEnvVars({ MODEL_TOKEN: 'old' });
    const preparation = deferred();
    vi.mocked(migrateAllFtsOnlyMemoryIndexes).mockImplementationOnce(() => preparation.promise);
    const starting = manager.startGateway('input-A');
    await vi.advanceTimersByTimeAsync(0);
    manager.setGatewayStartupInputRevision('input-B');
    manager.setSecretEnvVars({ MODEL_TOKEN: 'new' });
    preparation.resolve();
    await starting;

    expect(manager.getGatewayProcessStartupInputRevision()).toBe('input-A');
    expect(manager.getGatewayProcessSecretEnvVars()).toEqual({ MODEL_TOKEN: 'old' });
    crashRunningGateway();
    expect(manager.getGatewayProcessStartupInputRevision()).toBeNull();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(manager.getGatewayProcessStartupInputRevision()).toBe('input-B');
    expect(manager.getGatewayProcessSecretEnvVars()).toEqual({ MODEL_TOKEN: 'new' });
  });
});
