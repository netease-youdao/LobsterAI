import { expect, test } from 'vitest';

import { OPENCLAW_MODEL_COMPAT_PLUGIN_ID } from '../../shared/openclawEngine/constants';
import { OpenClawConfigRecovery } from './openclawConfigRecovery';
import { createOpenClawConfigStartupInputs } from './openclawConfigRestartInputs';
import { createOpenClawConfigTarget } from './openclawConfigTarget';

const raw = (options: { models?: string[]; compat?: boolean; bindings?: unknown[]; key?: string } = {}) => JSON.stringify({
  models: { providers: { test: {
    apiKey: `\${${options.key ?? 'KEY'}}`,
    api: options.compat ? OPENCLAW_MODEL_COMPAT_PLUGIN_ID : 'openai-completions',
    models: options.models ?? ['old-model'],
  } } },
  bindings: options.bindings ?? [],
});
const empty = createOpenClawConfigStartupInputs('{}', {});
function stage(state: OpenClawConfigRecovery, source: string, env: Record<string, string>, generation: number,
  options: { explicit?: boolean; initialRaw?: string; initialEnv?: Record<string, string>; now?: number } = {}) {
  // baseRaw intentionally remains old until delivery; it must not become the retry baseline.
  const target = createOpenClawConfigTarget(options.initialRaw ?? '{}', source);
  state.stage(target, options.explicit === true, generation, {
    inputs: createOpenClawConfigStartupInputs(source, env),
    initialInputs: options.initialRaw !== undefined
      ? createOpenClawConfigStartupInputs(options.initialRaw, options.initialEnv ?? {}) : empty,
    reason: options.explicit ? 'plugin-config' : 'server-models-updated',
    requestedAt: options.now ?? 100,
  });
  return target;
}
function spawned(state: OpenClawConfigRecovery, generation: number, source: string, env: Record<string, string>,
  revision = state.startupInputRevision) {
  state.observeGatewayStartup(generation, revision, createOpenClawConfigStartupInputs(source, env));
}

test('cold startup plus hot model updates and repeated polls consume one stable process demand', () => {
  const state = new OpenClawConfigRecovery();
  const env = { KEY: 'secret' };
  stage(state, raw(), env, 0);
  const original = state.pendingRestartDemand;
  spawned(state, 1, raw(), env);
  let latest = stage(state, raw({ models: ['new-model'] }), env, 1);
  for (let poll = 0; poll < 10; poll++) {
    latest = stage(state, raw({ models: ['new-model'] }), env, 1, { now: 1000 + poll });
    expect(state.pendingRestartDemand).toEqual(original);
    expect(state.needsRespawn(1)).toBe(false);
  }
  expect(state.applied(latest, 1)).toBe(true);
});

test('an unchanged compatibility diff against old disk does not rearm a new generation', () => {
  const state = new OpenClawConfigRecovery();
  const env = { KEY: 'secret' };
  const before = raw();
  const after = raw({ compat: true });
  stage(state, after, env, 4, { initialRaw: before, initialEnv: env });
  const original = state.pendingRestartDemand;
  spawned(state, 5, before, env);
  for (let poll = 0; poll < 10; poll++) {
    stage(state, after, env, 5, { initialRaw: before, initialEnv: env, now: 1000 + poll });
    expect(state.pendingRestartDemand).toEqual(original);
    expect(state.needsRespawn(5)).toBe(true);
  }
  spawned(state, 6, after, env);
  expect(state.needsRespawn(6)).toBe(false);
});

test('an env change between env capture and actual spawn cannot be satisfied by generation alone', () => {
  const state = new OpenClawConfigRecovery();
  stage(state, raw(), { KEY: 'old' }, 0);
  const oldRevision = state.startupInputRevision;
  stage(state, raw(), { KEY: 'new' }, 0);
  const pending = state.pendingRestartDemand;
  spawned(state, 1, raw(), { KEY: 'old' }, oldRevision);
  expect(state.needsRespawn(1)).toBe(true);
  // Even a mistakenly new revision cannot replace the actual env proof.
  spawned(state, 1, raw(), { KEY: 'old' });
  expect(state.needsRespawn(1)).toBe(true);
  stage(state, raw(), { KEY: 'new' }, 1);
  expect(state.pendingRestartDemand).toEqual(pending);
  spawned(state, 2, raw(), { KEY: 'new' });
  expect(state.needsRespawn(2)).toBe(false);
});

test('a new real input after startup creates a new demand, while another hot target does not', () => {
  const state = new OpenClawConfigRecovery();
  const initial = stage(state, raw(), { KEY: 'first' }, 0);
  spawned(state, 1, raw(), { KEY: 'first' });
  expect(state.applied(initial, 1)).toBe(true);
  const previousRevision = state.startupInputRevision;
  stage(state, raw(), { KEY: 'second' }, 1, { now: 200 });
  const demand = state.pendingRestartDemand;
  expect(demand).toMatchObject({ requiredAfterGeneration: 1, requestedAt: 200 });
  expect(demand?.requestId).not.toBe(previousRevision);
  stage(state, raw({ models: ['hot'] }), { KEY: 'second' }, 1, { now: 900 });
  expect(state.pendingRestartDemand).toEqual(demand);
  expect(state.needsRespawn(1)).toBe(true);
});

