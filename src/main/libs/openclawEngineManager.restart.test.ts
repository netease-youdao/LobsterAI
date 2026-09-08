import { type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OpenClawEnginePhase } from '../../shared/openclawEngine/constants';

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
  gatewayProcess: ChildProcess | null;
  gatewayRecentOutput: WeakMap<ChildProcess, string[]>;
  gatewayRestartAttempt: number;
  gatewayRestartTimer: ReturnType<typeof setTimeout> | null;
  startGatewayPromise: Promise<OpenClawEngineStatus> | null;
  attachGatewayExitHandlers: (child: ChildProcess) => void;
  waitForGatewayReady: (port: number, timeoutMs: number) => Promise<boolean>;
  isGatewayStartupReady: (port: number) => Promise<boolean>;
  setStatus: (status: OpenClawEngineStatus) => void;
  doStartGateway: () => Promise<OpenClawEngineStatus>;
  resolveRuntimeMetadata: () => { root: string | null; version: string | null };
}

const makeChild = (): ChildProcess => Object.assign(new EventEmitter(), {
  pid: 123,
  exitCode: null as number | null,
  signalCode: null as NodeJS.Signals | null,
  kill: vi.fn(() => true),
}) as unknown as ChildProcess;

function makeSupervisor() {
  // Avoid the constructor's user-data/runtime setup. These tests exercise the
  // real supervisor methods with fake processes and no gateway or disk writes.
  const manager = Object.assign(Object.create(OpenClawEngineManager.prototype), {
    status: { phase: OpenClawEnginePhase.Running, version: '2026.8.1', canRetry: false },
    desiredVersion: '2026.8.1',
    gatewayProcess: null,
    gatewayRecentOutput: new WeakMap(),
    gatewayGenerationByProcess: new WeakMap(),
    gatewayFailureByProcess: new WeakMap(),
    expectedGatewayExits: new WeakSet(),
    gatewayRestartTimer: null,
    gatewayRestartWait: null,
    gatewayRestartAttempt: 0,
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
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OpenClaw gateway restart supervision', () => {
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
    child.emit('exit', 0);
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
    child.emit('exit', 1);

    expect(phases).toEqual([OpenClawEnginePhase.Starting]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(start).toHaveBeenCalledWith('auto-restart-after-crash');
    expect(phases).toEqual([OpenClawEnginePhase.Starting, OpenClawEnginePhase.Running]);
  });

  test('shows error only after the automatic restart budget is exhausted', () => {
    const { manager, internals, child, phases } = makeSupervisor();
    internals.gatewayRestartAttempt = 5;
    child.exitCode = 1;
    child.emit('exit', 1);

    expect(phases).toEqual([OpenClawEnginePhase.Error]);
    expect(manager.getStatus().canRetry).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('immediately reports invalid configuration and cancels any already scheduled retry', () => {
    const { internals, child, phases } = makeSupervisor();
    child.emit('error', new Error('gateway error'));
    internals.gatewayRecentOutput.set(child, ['Invalid config at openclaw.json.']);
    child.exitCode = 1;
    child.emit('exit', 1);

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
    child.emit('exit', 1);
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
    child.emit('exit', 0);
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
        child.emit('exit', 1);
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
        child.emit('exit', 1);
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
      child.emit('exit', 1);
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
    child.emit('exit', 0);
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
    child.emit('exit', 1);

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
    child.emit('exit', 0);
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
      nextChild.emit('exit', 1);
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
