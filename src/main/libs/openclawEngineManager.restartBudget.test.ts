import { type ChildProcess } from 'child_process';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OpenClawEnginePhase } from '../../shared/openclawEngine/constants';

// These tests drive the real startGateway -> doStartGateway success path, so a
// healthy start that refills the restart budget too early fails them. Only the
// disk, runtime and process I/O around the spawn is stubbed.
const spawnState = vi.hoisted(() => ({ children: [] as unknown[] }));

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2026.9.24' },
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
vi.mock('./pythonRuntime', () => ({ appendPythonRuntimeToEnv: () => {} }));
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
vi.mock('./openclawMemoryIndexMigration', () => ({ migrateAllFtsOnlyMemoryIndexes: async () => undefined }));
vi.mock('./openclawStartupCheckpoint', () => ({
  describeStartupMigrationCheckpoint: () => 'unchanged',
  readStartupMigrationCheckpointStamp: () => null,
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

import { OpenClawEngineManager } from './openclawEngineManager';
import { spawnOpenClawGatewayProcess } from './openclawGatewayProcess';

interface BudgetInternals {
  gatewayProcess: ChildProcess | null;
  gatewayRecentOutput: WeakMap<ChildProcess, string[]>;
  gatewayRestartAttempt: number;
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
  vi.useFakeTimers();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
