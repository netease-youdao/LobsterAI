import { type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OpenClawEngineErrorCode, OpenClawEnginePhase } from '../../shared/openclawEngine/constants';
import type { OpenClawDreamingRecoverySummary } from '../../shared/openclawEngine/dreamingRecovery';
import { OpenClawStartupCompatibilityMode } from '../../shared/openclawEngine/startupCompatibility';
import { OpenClawStartupMigrationStatus } from '../../shared/openclawEngine/startupMigration';
import { OPENCLAW_STARTUP_MIGRATION_REFUSAL } from './openclawDreamingStartupFailure';

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), isPackaged: false },
}));
vi.mock('./openclawLocalExtensions', () => ({
  syncLocalOpenClawExtensionsIntoRuntime: () => ({ copied: [] }),
  cleanupStaleThirdPartyPluginsFromBundledDir: () => [],
  listLocalOpenClawExtensionIds: () => [],
}));

import { OpenClawEngineManager, type OpenClawEngineStatus } from './openclawEngineManager';

interface SupervisorInternals {
  stateDir: string;
  startupCompatibilityRunner: ((mode: OpenClawStartupCompatibilityMode) => Promise<{ status: OpenClawStartupMigrationStatus; error?: string; dreamingRecovery?: OpenClawDreamingRecoverySummary }>) | null;
  gatewayReadyProcesses: WeakSet<ChildProcess>;
  gatewayProcess: ChildProcess | null;
  gatewayRecentOutput: WeakMap<ChildProcess, string[]>;
  gatewayRestartAttempt: number;
  gatewayReadySince: number | null;
  gatewayRestartTimer: ReturnType<typeof setTimeout> | null;
  startGatewayPromise: Promise<OpenClawEngineStatus> | null;
  shutdownRequested: boolean;
  attachGatewayExitHandlers: (child: ChildProcess) => void;
  waitForGatewayReady: (port: number, timeoutMs: number) => Promise<boolean>;
  isGatewayStartupReady: (port: number) => Promise<boolean>;
  isGatewayLive: (port: number) => Promise<boolean>;
  stopGatewayProcess: (child: ChildProcess) => Promise<void>;
  setStatus: (status: OpenClawEngineStatus) => void;
  doStartGateway: () => Promise<OpenClawEngineStatus>;
  resolveRuntimeMetadata: () => { root: string | null; version: string | null };
}

const makeChild = (): ChildProcess => Object.assign(new EventEmitter(), {
  pid: 123,
  exitCode: null as number | null,
  signalCode: null as NodeJS.Signals | null,
  kill: vi.fn(() => true),
  stderr: new PassThrough(),
}) as unknown as ChildProcess;

function closeChild(child: ChildProcess, code: number | null) {
  child.exitCode = code;
  child.emit('exit', code);
  child.emit('close', code);
}

