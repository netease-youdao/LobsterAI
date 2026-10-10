import { expect, test } from 'vitest';

import { isDeferredRestartSatisfied, OpenClawConfigRecovery } from './openclawConfigRecovery';
import { createOpenClawConfigTarget } from './openclawConfigTarget';

const target = (port: number) => createOpenClawConfigTarget('', JSON.stringify({ models: { port } }));

test('A to B to C keeps C pending when B completes or rejects late', () => {
  const state = new OpenClawConfigRecovery();
  const b = target(3474);
  const c = target(4121);
  state.stage(target(3000), false, 1);
  state.stage(b, false, 1);
  state.stage(c, false, 1);
  state.reject(b, 'superseded');
  expect(state.applied(b, 1)).toBe(false);
  expect(state.pending).toBe(true);
  expect(state.error).toBeNull();
  expect(state.applied(c, 1)).toBe(true);
  expect(state.pending).toBe(false);
});

test('a no-op and restart cooldown never discard recovery', () => {
  const state = new OpenClawConfigRecovery();
  state.stage(target(4121), false, 1);
  state.restarted(1000);
  state.stage(target(4121), false, 2);
  expect(state.canRestart(2000)).toBe(false);
  expect(state.pending).toBe(true);
  expect(state.canRestart(601000)).toBe(true);
  expect(state.pending).toBe(true);
});

test('ordinary config and same-process reconnect cannot cancel an environment respawn', () => {
  const state = new OpenClawConfigRecovery();
  state.stage(target(3474), true, 3);
  const latest = target(4121);
  state.stage(latest, false, 3);
  expect(state.needsRespawn(3)).toBe(true);
  expect(state.applied(latest, 3)).toBe(false);
  expect(state.applied(latest, 4)).toBe(true);
  expect(state.requiresRespawn).toBe(false);
});

test('validation rejection survives a no-op, but a corrected target may converge', () => {
  const state = new OpenClawConfigRecovery();
  const invalid = target(0);
  state.stage(invalid, false, 1);
  state.reject(invalid, 'invalid config');
  state.stage(target(0), false, 1);
  expect(state.error).toBe('invalid config');
  const fixed = target(4121);
  state.stage(fixed, false, 1);
  expect(state.error).toBeNull();
  expect(state.applied(fixed, 1)).toBe(true);
});

test('stalls only after a recovery respawn could not apply the target either', () => {
  const state = new OpenClawConfigRecovery();
  const stuck = target(4121);
  state.stage(stuck, false, 1);
  // Failures before any recovery respawn keep the ordinary retry/restart path.
  expect(state.failedAfterRespawn(stuck, 'lock timeout')).toBe(false);
  expect(state.failedAfterRespawn(stuck, 'lock timeout')).toBe(false);
  expect(state.stalled).toBe(false);

  state.restarted(1_000);
  // The first failure may still race the fresh gateway's startup.
  expect(state.failedAfterRespawn(stuck, 'lock timeout')).toBe(false);
  expect(state.failedAfterRespawn(stuck, 'lock timeout')).toBe(true);
  expect(state.stalled).toBe(true);
  // A stall is not a rejection: the payload itself was never found invalid.
  expect(state.rejected).toBe(false);
  expect(state.error).toBe('lock timeout');
  // The target is retained, so a later successful delivery still converges.
  expect(state.pending).toBe(true);
});

test('a stall survives new targets until a delivery succeeds, then the respawn budget resets', () => {
  const state = new OpenClawConfigRecovery();
  const first = target(4121);
  state.stage(first, false, 1);
  state.restarted();
  state.failedAfterRespawn(first, 'stuck');
  state.failedAfterRespawn(first, 'stuck');
  const second = target(5000);
  state.stage(second, false, 2);
  expect(state.stalled).toBe(true);
  expect(state.error).toBe('stuck');

  expect(state.applied(second, 2)).toBe(true);
  expect(state.stalled).toBe(false);
  expect(state.error).toBeNull();
  const third = target(6000);
  state.stage(third, false, 2);
  expect(state.failedAfterRespawn(third, 'stuck')).toBe(false);
  expect(state.failedAfterRespawn(third, 'stuck')).toBe(false);
});

