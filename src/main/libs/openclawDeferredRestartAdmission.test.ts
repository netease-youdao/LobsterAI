import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  admitPastDeferredGatewayRestart,
  DEFERRED_RESTART_CALLER_WAIT_MS,
  type DeferredRestartAdmissionDeps,
} from './openclawDeferredRestartAdmission';

function createHarness(initialReason: string | null, busy: boolean) {
  const state = { reason: initialReason, busy };
  const deps = {
    getDeferredReason: () => state.reason,
    hasActiveWorkloads: vi.fn(() => state.busy),
    runDeferredRestart: vi.fn(async () => { state.reason = null; }),
    waitForPendingApply: vi.fn(async () => {}),
  } satisfies DeferredRestartAdmissionDeps;
  return { state, deps };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('admitPastDeferredGatewayRestart', () => {
  test('admits immediately when no restart is queued', async () => {
    const { deps } = createHarness(null, true);
    await expect(admitPastDeferredGatewayRestart(deps)).resolves.toEqual({ admitted: true });
    expect(deps.hasActiveWorkloads).not.toHaveBeenCalled();
    expect(deps.runDeferredRestart).not.toHaveBeenCalled();
  });

  test('runs the queued restart right away when the gateway is idle', async () => {
    const { deps } = createHarness('mcp-change', false);
    await expect(admitPastDeferredGatewayRestart(deps)).resolves.toEqual({ admitted: true });
    expect(deps.runDeferredRestart).toHaveBeenCalledExactlyOnceWith('mcp-change');
    expect(deps.waitForPendingApply).toHaveBeenCalledOnce();
  });

  test('surfaces the config sync error when the immediate restart fails', async () => {
    const { deps } = createHarness('mcp-change', false);
    deps.runDeferredRestart.mockRejectedValueOnce(new Error('gateway failed to restart'));
    await expect(admitPastDeferredGatewayRestart(deps))
      .resolves.toEqual({ admitted: false, error: 'gateway failed to restart' });
  });

  test('stays pending when the immediate restart is re-deferred by new work', async () => {
    const { deps } = createHarness('mcp-change', false);
    deps.runDeferredRestart.mockImplementationOnce(async () => {});
    await expect(admitPastDeferredGatewayRestart(deps)).resolves.toEqual({ admitted: false });
    expect(deps.waitForPendingApply).not.toHaveBeenCalled();
  });

  test('waits for the scheduled restart to land while workloads are active', async () => {
    const { state, deps } = createHarness('mcp-change', true);
    const admission = admitPastDeferredGatewayRestart(deps);
    await vi.advanceTimersByTimeAsync(10_000);
    // The background poller applies the restart once the running task finishes.
    state.reason = null;
    await vi.advanceTimersByTimeAsync(500);

    await expect(admission).resolves.toEqual({ admitted: true });
    expect(deps.runDeferredRestart).not.toHaveBeenCalled();
    expect(deps.waitForPendingApply).toHaveBeenCalledOnce();
  });

  test('reports the config apply error that follows a scheduled restart', async () => {
    const { state, deps } = createHarness('mcp-change', true);
    deps.waitForPendingApply.mockRejectedValueOnce(new Error('OpenClaw config sync failed.'));
    const admission = admitPastDeferredGatewayRestart(deps);
    state.reason = null;
    await vi.advanceTimersByTimeAsync(500);

    await expect(admission).resolves.toEqual({ admitted: false, error: 'OpenClaw config sync failed.' });
  });

  test('gives up after the bounded wait when workloads stay active', async () => {
    const { deps } = createHarness('mcp-change', true);
    const settled = vi.fn();
    const admission = admitPastDeferredGatewayRestart(deps).then((result) => {
      settled();
      return result;
    });
    await vi.advanceTimersByTimeAsync(DEFERRED_RESTART_CALLER_WAIT_MS - 1_000);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(admission).resolves.toEqual({ admitted: false });
    expect(deps.runDeferredRestart).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