function makeSupervisor() {
  // Avoid the constructor's user-data/runtime setup. These tests exercise the
  // real supervisor methods with fake processes and no gateway or disk writes.
  const manager = Object.assign(Object.create(OpenClawEngineManager.prototype), {
    status: { phase: OpenClawEnginePhase.Running, version: '2026.8.1', canRetry: false },
    desiredVersion: '2026.8.1',
    stateDir: path.join(process.cwd(), 'fixtures', 'state'),
    gatewayProcess: null,
    gatewayRecentOutput: new WeakMap(),
    gatewayGenerationByProcess: new WeakMap(),
    gatewayFailureByProcess: new WeakMap(),
    expectedGatewayExits: new WeakSet(),
    gatewayReadyProcesses: new WeakSet(),
    gatewayRestartTimer: null,
    gatewayRestartWait: null,
    gatewayRestartAttempt: 0,
    gatewayRestartExhausted: false,
    gatewayReadySince: null,
    gatewayLifecycleGeneration: 0,
    shutdownRequested: false,
    gatewayPort: 18789,
    startGatewayPromise: null,
    stopGatewayPromise: null,
    restartGatewayPromise: null,
    gatewaySelfRestartNotedAt: null,
    resolveRuntimeMetadata: () => ({ root: '/runtime', version: '2026.8.1' }),
    cleanupStaleGatewayLocksSafely: vi.fn(),
  }) as OpenClawEngineManager;
  const internals = manager as unknown as SupervisorInternals;
  const child = makeChild();
  internals.gatewayProcess = child;
  internals.gatewayRecentOutput.set(child, ['gateway stopped']);
  internals.attachGatewayExitHandlers(child);
  const phases: OpenClawEnginePhase[] = [];
  manager.on('status', (status: OpenClawEngineStatus) => phases.push(status.phase));
  return { manager, internals, child, phases };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('terminal plugin startup block', () => {
  test('blocks every implicit startup/restart and preserves the error through runtime preparation', async () => {
    const { manager, internals, child } = makeSupervisor();
    internals.gatewayRecentOutput.set(child, [
      'OpenClaw plugin verification failed; refusing to report the gateway ready.',
      '- Plugin "openclaw-weixin" requires capability consent.',
    ]);
    closeChild(child, 1);
    const start = vi.spyOn(internals, 'doStartGateway').mockImplementation(async () => {
      internals.setStatus({ phase: OpenClawEnginePhase.Running, version: '2026.8.1', canRetry: false });
      return manager.getStatus();
    });
    const blocked = manager.getStatus();
    expect(blocked.errorCode).toBe(OpenClawEngineErrorCode.PluginVerificationFailed);
    expect(manager.isGatewayStartupBlocked()).toBe(true);
    for (const reason of ['channel-sync-ensure-ready', 'ensure-running-for-cowork', 'auto-restart-after-crash']) {
      expect(await manager.startGateway(reason)).toEqual(blocked);
    }
    expect(await manager.restartGateway('config-sync')).toEqual(blocked);
    expect(await manager.ensureReady()).toEqual(blocked);
    internals.setStatus({ phase: OpenClawEnginePhase.Ready, version: '2026.8.1', canRetry: false });
    expect(manager.getStatus()).toEqual(blocked);
    expect(start).not.toHaveBeenCalled();
    expect(await manager.restartGateway('manual', { retryBlocked: true })).toMatchObject({ phase: OpenClawEnginePhase.Running });
    expect(manager.isGatewayStartupBlocked()).toBe(false);
    expect(start).toHaveBeenCalledOnce();
  });

  test('maintenance may prepare the runtime but cannot silently clear the block', async () => {
    const { manager, internals, child } = makeSupervisor();
    internals.gatewayRecentOutput.set(child, ['OpenClaw plugin verification failed; refusing to report the gateway ready.']);
    closeChild(child, 1);
    await manager.withGatewayStoppedForRepair(async () => {
      expect(await manager.ensureReady()).toMatchObject({ phase: OpenClawEnginePhase.Ready });
      expect(manager.isGatewayStartupBlocked()).toBe(true);
    });
    expect(manager.getStatus().errorCode).toBe(OpenClawEngineErrorCode.PluginVerificationFailed);
  });
});

describe('failure-triggered binding recovery', () => {
  function failureHarness() {
    const context = makeSupervisor();
    context.internals.gatewayProcess = null;
    const error: OpenClawEngineStatus = {
      phase: OpenClawEnginePhase.Error, version: '2026.8.1', canRetry: true,
      errorCode: OpenClawEngineErrorCode.StartupCompatibilityFailed,
      message: `SQLite schema is incomplete or noncanonical for ${path.join(context.internals.stateDir, 'state', 'openclaw.sqlite')}: column definitions differ for current_conversation_bindings`,
    };
    const recover = vi.fn(async () => ({ status: OpenClawStartupMigrationStatus.Migrated }));
    const start = vi.spyOn(context.internals, 'doStartGateway').mockImplementation(async () => {
      context.internals.startupCompatibilityRunner = recover;
      context.internals.setStatus(error);
      return context.manager.getStatus();
    });
    return { ...context, error, start, recover };
  }

  test('healthy startup performs no compatibility helper call', async () => {
    const { manager, internals, start, recover } = failureHarness();
    start.mockImplementation(async () => {
      internals.startupCompatibilityRunner = recover;
      internals.setStatus({ phase: OpenClawEnginePhase.Running, version: '2026.8.1' });
      return manager.getStatus();
    });
    expect((await manager.startGateway('healthy')).phase).toBe(OpenClawEnginePhase.Running);
    expect(recover).not.toHaveBeenCalled();
  });

  test('repairs a matching failure once and waits for the replacement startup', async () => {
    const { manager, internals, start, recover, error } = failureHarness();
    start.mockImplementation(async () => {
      internals.startupCompatibilityRunner = recover;
      internals.setStatus(recover.mock.calls.length ? { phase: OpenClawEnginePhase.Running, version: '2026.8.1' } : error);
      return manager.getStatus();
    });
    expect((await manager.startGateway('upgrade')).phase).toBe(OpenClawEnginePhase.Running);
    expect(start).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledExactlyOnceWith(OpenClawStartupCompatibilityMode.RepairBindings);
  });

  test('a repeated failure consumes no second recovery within the same request', async () => {
    const { manager, start, recover } = failureHarness();
    expect((await manager.startGateway('first')).phase).toBe(OpenClawEnginePhase.Error);
    expect(start).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await manager.startGateway('explicit-retry');
    expect(recover).toHaveBeenCalledTimes(2);
  });

  test('failed recovery preserves a specific error and does not restart again', async () => {
    const { manager, internals, start } = failureHarness();
    const recover = vi.fn(async () => ({ status: OpenClawStartupMigrationStatus.Failed, error: 'Unknown binding schema; original state retained.' }));
    const original = start.getMockImplementation()!;
    start.mockImplementation(async () => {
      const status = await original();
      internals.startupCompatibilityRunner = recover;
      return status;
    });
    expect(await manager.startGateway('unknown-schema')).toMatchObject({
      phase: OpenClawEnginePhase.Error, errorCode: OpenClawEngineErrorCode.StartupCompatibilityFailed,
      message: 'Unknown binding schema; original state retained.',
    });
    expect(start).toHaveBeenCalledOnce();
  });

  test('cancelling while recovery runs prevents a replacement process', async () => {
    const { manager, internals, start } = failureHarness();
    let finish!: (result: { status: OpenClawStartupMigrationStatus }) => void;
    const recover = vi.fn(() => new Promise<{ status: OpenClawStartupMigrationStatus }>(resolve => { finish = resolve; }));
    const original = start.getMockImplementation()!;
    start.mockImplementation(async () => {
      const status = await original();
      internals.startupCompatibilityRunner = recover;
      return status;
    });
    const startup = manager.startGateway('cancelled');
    await vi.advanceTimersByTimeAsync(0);
    expect(recover).toHaveBeenCalledOnce();
    const stopping = manager.stopGateway();
    finish({ status: OpenClawStartupMigrationStatus.Migrated });
    await Promise.all([startup, stopping]);
    expect(start).toHaveBeenCalledOnce();
    expect(manager.getStatus().phase).toBe(OpenClawEnginePhase.Ready);
  });

  test('a gateway process schema failure preserves the true cause and bypasses generic crash retries', () => {
    const { manager, internals, child } = makeSupervisor();
    const cause = `SQLite schema is incomplete or noncanonical for ${path.join(internals.stateDir, 'state', 'openclaw.sqlite')}: column definitions differ for current_conversation_bindings`;
    internals.gatewayRecentOutput.set(child, ['[stderr] Config warnings: plugins.entries.acpx: not installed', `[stderr] [openclaw] Reason: ${cause}`]);
    child.exitCode = 1;
    closeChild(child, 1);
    expect(manager.getStatus()).toMatchObject({ phase: OpenClawEnginePhase.Error, message: cause, errorCode: OpenClawEngineErrorCode.StartupCompatibilityFailed });
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a nonfatal health-state schema warning does not trigger recovery for an unrelated exit', () => {
    const { manager, internals, child } = makeSupervisor();
    const warning = `Config health-state write failed: SQLite schema is incomplete or noncanonical for ${path.join(internals.stateDir, 'state', 'openclaw.sqlite')}: column definitions differ for current_conversation_bindings`;
    internals.gatewayRecentOutput.set(child, [`[stderr] ${warning}`, '[stderr] Error: unrelated startup failure']);
    child.exitCode = 1;
    closeChild(child, 1);
    expect(manager.getStatus().errorCode).toBeUndefined();
    expect(internals.gatewayRestartAttempt).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('failure-triggered dreaming recovery', () => {
  const terminal = `${OPENCLAW_STARTUP_MIGRATION_REFUSAL}\n- Skipped Memory Core daily ingestion import for workspace because the legacy source could not be imported: SyntaxError: invalid JSON\n`;
  const summary: OpenClawDreamingRecoverySummary = {
    manifestPath: path.join(process.cwd(), 'fixture-manifest.json'), affectedWorkspaceCount: 5,
    quarantinedFileCount: 15, pendingFileCount: 0, recordedAt: '2026-09-15T00:00:00.000Z',
  };
  const fault: OpenClawEngineStatus = { phase: OpenClawEnginePhase.Error, version: '2026.8.1', canRetry: true,
    errorCode: OpenClawEngineErrorCode.MemoryDreamingMigrationFailed, message: 'Legacy Memory Core JSON could not be parsed.' };
  function fixture(statuses: OpenClawEngineStatus[] = [fault]) {
    const context = makeSupervisor();
    context.internals.gatewayProcess = null;
    const recover = vi.fn(async () => ({ status: OpenClawStartupMigrationStatus.Migrated, dreamingRecovery: summary }));
    let index = 0;
    const start = vi.spyOn(context.internals, 'doStartGateway').mockImplementation(async () => {
      context.internals.startupCompatibilityRunner = recover;
      context.internals.setStatus(statuses[Math.min(index++, statuses.length - 1)]);
      return context.manager.getStatus();
    });
    return { ...context, recover, start };
  }

  test('waits for close and trailing stderr rather than classifying at exit or from the 80-line tail', () => {
    const { manager, internals, child } = makeSupervisor();
    child.exitCode = 1;
    child.emit('exit', 1);
    expect(internals.gatewayProcess).toBe(child);
    child.stderr!.emit('data', Buffer.from(terminal + '- notice\n'.repeat(100)));
    closeChild(child, 1);
    expect(manager.getStatus().errorCode).toBe(OpenClawEngineErrorCode.MemoryDreamingMigrationFailed);
    expect(internals.gatewayProcess).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([0, null])('does not authorize file repair after exit code %s', code => {
    const { manager, child } = makeSupervisor();
    child.stderr!.emit('data', terminal);
    closeChild(child, code);
    expect(manager.getStatus().errorCode).not.toBe(OpenClawEngineErrorCode.MemoryDreamingMigrationFailed);
  });

  test('ignores matching output after readiness, and stale child events', () => {
    const { manager, internals, child } = makeSupervisor();
    internals.gatewayReadyProcesses.add(child);
    child.stderr!.emit('data', terminal);
    closeChild(child, 1);
    expect(manager.getStatus().errorCode).not.toBe(OpenClawEngineErrorCode.MemoryDreamingMigrationFailed);
    const next = makeChild();
    internals.attachGatewayExitHandlers(next);
    next.stderr!.emit('data', terminal);
    closeChild(next, 1);
    expect(manager.getStatus().errorCode).not.toBe(OpenClawEngineErrorCode.MemoryDreamingMigrationFailed);
  });

  test('recovers once, retains the summary after readiness, and skips repair on a later healthy start', async () => {
    const healthy = { ...fault, phase: OpenClawEnginePhase.Running, errorCode: undefined, message: 'Running' };
    const { manager, recover, start } = fixture([fault, healthy]);
    expect(await manager.startGateway('cold-start')).toMatchObject({ phase: OpenClawEnginePhase.Running, dreamingRecovery: summary });
    expect(start).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledExactlyOnceWith(OpenClawStartupCompatibilityMode.RepairDreamingState);
    await manager.startGateway('healthy-again');
    expect(recover).toHaveBeenCalledOnce();
  });

  test('a persistent failure uses only one recovery per request, including when recovery reports skipped', async () => {
    const { manager, recover, start } = fixture();
    expect((await manager.startGateway('failed')).errorCode).toBe(fault.errorCode);
    expect(recover).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledTimes(2);
    recover.mockResolvedValue({ status: OpenClawStartupMigrationStatus.Skipped, dreamingRecovery: summary });
    await manager.startGateway('explicit-retry');
    expect(recover).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(3);
  });

  test('binding and dreaming budgets are independent and never reset by an internal restart', async () => {
    const binding = { ...fault, errorCode: OpenClawEngineErrorCode.StartupCompatibilityFailed,
      message: `SQLite schema is incomplete or noncanonical for ${path.join(process.cwd(), 'fixtures', 'state', 'state', 'openclaw.sqlite')}: column definitions differ for current_conversation_bindings` };
    const { manager, recover, start } = fixture([fault, binding, fault]);
    expect((await manager.startGateway('two-faults')).errorCode).toBe(fault.errorCode);
    expect(recover.mock.calls.map(call => call[0])).toEqual([
      OpenClawStartupCompatibilityMode.RepairDreamingState, OpenClawStartupCompatibilityMode.RepairBindings,
    ]);
    expect(start).toHaveBeenCalledTimes(3);
  });

  test('cancellation waits for recovery, retains its summary and prevents a replacement', async () => {
    const { manager, internals, start } = fixture();
    let finish!: (value: { status: OpenClawStartupMigrationStatus; dreamingRecovery: OpenClawDreamingRecoverySummary }) => void;
    const recovery = new Promise<{ status: OpenClawStartupMigrationStatus; dreamingRecovery: OpenClawDreamingRecoverySummary }>(resolve => { finish = resolve; });
    start.mockImplementation(async () => {
      internals.startupCompatibilityRunner = () => recovery;
      internals.setStatus(fault);
      return manager.getStatus();
    });
    const startup = manager.startGateway('cancel');
    await vi.advanceTimersByTimeAsync(0);
    const stopping = manager.stopGateway();
    finish({ status: OpenClawStartupMigrationStatus.Migrated, dreamingRecovery: summary });
    await Promise.all([startup, stopping]);
    expect(start).toHaveBeenCalledOnce();
    expect(manager.getStatus()).toMatchObject({ phase: OpenClawEnginePhase.Ready, dreamingRecovery: summary });
  });
});

describe('OpenClaw gateway restart supervision', () => {
  test('manual repair fences background starts and restarts until the repair child has finished', async () => {
    const { manager, internals, child } = makeSupervisor();
    let finishRepair!: () => void;
    const repairWork = vi.fn(() => new Promise<void>(resolve => { finishRepair = resolve; }));
    const start = vi.spyOn(internals, 'doStartGateway').mockImplementation(async () => manager.getStatus());
    const repairing = manager.withGatewayStoppedForRepair(repairWork);
    child.exitCode = 0;
    child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(repairWork).toHaveBeenCalledOnce();
    await Promise.all([manager.startGateway('auto-reconnect'), manager.restartGateway('background-config')]);
    expect(start).not.toHaveBeenCalled();
    finishRepair();
    await repairing;
    await manager.startGateway('manual-repair');
    expect(start).toHaveBeenCalledOnce();
  });

  test('manual repair releases its start guard after a failure', async () => {
    const { manager, internals, child } = makeSupervisor();
    const start = vi.spyOn(internals, 'doStartGateway').mockImplementation(async () => manager.getStatus());
    const repairing = manager.withGatewayStoppedForRepair(async () => { throw new Error('backup failed'); });
    const rejected = expect(repairing).rejects.toThrow('backup failed');
    child.exitCode = 0;
    child.emit('exit', 0);
    await rejected;
    await manager.startGateway('user-retry');
    expect(start).toHaveBeenCalledOnce();
  });

  test('waits through transient readiness failures without showing startup for a running process', async () => {
    const { manager, internals, child, phases } = makeSupervisor();
    let ready = false;
    vi.spyOn(internals, 'isGatewayStartupReady').mockImplementation(async () => ready);
    vi.spyOn(internals, 'isGatewayLive').mockResolvedValue(true);
    const stop = vi.spyOn(internals, 'stopGatewayProcess');
    const settled = vi.fn();
    const starting = manager.startGateway('config-delivery').then(status => { settled(); return status; });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(phases).toEqual([]);
    expect(manager.getStatus().phase).toBe(OpenClawEnginePhase.Running);

    ready = true;
    await vi.advanceTimersByTimeAsync(600);
    await expect(starting).resolves.toMatchObject({ phase: OpenClawEnginePhase.Running });
    expect(phases).not.toContain(OpenClawEnginePhase.Starting);
    expect(internals.gatewayProcess).toBe(child);
    expect(stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('still shows startup and waits for explicit readiness for a process that has never been ready', async () => {
    const { manager, internals, phases } = makeSupervisor();
    internals.setStatus({ phase: OpenClawEnginePhase.Ready, version: '2026.8.1', canRetry: false });
    phases.length = 0;
    let ready = false;
    vi.spyOn(internals, 'isGatewayStartupReady').mockImplementation(async () => ready);
    vi.spyOn(internals, 'isGatewayLive').mockResolvedValue(true);
    const settled = vi.fn();
    const starting = manager.startGateway('initial-start').then(status => { settled(); return status; });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).not.toHaveBeenCalled();
    expect(manager.getStatus().phase).toBe(OpenClawEnginePhase.Starting);
    expect(phases.length).toBeGreaterThan(1);
    expect(phases).not.toContain(OpenClawEnginePhase.Running);

    ready = true;
    await vi.advanceTimersByTimeAsync(600);
    await expect(starting).resolves.toMatchObject({ phase: OpenClawEnginePhase.Running });
    expect(vi.getTimerCount()).toBe(0);
  });

  test('shows startup only when a persistently unresponsive running process will actually be replaced', async () => {
    const { manager, internals, child, phases } = makeSupervisor();
    vi.spyOn(internals, 'isGatewayStartupReady').mockResolvedValue(false);
    vi.spyOn(internals, 'isGatewayLive').mockResolvedValue(true);
    const stop = vi.spyOn(internals, 'stopGatewayProcess').mockImplementation(async () => {
      expect(manager.getStatus().phase).toBe(OpenClawEnginePhase.Starting);
      // Cancel after confirming the replacement decision; do not spawn a real process.
      internals.shutdownRequested = true;
    });
    const starting = manager.startGateway('config-delivery');

    await vi.advanceTimersByTimeAsync(299_400);
    expect(stop).not.toHaveBeenCalled();
    expect(phases).toEqual([]);
    expect(manager.getStatus().phase).toBe(OpenClawEnginePhase.Running);

    await vi.advanceTimersByTimeAsync(600);
    await starting;
    expect(stop).toHaveBeenCalledExactlyOnceWith(child);
    expect(phases).toEqual([OpenClawEnginePhase.Starting]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('keeps one startup screen and never starts the replacement before the old process exits', async () => {
    const { manager, internals, child, phases } = makeSupervisor();
    const start = vi.spyOn(manager, 'startGateway').mockImplementation(async () => {
      expect((await manager.ensureReady()).phase).toBe(OpenClawEnginePhase.Starting);
      internals.setStatus({ phase: OpenClawEnginePhase.Running, version: '2026.8.1', canRetry: false });
      return manager.getStatus();
    });
    const first = manager.restartGateway('mcp-change');
    const concurrent = manager.restartGateway('another-config-change');

    await vi.advanceTimersByTimeAsync(5_300);
    expect(start).not.toHaveBeenCalled();
    expect(phases).toEqual([OpenClawEnginePhase.Starting]);
    child.exitCode = 0;
    closeChild(child, 0);
    await Promise.all([first, concurrent]);

    expect(start).toHaveBeenCalledOnce();
    expect(phases).toEqual([OpenClawEnginePhase.Starting, OpenClawEnginePhase.Running]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('keeps the old process reference and fails restart when termination is unconfirmed', async () => {
    const { manager, internals, child, phases } = makeSupervisor();
    const start = vi.spyOn(manager, 'startGateway');
    const pending = manager.restartGateway('mcp-change');
    const rejected = expect(pending).rejects.toThrow('did not exit after SIGKILL');
    await vi.advanceTimersByTimeAsync(8_000);
    await rejected;

    expect(internals.gatewayProcess).toBe(child);
    expect(start).not.toHaveBeenCalled();
    expect(phases).toEqual([OpenClawEnginePhase.Starting, OpenClawEnginePhase.Error]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('keeps recoverable crashes in starting while waiting for automatic recovery', async () => {
    const { manager, internals, child, phases } = makeSupervisor();
    const start = vi.spyOn(manager, 'startGateway').mockImplementation(async () => {
      internals.setStatus({ phase: OpenClawEnginePhase.Running, version: '2026.8.1', canRetry: false });
      return manager.getStatus();
    });
    child.exitCode = 1;
    closeChild(child, 1);

    expect(phases).toEqual([OpenClawEnginePhase.Starting]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(start).toHaveBeenCalledWith('auto-restart-after-crash');
    expect(phases).toEqual([OpenClawEnginePhase.Starting, OpenClawEnginePhase.Running]);
  });

  test('shows error only after the automatic restart budget is exhausted', () => {
    const { manager, internals, child, phases } = makeSupervisor();
    internals.gatewayRestartAttempt = 5;
    child.exitCode = 1;
    closeChild(child, 1);

    expect(phases).toEqual([OpenClawEnginePhase.Error]);
    expect(manager.getStatus().canRetry).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('ready-then-crash loops exhaust the budget and channel reconnects honor every backoff', async () => {
    const { manager, internals } = makeSupervisor();
    vi.spyOn(internals, 'isGatewayStartupReady').mockResolvedValue(true);
    const start = vi.spyOn(internals, 'doStartGateway').mockImplementation(async () => {
      const nextChild = makeChild();
      internals.gatewayProcess = nextChild;
      internals.gatewayRecentOutput.set(nextChild, ['gateway_start hook failed']);
      internals.attachGatewayExitHandlers(nextChild);
      await internals.waitForGatewayReady(18789, 300_000);
      internals.setStatus({ phase: OpenClawEnginePhase.Running, version: '2026.8.1', canRetry: false });
      return manager.getStatus();
    });
    await manager.startGateway('initial-start');
    const delays = [3_000, 5_000, 10_000, 20_000, 30_000];
    for (const [index, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(1_000);
      closeChild(internals.gatewayProcess!, 1);
      const reconnect = manager.startGateway('channel-sync-ensure-ready');
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(start).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(reconnect).resolves.toMatchObject({ phase: OpenClawEnginePhase.Running });
      expect(internals.gatewayRestartAttempt).toBe(index + 1);
    }

    await vi.advanceTimersByTimeAsync(1_000);
    closeChild(internals.gatewayProcess!, 1);
    const terminal = manager.getStatus();
    expect(terminal).toMatchObject({ phase: OpenClawEnginePhase.Error, canRetry: true });
    await expect(manager.ensureReady()).resolves.toEqual(terminal);
    await expect(manager.startGateway('channel-sync-ensure-ready')).resolves.toEqual(terminal);
    await expect(manager.startGateway('ensure-running-for-cowork')).resolves.toEqual(terminal);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(start).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a stable ready process earns a fresh retry budget without repeated probes moving its ready time', async () => {
    const { manager, internals, child } = makeSupervisor();
    internals.gatewayRestartAttempt = 4;
    vi.spyOn(internals, 'isGatewayStartupReady').mockResolvedValue(true);
    await internals.waitForGatewayReady(18789, 300_000);
    const firstReadyAt = internals.gatewayReadySince;
    await vi.advanceTimersByTimeAsync(20_000);
    await manager.startGateway('channel-sync-ensure-ready');
    expect(internals.gatewayReadySince).toBe(firstReadyAt);
    await vi.advanceTimersByTimeAsync(10_000);
    closeChild(child, 1);
    expect(internals.gatewayRestartAttempt).toBe(1);
    expect(manager.getStatus().phase).toBe(OpenClawEnginePhase.Starting);
  });

  test.each(['ipc-manual', 'config-sync:model-change'])('explicit restart %s reopens an exhausted budget', async (reason) => {
    const { manager, internals, child } = makeSupervisor();
    internals.gatewayRestartAttempt = 5;
    closeChild(child, 1);
    const start = vi.spyOn(internals, 'doStartGateway').mockImplementation(async () => {
      internals.setStatus({ phase: OpenClawEnginePhase.Running, version: '2026.8.1', canRetry: false });
      return manager.getStatus();
    });
    await expect(manager.restartGateway(reason)).resolves.toMatchObject({ phase: OpenClawEnginePhase.Running });
    expect(internals.gatewayRestartAttempt).toBe(0);
    expect(start).toHaveBeenCalledOnce();
  });

  test('manual retry and repair can ensure and start the runtime after explicitly stopping an exhausted budget', async () => {
    const { manager, internals, child } = makeSupervisor();
    internals.gatewayRestartAttempt = 5;
    closeChild(child, 1);
    await manager.stopGateway({ restarting: true });
    await expect(manager.ensureReady()).resolves.toMatchObject({ phase: OpenClawEnginePhase.Starting });
    const start = vi.spyOn(internals, 'doStartGateway').mockImplementation(async () => {
      internals.setStatus({ phase: OpenClawEnginePhase.Running, version: '2026.8.1', canRetry: false });
      return manager.getStatus();
    });
    await expect(manager.startGateway('bootstrap:manual-retry')).resolves.toMatchObject({ phase: OpenClawEnginePhase.Running });
    expect(internals.gatewayRestartAttempt).toBe(0);
    expect(start).toHaveBeenCalledOnce();
  });

  test('immediately reports invalid configuration and cancels any already scheduled retry', () => {
    const { internals, child, phases } = makeSupervisor();
    child.emit('error', new Error('gateway error'));
    internals.gatewayRecentOutput.set(child, ['Invalid config at openclaw.json.']);
    child.exitCode = 1;
    closeChild(child, 1);

    expect(phases).toEqual([OpenClawEnginePhase.Starting, OpenClawEnginePhase.Error]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('retries failed spawns without waiting for an exit event that may never arrive', () => {
    const { internals, child, phases } = makeSupervisor();
    Object.defineProperty(child, 'pid', { value: undefined });
    child.emit('error', new Error('spawn ENOENT'));

    expect(internals.gatewayProcess).toBeNull();
    expect(phases).toEqual([OpenClawEnginePhase.Starting]);
    expect(vi.getTimerCount()).toBe(1);
  });

  test('does not let a stale readiness response overwrite an exited process state', async () => {
    const { internals, child, phases } = makeSupervisor();
    let resolveProbe!: (ready: boolean) => void;
    vi.spyOn(internals, 'isGatewayStartupReady').mockReturnValue(new Promise((resolve) => {
      resolveProbe = resolve;
    }));
    const ready = internals.waitForGatewayReady(18789, 300_000);
    child.exitCode = 1;
    closeChild(child, 1);
    resolveProbe(true);

    await expect(ready).resolves.toBe(false);
    expect(phases).toEqual([OpenClawEnginePhase.Starting]);
  });

  test('waits for an in-flight startup to acknowledge cancellation before returning from stop', async () => {
    const { manager, internals, child } = makeSupervisor();
    let resolveStartup!: (status: OpenClawEngineStatus) => void;
    internals.startGatewayPromise = new Promise((resolve) => { resolveStartup = resolve; });
    const stopped = vi.fn();
    const pending = manager.stopGateway({ restarting: true }).then(stopped);
    child.exitCode = 0;
    closeChild(child, 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).not.toHaveBeenCalled();
    resolveStartup(manager.getStatus());
    await pending;
    expect(manager.getStatus().phase).toBe(OpenClawEnginePhase.Starting);
  });

  test('keeps start callers waiting until automatic recovery reaches running', async () => {
    const { manager, internals, child } = makeSupervisor();
    const attempt = vi.spyOn(internals, 'doStartGateway')
      .mockImplementationOnce(async () => {
        child.exitCode = 1;
        closeChild(child, 1);
        return manager.getStatus();
      })
      .mockImplementationOnce(async () => {
        internals.setStatus({ phase: OpenClawEnginePhase.Running, version: '2026.8.1', canRetry: false });
        return manager.getStatus();
      });
    const settled = vi.fn();
    const pending = manager.startGateway('initial-start').then((status) => { settled(); return status; });

    await vi.advanceTimersByTimeAsync(2_900);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({ phase: OpenClawEnginePhase.Running });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  test('consumes a retry even when its timer fires before the failed attempt settles', async () => {
    const { manager, internals, child } = makeSupervisor();
    let finishAttempt!: (status: OpenClawEngineStatus) => void;
    const attempt = vi.spyOn(internals, 'doStartGateway')
      .mockImplementationOnce(() => {
        child.exitCode = 1;
        closeChild(child, 1);
        return new Promise((resolve) => { finishAttempt = resolve; });
      })
      .mockImplementationOnce(async () => {
        internals.setStatus({ phase: OpenClawEnginePhase.Running, version: '2026.8.1', canRetry: false });
        return manager.getStatus();
      });
    const pending = manager.startGateway('initial-start');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(attempt).toHaveBeenCalledOnce();
    finishAttempt(manager.getStatus());

    await expect(pending).resolves.toMatchObject({ phase: OpenClawEnginePhase.Running });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  test('cancels a retry wait when explicitly stopped without hanging either caller', async () => {
    const { manager, internals, child } = makeSupervisor();
    const attempt = vi.spyOn(internals, 'doStartGateway').mockImplementationOnce(async () => {
      child.exitCode = 1;
      closeChild(child, 1);
      return manager.getStatus();
    });
    const starting = manager.startGateway('initial-start');
    await vi.advanceTimersByTimeAsync(1_000);
    await manager.stopGateway();
    await starting;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(attempt).toHaveBeenCalledOnce();
    expect(manager.getStatus().phase).toBe(OpenClawEnginePhase.Ready);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('does not respawn when an ordinary stop joins an in-flight restart', async () => {
    const { manager, child } = makeSupervisor();
    const start = vi.spyOn(manager, 'startGateway');
    const restarting = manager.restartGateway('mcp-change');
    const stopping = manager.stopGateway();
    child.exitCode = 0;
    closeChild(child, 0);
    await Promise.all([restarting, stopping]);

    expect(start).not.toHaveBeenCalled();
    expect(manager.getStatus().phase).toBe(OpenClawEnginePhase.Ready);
  });

  test('resolves an active recovery as error when config validation cancels its retry', async () => {
    const { manager, internals, child } = makeSupervisor();
    const attempt = vi.spyOn(internals, 'doStartGateway').mockImplementationOnce(async () => {
      child.emit('error', new Error('gateway error'));
      return manager.getStatus();
    });
    const starting = manager.startGateway('initial-start');
    await vi.advanceTimersByTimeAsync(1_000);
    internals.gatewayRecentOutput.set(child, ['Invalid config at openclaw.json.']);
    child.exitCode = 1;
    closeChild(child, 1);

    await expect(starting).resolves.toMatchObject({ phase: OpenClawEnginePhase.Error });
    expect(attempt).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('does not hide a missing runtime behind an existing starting status', async () => {
    const { manager, internals } = makeSupervisor();
    internals.setStatus({ phase: OpenClawEnginePhase.Starting, version: '2026.8.1', canRetry: false });
    vi.spyOn(internals, 'resolveRuntimeMetadata').mockReturnValue({ root: null, version: null });
    await expect(manager.ensureReady()).resolves.toMatchObject({ phase: OpenClawEnginePhase.NotInstalled });
  });

  test('does not launch a gateway for a background start arriving during an ordinary stop', async () => {
    const { manager, internals, child } = makeSupervisor();
    const attempt = vi.spyOn(internals, 'doStartGateway');
    const stopping = manager.stopGateway();
    const backgroundStart = manager.startGateway('channel-sync-ensure-ready');
    child.exitCode = 0;
    closeChild(child, 0);
    await stopping;

    await expect(backgroundStart).resolves.toMatchObject({ phase: OpenClawEnginePhase.Ready });
    expect(attempt).not.toHaveBeenCalled();
  });

  test('settles the public start promise after all five automatic attempts fail', async () => {
    const { manager, internals, phases } = makeSupervisor();
    const attempt = vi.spyOn(internals, 'doStartGateway').mockImplementation(async () => {
      const nextChild = makeChild();
      internals.gatewayProcess = nextChild;
      internals.gatewayRecentOutput.set(nextChild, ['startup worker failed']);
      internals.attachGatewayExitHandlers(nextChild);
      nextChild.exitCode = 1;
      closeChild(nextChild, 1);
      return manager.getStatus();
    });
    const starting = manager.startGateway('initial-start');
    await vi.advanceTimersByTimeAsync(68_000);

    await expect(starting).resolves.toMatchObject({ phase: OpenClawEnginePhase.Error });
    expect(attempt).toHaveBeenCalledTimes(6);
    expect(phases).toEqual([
      ...Array.from({ length: 5 }, () => OpenClawEnginePhase.Starting),
      OpenClawEnginePhase.Error,
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
