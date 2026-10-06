import { describe, expect, test, vi } from 'vitest';

import { OpenClawEnginePhase } from '../../shared/openclawEngine/constants';
import { OpenClawImConfigRestartTracker } from './openclawImConfigRestart';

function createHarness() {
  const state = { fingerprint: 'im-a', gatewayGeneration: 1 as number | undefined };
  const tracker = new OpenClawImConfigRestartTracker({
    getImConfigFingerprint: () => state.fingerprint,
    getGatewayGeneration: () => state.gatewayGeneration,
  });
  const restart = vi.fn(async () => {
    state.gatewayGeneration = (state.gatewayGeneration ?? 0) + 1;
    return { phase: OpenClawEnginePhase.Running };
  });
  return { state, tracker, restart };
}

describe('IM config restart deduplication', () => {
  test('retains the restart demand when config was only written or hot delivered', () => {
    const { state, tracker } = createHarness();
    tracker.captureConfig();
    // No config diff is not evidence that a gateway restart loaded it.
    expect(tracker.isRestartSatisfied(state.fingerprint, false)).toBe(false);
    tracker.captureConfig();
    expect(tracker.isRestartSatisfied(state.fingerprint, false)).toBe(false);
  });

  test('satisfies a queued IM save only after the preceding bootstrap restart completes', async () => {
    const { state, tracker, restart } = createHarness();
    let finishRestart!: () => void;
    const restarting = new Promise<void>(resolve => { finishRestart = resolve; });
    const bootstrap = tracker.restartGateway(tracker.captureConfig(), async () => {
      await restarting;
      return restart();
    });
    const requestedFingerprint = state.fingerprint;
    const queuedImSave = bootstrap.then(() => {
      tracker.captureConfig();
      return tracker.isRestartSatisfied(requestedFingerprint, false);
    });

    expect(tracker.isRestartSatisfied(requestedFingerprint, false)).toBe(false);
    finishRestart();
    expect(await queuedImSave).toBe(true);
    expect(restart).toHaveBeenCalledOnce();
  });

  test('retains explicit force restarts and newly rendered config changes', async () => {
    const { state, tracker, restart } = createHarness();
    await tracker.restartGateway(tracker.captureConfig(), restart);

    expect(tracker.isRestartSatisfied(state.fingerprint, false)).toBe(true);
    // Explicit login/force requests deliberately carry no deduplication fingerprint.
    expect(tracker.isRestartSatisfied(undefined, false)).toBe(false);
    expect(tracker.isRestartSatisfied(state.fingerprint, true)).toBe(false);
  });

  test('does not mark IM edits made while awaiting restart as loaded', async () => {
    const { state, tracker, restart } = createHarness();
    const renderedFingerprint = tracker.captureConfig();
    await tracker.restartGateway(renderedFingerprint, async () => {
      state.fingerprint = 'im-b';
      return restart();
    });

    tracker.captureConfig();
    expect(tracker.isRestartSatisfied(state.fingerprint, false)).toBe(false);
    await tracker.restartGateway(tracker.captureConfig(), restart);
    expect(tracker.isRestartSatisfied(state.fingerprint, false)).toBe(true);
    expect(restart).toHaveBeenCalledTimes(2);
  });

  test('invalidates an old receipt when another IM config is synced, including a later revert', async () => {
    const { state, tracker, restart } = createHarness();
    await tracker.restartGateway(tracker.captureConfig(), restart);
    state.fingerprint = 'im-b';
    tracker.captureConfig();
    state.fingerprint = 'im-a';
    tracker.captureConfig();

    expect(tracker.isRestartSatisfied(state.fingerprint, false)).toBe(false);
  });

  test.each([OpenClawEnginePhase.Error, OpenClawEnginePhase.Starting, OpenClawEnginePhase.Ready])(
    'does not count a restart ending in %s as successful',
    async phase => {
      const { state, tracker } = createHarness();
      await tracker.restartGateway(tracker.captureConfig(), async () => {
        state.gatewayGeneration = 2;
        return { phase };
      });
      expect(tracker.isRestartSatisfied(state.fingerprint, false)).toBe(false);
    },
  );

  test('discards the previous receipt when a subsequent restart fails', async () => {
    const { state, tracker, restart } = createHarness();
    await tracker.restartGateway(tracker.captureConfig(), restart);
    await expect(tracker.restartGateway(tracker.captureConfig(), async () => {
      throw new Error('gateway failed to start');
    })).rejects.toThrow('gateway failed to start');
    expect(tracker.isRestartSatisfied(state.fingerprint, false)).toBe(false);
  });

  test('does not reuse a receipt from another gateway process generation', async () => {
    const { state, tracker, restart } = createHarness();
    await tracker.restartGateway(tracker.captureConfig(), restart);
    state.gatewayGeneration = 3;
    expect(tracker.isRestartSatisfied(state.fingerprint, false)).toBe(false);
  });

  test.each([1, undefined])('requires a confirmed new gateway generation, received %s', async generation => {
    const { state, tracker } = createHarness();
    await tracker.restartGateway(tracker.captureConfig(), async () => {
      state.gatewayGeneration = generation;
      return { phase: OpenClawEnginePhase.Running };
    });
    expect(tracker.isRestartSatisfied(state.fingerprint, false)).toBe(false);
  });

  test('retains restart behavior if the IM config cannot be captured', async () => {
    let gatewayGeneration = 1;
    const tracker = new OpenClawImConfigRestartTracker({
      getImConfigFingerprint: () => { throw new Error('IM store unavailable'); },
      getGatewayGeneration: () => gatewayGeneration,
    });
    const fingerprint = tracker.captureConfig();
    expect(fingerprint).toBeNull();
    await tracker.restartGateway(fingerprint, async () => {
      gatewayGeneration += 1;
      return { phase: OpenClawEnginePhase.Running };
    });
    expect(tracker.isRestartSatisfied('im-a', false)).toBe(false);
  });
});
