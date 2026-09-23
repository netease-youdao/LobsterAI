import { expect, test } from 'vitest';

import { OpenClawConfigRecovery } from './openclawConfigRecovery';
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
