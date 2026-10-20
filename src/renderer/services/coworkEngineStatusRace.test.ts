import { afterEach, describe, expect, test, vi } from 'vitest';

import { OpenClawEnginePhase } from '../../shared/openclawEngine/constants';
import type { OpenClawEngineStatus } from '../types/cowork';
import { coworkService } from './cowork';

const status = (phase: OpenClawEngineStatus['phase'], accountRecoveryPending = false): OpenClawEngineStatus => ({
  phase, version: null, canRetry: phase === OpenClawEnginePhase.Error, accountRecoveryPending,
});

function response() {
  let resolve!: (value: { success: boolean; status: OpenClawEngineStatus }) => void;
  const promise = new Promise<{ success: boolean; status: OpenClawEngineStatus }>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  coworkService.destroy();
  let progress!: (next: OpenClawEngineStatus) => void;
  const getStatus = vi.fn();
  vi.stubGlobal('window', { electron: { openclaw: { engine: {
    getStatus,
    onProgress: (listener: typeof progress) => { progress = listener; return () => {}; },
  } } } });
  const listener = vi.fn();
  coworkService.onOpenClawEngineStatus(listener);
  progress(status(OpenClawEnginePhase.Ready));
  listener.mockClear();
  return { getStatus, listener, progress: (next: OpenClawEngineStatus) => progress(next) };
}

afterEach(() => { coworkService.destroy(); vi.unstubAllGlobals(); });

describe('engine status reads during account recovery', () => {
  test.each([
    [OpenClawEnginePhase.Ready, OpenClawEnginePhase.Starting, true],
    [OpenClawEnginePhase.Starting, OpenClawEnginePhase.Running, false],
    [OpenClawEnginePhase.Ready, OpenClawEnginePhase.Error, true],
  ] as const)('a late %s read cannot replace the newer %s event', async (stalePhase, currentPhase, pending) => {
    const f = fixture();
    const delayed = response();
    f.getStatus.mockReturnValue(delayed.promise);
    const reading = coworkService.getOpenClawEngineStatus();
    const current = status(currentPhase, pending);
    f.progress(current);
    delayed.resolve({ success: true, status: status(stalePhase) });

    await expect(reading).resolves.toEqual(current);
    expect(coworkService.getOpenClawEngineStatusSnapshot()).toEqual(current);
    expect(f.listener).toHaveBeenCalledExactlyOnceWith(current);
  });

  test.each([true, false])('concurrent reads keep the latest requested snapshot (older response first=%s)', async olderFirst => {
    const f = fixture();
    const older = response();
    const latest = response();
    f.getStatus.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise);
    const firstRead = coworkService.getOpenClawEngineStatus();
    const latestRead = coworkService.getOpenClawEngineStatus();
    const current = status(OpenClawEnginePhase.Starting, true);
    if (olderFirst) {
      older.resolve({ success: true, status: status(OpenClawEnginePhase.Ready) });
      await firstRead;
      expect(f.listener).not.toHaveBeenCalled();
    }
    latest.resolve({ success: true, status: current });
    await expect(latestRead).resolves.toEqual(current);
    if (!olderFirst) {
      older.resolve({ success: true, status: status(OpenClawEnginePhase.Ready) });
      await expect(firstRead).resolves.toEqual(current);
    }
    expect(coworkService.getOpenClawEngineStatusSnapshot()).toEqual(current);
    expect(f.listener).toHaveBeenCalledExactlyOnceWith(current);
  });

  test('accepts a fresh read when no newer lifecycle status was published', async () => {
    const f = fixture();
    const current = status(OpenClawEnginePhase.Running);
    f.getStatus.mockResolvedValue({ success: true, status: current });
    await expect(coworkService.getOpenClawEngineStatus()).resolves.toEqual(current);
    expect(f.listener).toHaveBeenCalledExactlyOnceWith(current);
  });
});