test('unused secrets and newly referenced keys already present in the process do not restart', () => {
  const state = new OpenClawConfigRecovery();
  const env = { KEY: 'first', UNUSED: 'unused' };
  const initial = stage(state, raw(), env, 0);
  spawned(state, 1, raw(), env);
  expect(state.applied(initial, 1)).toBe(true);
  stage(state, raw({ key: 'UNUSED' }), env, 1);
  expect(state.requiresRespawn).toBe(false);
  stage(state, raw({ key: 'UNUSED' }), { ...env, KEY: 'unreferenced-change' }, 1);
  expect(state.requiresRespawn).toBe(false);
});

test('a previously unused secret that changed since spawn requires a process once referenced', () => {
  const state = new OpenClawConfigRecovery();
  const env = { KEY: 'first', UNUSED: 'old' };
  const initial = stage(state, raw(), env, 0);
  spawned(state, 1, raw(), env);
  expect(state.applied(initial, 1)).toBe(true);
  stage(state, raw(), { ...env, UNUSED: 'new' }, 1);
  expect(state.requiresRespawn).toBe(false);
  stage(state, raw({ key: 'UNUSED' }), { ...env, UNUSED: 'new' }, 1);
  expect(state.needsRespawn(1)).toBe(true);
});

test('new revision with an old binding snapshot is not proof of startup application', () => {
  const state = new OpenClawConfigRecovery();
  const target = stage(state, raw({ bindings: [{ agentId: 'new' }] }), { KEY: 'secret' }, 2);
  spawned(state, 3, raw(), { KEY: 'secret' });
  expect(state.needsRespawn(3)).toBe(true);
  expect(state.applied(target, 3)).toBe(false);
});

test('explicit file/state requests retain their revision until a matching spawn, including no config diff', () => {
  const state = new OpenClawConfigRecovery();
  const env = { KEY: 'secret' };
  const initial = stage(state, raw(), env, 0);
  spawned(state, 1, raw(), env);
  expect(state.applied(initial, 1)).toBe(true);
  const oldRevision = state.startupInputRevision;
  stage(state, raw(), env, 1, { explicit: true });
  const demand = state.pendingRestartDemand;
  spawned(state, 2, raw(), env, oldRevision);
  expect(state.needsRespawn(2)).toBe(true);
  stage(state, raw(), env, 2);
  expect(state.pendingRestartDemand).toEqual(demand);
  spawned(state, 3, raw(), env);
  expect(state.needsRespawn(3)).toBe(false);
});

test('a same-generation self restart cannot satisfy process requirements', () => {
  const state = new OpenClawConfigRecovery();
  stage(state, raw(), { KEY: 'secret' }, 3);
  spawned(state, 3, raw(), { KEY: 'secret' });
  expect(state.needsRespawn(3)).toBe(true);
});

test('account reset drops old targets, demand, stalls and receipts without reusing revision identity', () => {
  const state = new OpenClawConfigRecovery();
  state.resetForOwner('A-1');
  const old = stage(state, raw(), { KEY: 'A' }, 0);
  const oldRevision = state.startupInputRevision;
  state.restarted();
  state.failedAfterRespawn(old, 'failed');
  state.failedAfterRespawn(old, 'failed');
  state.resetForOwner('B-2');
  expect(state.pending).toBe(false);
  expect(state.stalled).toBe(false);
  expect(state.applied(old, 1)).toBe(false);
  const current = stage(state, raw(), { KEY: 'B' }, 1);
  expect(state.pendingRestartDemand?.ownerEpoch).toBe('B-2');
  expect(state.startupInputRevision).not.toBe(oldRevision);
  state.reject(old, 'late rejection');
  spawned(state, 2, raw(), { KEY: 'B' });
  expect(state.applied(current, 2)).toBe(true);
  state.resetForOwner('A-3');
  expect(state.startupInputRevision).not.toBe(oldRevision);
  expect(state.appliedRawFor(2)).toBeNull();
});

test('confirmed hot writes cannot reset failures of an already respawned process with stale inputs', () => {
  const state = new OpenClawConfigRecovery();
  const target = stage(state, raw(), { KEY: 'new' }, 1);
  state.restarted(100);
  spawned(state, 2, raw(), { KEY: 'old' });
  expect(state.applied(target, 2)).toBe(false);
  expect(state.failedAfterRespawn(target, 'stale startup inputs')).toBe(false);
  expect(state.applied(target, 2)).toBe(false);
  expect(state.failedAfterRespawn(target, 'stale startup inputs')).toBe(true);
  expect(state.stalled).toBe(true);
  expect(state.canRestart(200)).toBe(false);
  spawned(state, 3, raw(), { KEY: 'new' });
  expect(state.applied(target, 3)).toBe(true);
  expect(state.stalled).toBe(false);
});