test('a late failure of an older target cannot stall the current one', () => {
  const state = new OpenClawConfigRecovery();
  const older = target(3474);
  const latest = target(4121);
  state.stage(older, false, 1);
  state.restarted();
  state.stage(latest, false, 1);
  expect(state.failedAfterRespawn(older, 'stuck')).toBe(false);
  expect(state.failedAfterRespawn(older, 'stuck')).toBe(false);
  expect(state.stalled).toBe(false);
});

test('a validation rejection takes precedence over a stall', () => {
  const state = new OpenClawConfigRecovery();
  const invalid = target(0);
  state.stage(invalid, false, 1);
  state.restarted();
  state.failedAfterRespawn(invalid, 'stuck');
  state.failedAfterRespawn(invalid, 'stuck');
  state.reject(invalid, 'invalid config');
  expect(state.error).toBe('invalid config');
  expect(state.rejected).toBe(true);
  expect(state.stalled).toBe(false);
});

test('a delivery that still owes an environment respawn clears the stall but keeps the target', () => {
  const state = new OpenClawConfigRecovery();
  const latest = target(4121);
  state.stage(latest, true, 3);
  state.restarted();
  state.failedAfterRespawn(latest, 'stuck');
  state.failedAfterRespawn(latest, 'stuck');
  expect(state.applied(latest, 3)).toBe(false);
  expect(state.stalled).toBe(false);
  expect(state.pending).toBe(true);
});

test('a deferred restart is satisfied only by a later spawn of the unchanged target', () => {
  const settled = {
    restartRequestedAt: 1_000,
    gatewayProcessStartedAt: 2_000,
    configChanged: false,
    envChanged: false,
    bindingsChanged: false,
    restartImpact: false,
  };
  expect(isDeferredRestartSatisfied(settled)).toBe(true);
  // The process that was already starting when the demand arrived loaded the old inputs.
  expect(isDeferredRestartSatisfied({ ...settled, gatewayProcessStartedAt: 1_000 })).toBe(false);
  expect(isDeferredRestartSatisfied({ ...settled, gatewayProcessStartedAt: null })).toBe(false);
  // Ordinary syncs keep their explicit restart semantics.
  expect(isDeferredRestartSatisfied({ ...settled, restartRequestedAt: undefined })).toBe(false);
  for (const change of ['configChanged', 'envChanged', 'bindingsChanged', 'restartImpact'] as const) {
    expect(isDeferredRestartSatisfied({ ...settled, [change]: true })).toBe(false);
  }
});

test('remembers the content each gateway generation confirmed applying', () => {
  const state = new OpenClawConfigRecovery();
  const first = target(3474);
  state.stage(first, false, 1);
  expect(state.pendingTarget).toBe(first);
  expect(state.appliedRawFor(1)).toBeNull();
  expect(state.applied(first, 1)).toBe(true);
  expect(state.pendingTarget).toBeNull();
  expect(state.appliedRawFor(1)).toBe(first.raw);
  expect(state.appliedRawFor(2)).toBeNull();

  const next = target(4121);
  state.stage(next, false, 1);
  expect(state.pendingTarget).toBe(next);
  expect(state.appliedRawFor(1)).toBe(first.raw);
});

test('content delivered while a respawn is still due does not count as applied', () => {
  const state = new OpenClawConfigRecovery();
  const respawned = target(3474);
  state.stage(respawned, true, 1);
  expect(state.applied(respawned, 1)).toBe(false);
  expect(state.appliedRawFor(1)).toBeNull();
  expect(state.applied(respawned, 2)).toBe(true);
  expect(state.appliedRawFor(2)).toBe(respawned.raw);
});
