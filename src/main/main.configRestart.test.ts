import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import ts from 'typescript';
import { afterEach, expect, test, vi } from 'vitest';

import { OPENCLAW_MODEL_COMPAT_PLUGIN_ID, OpenClawConfigApplyPendingReason, OpenClawEnginePhase } from '../shared/openclawEngine/constants';
import { OpenClawAccountRecovery } from './libs/openclawAccountRecovery';
import { OpenClawModelRuntimeChange, resolveOpenClawModelRuntimeChange } from './libs/openclawConfigAdmission';
import {
  CONFIG_DELIVERY_FALLBACK_REASON_PREFIX,
  DEFERRED_SYNC_REASON_PREFIX,
  deliverOpenClawConfigToGateway,
  isConfigDeliveryFallbackReason,
  isPersistentConfigDeliveryFailure,
  mergeDeferredGatewayRestartReason,
  type OpenClawConfigDeliveryInput,
  OpenClawConfigDeliveryMode,
  OpenClawConfigRpcMethod,
} from './libs/openclawConfigDelivery';
import { createStableConfigFingerprint, OpenClawConfigImpact } from './libs/openclawConfigImpact';
import { ConfigDiagnosticErrorKind, ConfigDiagnosticOutcome, ConfigDiagnosticStage, ConfigWorkloadState, observeConfigRecovery } from './libs/openclawConfigObservation';
import { OpenClawConfigRecovery } from './libs/openclawConfigRecovery';
import { createOpenClawConfigStartupInputs } from './libs/openclawConfigRestartInputs';
import { createOpenClawConfigTarget, rebaseOpenClawConfigTarget, sameOpenClawConfigContent } from './libs/openclawConfigTarget';
import { OpenClawImConfigRestartTracker } from './libs/openclawImConfigRestart';
import { OpenClawPluginInstallMigrationStatus } from './libs/openclawPluginInstallMigration';
import { collectReferencedEnvVarNames, pickReferencedSecretEnvVars } from './libs/openclawSecretEnv';

// Evaluate the actual main.ts config/deferred functions with inert external
// boundaries. The implementation is not copied into the fixture: assertions
// cover queueing, request creation, publication, restart and final confirmation.
const mainPath = fileURLToPath(new URL('./main.ts', import.meta.url));
const source = ts.createSourceFile(mainPath, fs.readFileSync(mainPath, 'utf8'), ts.ScriptTarget.Latest, true);
const names = new Set([
  'deferredRestartTimer', 'deferredRestartTimeout', 'deferredRestartOverdue',
  'DEFERRED_RESTART_POLL_MS', 'DEFERRED_RESTART_OVERDUE_MS', 'clearDeferredRestart',
  'openClawConfigApplyQueue', 'openClawConfigApplyState', 'openClawConfigApplyGeneration',
  'openClawConfigRecovery', 'deferredRestartReason', 'deferredRestartRequestedAt',
  'resetOpenClawConfigRecoveryForAccount', 'imConfigRestartTracker',
  'buildConfigApplyPendingStatus', 'buildConfigApplyErrorStatus', 'buildConfigRejectedStatus',
  'stallConfigRecoveryIfExhausted', 'executeDeferredGatewayRestart',
  'scheduleDeferredGatewayRestart', '_syncOpenClawConfigImpl', 'syncOpenClawConfig',
  'resolvePendingConfigImpact', 'waitForOpenClawConfigApply',
  'openClawConfigRecoveryGeneration', 'AUTH_REFRESH_CONFIG_RECOVERY_REASON',
  'canRunDeferredGatewayRestart', 'scheduleInterruptedConfigRecovery',
]);
const selected = source.statements.filter(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name)
    && names.has(declaration.name.text)));
const compiled = ts.transpileModule(selected.map(statement => statement.getText(source)).join('\n') + `
  globalThis.fixtureApi = {
    sync: syncOpenClawConfig,
    retry: () => executeDeferredGatewayRestart(deferredRestartReason ?? 'retry'),
    state: openClawConfigRecovery,
    reset: resetOpenClawConfigRecoveryForAccount,
    pendingReason: () => deferredRestartReason,
    admit: model => waitForOpenClawConfigApply('fixture task startup', true, model),
    syncing: () => openClawConfigApplyState !== null,
    settled: async () => { await Promise.resolve(); await openClawConfigApplyQueue; },
  };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

const raw = (models = ['first'], compat = false) => JSON.stringify({
  models: { providers: { test: { apiKey: '${KEY}', api: compat ? OPENCLAW_MODEL_COMPAT_PLUGIN_ID : 'openai-completions', models } } },
});
type Phase = typeof OpenClawEnginePhase[keyof typeof OpenClawEnginePhase];
type SyncOptions = { reason: string; isAccountCurrent?: () => boolean; restartGatewayIfRunning?: boolean };

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture(realDelivery = false) {
  vi.useFakeTimers();
  const noop = () => {};
  if (realDelivery) { vi.spyOn(console, 'log').mockImplementation(noop); vi.spyOn(console, 'warn').mockImplementation(noop); }
  let disk = '{}';
  let desired = raw();
  let desiredEnv = { KEY: 'first' };
  let managerEnv: Record<string, string> = {};
  let revision = '';
  let phase: Phase = OpenClawEnginePhase.Ready;
  let generation = 0;
  let processRaw: string | null = null;
  let processEnv: Record<string, string> | null = null;
  let processRevision: string | null = null;
  let workloads = false;
  let keepStaleSpawnInputs = false;
  let failedDeliveries = 0;
  let ownerEpoch = 0;
  let migrate: () => Promise<unknown> = async () => ({ status: OpenClawPluginInstallMigrationStatus.NotNeeded });
  const events: string[] = [];
  const applied: string[] = [];
  const restartDemands: unknown[] = [];
  const intervals = new Set<() => void>();
  const timeouts = new Set<() => void>();
  const intervalSchedules: number[] = [];
  const intervalHandles = new Map<() => void, ReturnType<typeof setInterval>>();
  const timeoutHandles = new Map<() => void, ReturnType<typeof setTimeout>>();
  const diagnostics: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<{ method: string; params: any }> = [];
  let onGet: (() => void | Promise<void>) | null = null;
  let applicationUnconfirmed = false;
  const account = new OpenClawAccountRecovery({
    identity: () => `owner-${ownerEpoch}`, canRun: () => true, allowCredentials: noop,
    prepare: async () => {}, start: async () => {}, confirm: async () => {}, complete: noop, changed: noop, canRetry: () => true,
  });
  const rpc = { request: async <T,>(method: string, params?: any): Promise<T> => {
    rpcCalls.push({ method, params });
    if (method === OpenClawConfigRpcMethod.Get) {
      await onGet?.();
      return { hash: 'fixture-hash', valid: true, raw: disk, configRevisionHash: 'resolved', appliedConfigHash: applicationUnconfirmed ? 'previous' : 'resolved' } as T;
    }
    if (method === OpenClawConfigRpcMethod.Apply) {
      disk = params.raw; applied.push(disk); events.push('confirm');
      return { ok: true } as T;
    }
    throw new Error('Unexpected fixture RPC');
  } };
  const capture = () => ({ raw: disk, env: { ...managerEnv }, revision });
  const start = (inputs = capture()) => {
    generation++;
    processRaw = inputs.raw; processEnv = inputs.env; processRevision = inputs.revision;
    phase = OpenClawEnginePhase.Running;
  };
  const manager = {
    getStatus: () => ({ phase }), getStateDir: () => '/fixture', getConfigPath: () => '/fixture/config.json',
    getRuntimeRoot: () => '/fixture', getSecretEnvVars: () => managerEnv,
    setSecretEnvVars: (env: Record<string, string>) => { managerEnv = env; },
    setGatewayStartupInputRevision: (next: string) => { revision = next; events.push('revision'); },
    getGatewayProcessStartupInputRevision: () => processRevision,
    getGatewayProcessSecretEnvVars: () => processEnv,
    getGatewayProcessConfigRaw: () => processRaw,
    getGatewayProcessGeneration: () => generation,
    getGatewayConnectionInfo: () => ({ generation }),
    getGatewayProcessPid: () => processRaw ? 100 + generation : null,
    isGatewaySelfRestartActive: () => false,
    setExternalError: (message: string) => ({ phase: OpenClawEnginePhase.Error, message }),
    setConfigApplyStall: noop,
    restartGateway: async (_reason: string, options: { beforeStart: () => void }) => {
      events.push('stop'); phase = OpenClawEnginePhase.Ready;
      const stale = { raw: processRaw ?? disk, env: processEnv ?? managerEnv, revision: processRevision ?? revision };
      processRaw = null; processEnv = null; processRevision = null;
      options.beforeStart();
      restartDemands.push(api.state.pendingRestartDemand);
      events.push('start');
      start(keepStaleSpawnInputs ? stale : capture());
      return manager.getStatus();
    },
  };
  const configSync = {
    collectSecretEnvVars: () => desiredEnv,
    prepare: () => ({ ok: true, changed: !sameOpenClawConfigContent(disk, desired),
      target: createOpenClawConfigTarget(disk, desired) }),
  };
  const context = vm.createContext({
    console: { log: noop, warn: noop, error: noop }, process, Date,
    setInterval: (callback: () => void, delay: number) => {
      intervalSchedules.push(delay); intervals.add(callback); intervalHandles.set(callback, setInterval(callback, delay)); return callback;
    },
    clearInterval: (callback: () => void) => { clearInterval(intervalHandles.get(callback)); intervalHandles.delete(callback); intervals.delete(callback); },
    setTimeout: (callback: () => void, delay: number) => {
      timeouts.add(callback); timeoutHandles.set(callback, setTimeout(() => { timeouts.delete(callback); timeoutHandles.delete(callback); callback(); }, delay)); return callback;
    },
    clearTimeout: (callback: () => void) => { clearTimeout(timeoutHandles.get(callback)); timeoutHandles.delete(callback); timeouts.delete(callback); },
    OpenClawConfigRecovery, OpenClawImConfigRestartTracker, OpenClawEnginePhase, OpenClawConfigImpact,
    OpenClawConfigDeliveryMode, OpenClawPluginInstallMigrationStatus, ConfigDiagnosticErrorKind,
    CONFIG_DELIVERY_FALLBACK_REASON_PREFIX, DEFERRED_SYNC_REASON_PREFIX,
    isConfigDeliveryFallbackReason, mergeDeferredGatewayRestartReason, isPersistentConfigDeliveryFailure,
    createStableConfigFingerprint, createOpenClawConfigStartupInputs, sameOpenClawConfigContent,
    collectReferencedEnvVarNames, pickReferencedSecretEnvVars, rebaseOpenClawConfigTarget,
    OpenClawConfigApplyPendingReason, OpenClawModelRuntimeChange, resolveOpenClawModelRuntimeChange,
    ConfigDiagnosticOutcome, ConfigDiagnosticStage, ConfigWorkloadState, observeConfigRecovery,
    app: { getPath: () => '/fixture' }, gwDiagTs: () => '', t: (key: string) => key,
    getOpenClawEngineManager: () => manager, getOpenClawConfigSync: () => configSync,
    getOpenClawUserConfigOverlay: () => ({ prepare: (raw: string) => raw, handleConfigAccepted: noop, handleConfigFailure: noop }),
    getCoworkStore: () => ({ listUserPlugins: () => [] }),
    patchEnabledNspClawguard: () => false,
    getElectronNodeRuntimePath: () => '/fixture/node',
    migrateLegacyOpenClawPluginInstalls: () => migrate(),
    getMcpRuntime: () => ({ refreshResolvedServersCache: async () => {}, clearResolvedServersCache: noop }),
    remoteAccountTransition: { wait: async () => {} },
    openClawAccountRecovery: account,
    captureOpenClawAccountSnapshot: () => {
      const captured = ownerEpoch, revision = account.authRevision;
      return () => captured === ownerEpoch && revision === account.authRevision && !account.authMutationPending
        && !context.isQuitting && !context.isDataMigrationRestoreInProgress;
    },
    runLegacyWeixinAllowFromMigration: noop,
    getIMGatewayManager: () => ({ getConfig: () => ({}) }),
    prepareEnterpriseOpenclawConfig: (text: string) => text,
    hasActiveConfigRestartWorkloads: () => workloads,
    getConfigRestartWorkloads: () => ({ state: workloads ? ConfigWorkloadState.Busy : ConfigWorkloadState.Idle }),
    persistOpenClawConfigTarget: (_path: string, target: ReturnType<typeof createOpenClawConfigTarget>) => {
      disk = rebaseOpenClawConfigTarget(target, disk); events.push('persist'); return disk;
    },
    readOpenClawConfigRaw: () => disk,
    openClawRuntimeAdapter: { disconnectGatewayClient: () => events.push('disconnect'),
      ensureGatewayRpcClient: async () => { events.push('connect'); return rpc; } },
    deliverOpenClawConfigToGateway: async (input: OpenClawConfigDeliveryInput) => {
      if (realDelivery) return deliverOpenClawConfigToGateway(input);
      const next = input.readConfigFile();
      await input.ensureRpcClient();
      if (failedDeliveries > 0) {
        failedDeliveries--;
        return { mode: OpenClawConfigDeliveryMode.Fallback, detail: 'timeout',
          restartScheduled: false, elapsedMs: 0, errorKind: ConfigDiagnosticErrorKind.Timeout };
      }
      disk = next; applied.push(next); events.push('confirm');
      return { mode: OpenClawConfigDeliveryMode.Applied, detail: 'confirmed', restartScheduled: false, elapsedMs: 0 };
    },
    writeConfigDiagnostic: (event: Record<string, unknown>) => diagnostics.push(event), forwardOpenClawStatus: noop,
    isQuitting: false, isDataMigrationRestoreInProgress: false,
    openClawManualRepairActive: false,
  });
  vm.runInContext(compiled, context, { filename: mainPath });
  const api = context.fixtureApi as {
    sync: (options: SyncOptions) => Promise<{ success: boolean }>;
    retry: () => Promise<void>;
    reset: (epoch: string) => void;
    state: OpenClawConfigRecovery;
    pendingReason: () => string | null;
    admit: (model: string) => Promise<{ configApplyPendingReason?: string } | null>;
    syncing: () => boolean;
    settled: () => Promise<void>;
  };
  return { api, events, applied, restartDemands, intervals, timeouts, start, capture, account, diagnostics, rpcCalls, intervalSchedules,
    onGet: (callback: (() => void | Promise<void>) | null) => { onGet = callback; },
    unconfirmed: (value: boolean) => { applicationUnconfirmed = value; },
    quit: () => { context.isQuitting = true; },
    restore: () => { context.isDataMigrationRestoreInProgress = true; },
    manualRepair: (value: boolean) => { context.openClawManualRepairActive = value; },
    desired: (next: string, env = desiredEnv) => { desired = next; desiredEnv = env; },
    starting: () => { phase = OpenClawEnginePhase.Starting; },
    stopped: () => { phase = OpenClawEnginePhase.Ready; processRaw = null; processEnv = null; processRevision = null; },
    busy: (value: boolean) => { workloads = value; },
    staleRestarts: () => { keepStaleSpawnInputs = true; },
    failDeliveries: (count: number) => { failedDeliveries = count; },
    changeOwner: () => { ownerEpoch++; api.reset(`owner-${ownerEpoch}`); },
    migration: (fn: typeof migrate) => { migrate = fn; },
    generation: () => generation,
  };
}

test('main cold sync, starting model updates and actual deferred polls keep the original demand', async () => {
  const f = fixture();
  expect((await f.api.sync({ reason: 'bootstrap' })).success).toBe(true);
  expect(f.events.slice(-2)).toEqual(['persist', 'revision']);
  const startup = f.capture();
  const original = f.api.state.pendingRestartDemand;
  f.starting();
  f.desired(raw(['latest']));
  await f.api.sync({ reason: 'server-models-updated' });
  for (let poll = 0; poll < 4; poll++) {
    await f.api.retry();
    expect(f.api.state.pendingRestartDemand).toEqual(original);
  }
  f.start(startup);
  await f.api.retry();
  expect(f.api.state.pending).toBe(false);
  expect(f.events).not.toContain('stop');
  expect(f.applied.at(-1)).toContain('latest');
  expect(f.intervals.size).toBe(0);
  expect(f.timeouts.size).toBe(0);
});

test('main keeps an unchanged compatibility demand despite old disk and a new generation', async () => {
  const f = fixture();
  await f.api.sync({ reason: 'bootstrap' }); f.start();
  await f.api.sync({ reason: 'confirm' });
  f.busy(true);
  f.desired(raw(['first'], true));
  await f.api.sync({ reason: 'compat-change' });
  const demand = f.api.state.pendingRestartDemand;
  f.start(); // Independent start still loaded the old file and old revision.
  for (let poll = 0; poll < 3; poll++) {
    await f.api.retry();
    expect(f.api.state.pendingRestartDemand).toEqual(demand);
  }
  f.busy(false);
  await f.api.retry();
  expect(f.events.filter(event => event === 'stop')).toHaveLength(1);
  expect(f.api.state.pending).toBe(false);
});

test('main detects env captured before a new env revision and performs exactly one replacement', async () => {
  const f = fixture();
  await f.api.sync({ reason: 'bootstrap' });
  const oldInputs = f.capture();
  f.starting(); f.desired(raw(), { KEY: 'second' });
  await f.api.sync({ reason: 'credential-change' });
  f.start(oldInputs);
  await f.api.retry();
  expect(f.generation()).toBe(2);
  expect(f.events.filter(event => event === 'stop')).toHaveLength(1);
  expect(f.api.state.pending).toBe(false);
  await f.api.sync({ reason: 'confirm-again' });
  expect(f.events.filter(event => event === 'stop')).toHaveLength(1);
});

test('main retains busy work at overdue and stalls stale input confirmation without a restart loop', async () => {
  const f = fixture();
  await f.api.sync({ reason: 'bootstrap' }); f.start();
  await f.api.sync({ reason: 'confirm' });
  f.busy(true); f.desired(raw(), { KEY: 'second' });
  await f.api.sync({ reason: 'credential-change' });
  for (const callback of [...f.timeouts]) callback();
  expect(f.events).not.toContain('stop');
  expect(f.intervals.size).toBe(1);
  f.busy(false); f.staleRestarts();
  await f.api.retry();
  expect(f.api.state.pending).toBe(true);
  expect(f.api.state.canRestart()).toBe(false);
  await f.api.sync({ reason: 'server-models-updated' });
  expect(f.api.state.stalled).toBe(true);
  await f.api.sync({ reason: 'server-models-updated-again' });
  expect(f.events.filter(event => event === 'stop')).toHaveLength(1);
  expect(f.intervals.size).toBe(0);
});

test('main abandons old config after an awaited migration before publishing new credentials or target', async () => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  const migrationEntered = new Promise<void>(resolve => { entered = resolve; });
  f.migration(() => new Promise(resolve => {
    release = () => resolve({ status: OpenClawPluginInstallMigrationStatus.NotNeeded });
    entered();
  }));
  const operation = f.api.sync({ reason: 'old-owner' });
  await migrationEntered;
  f.changeOwner();
  release();
  expect((await operation).success).toBe(false);
  expect(f.api.state.pending).toBe(false);
  expect(f.events).not.toContain('persist');
  expect(f.events).not.toContain('start');
});

test('main records one restart demand when ordinary delivery recovery reaches its existing escalation boundary', async () => {
  const f = fixture();
  await f.api.sync({ reason: 'bootstrap' }); f.start();
  await f.api.sync({ reason: 'confirm' });
  f.desired(raw(['hot-update'])); f.failDeliveries(2);
  await f.api.sync({ reason: 'server-models-updated' });
  expect(f.api.state.requiresRespawn).toBe(false);
  await f.api.retry();
  expect(f.restartDemands).toHaveLength(1);
  expect(f.restartDemands[0]).toMatchObject({ requiredAfterGeneration: 1 });
  expect(f.api.state.pending).toBe(false);
  expect(f.events.filter(event => event === 'stop')).toHaveLength(1);
});

test('main retries a same-account refresh cancellation from a deferred config.get and admits the updated model', async () => {
  const f = fixture(true);
  await f.api.sync({ reason: 'bootstrap' }); f.start();
  for (let index = 0; index < 4; index++) await f.api.sync({ reason: 'confirm' });
  f.desired(raw(['latest'])); f.unconfirmed(true);
  const initial = f.api.sync({ reason: 'server-models-updated' });
  await vi.advanceTimersByTimeAsync(3000); await initial;
  f.unconfirmed(false);
  let refresh = 0;
  f.onGet(() => { f.onGet(null); refresh = f.account.beginAuthMutation(); });
  await vi.advanceTimersByTimeAsync(6000);
  await f.api.settled();
  expect(f.diagnostics.some(event => event.event === 'sync-start' && event.syncId === 7)).toBe(true);
  expect(f.api.state.pending).toBe(true);
  expect(f.api.syncing()).toBe(false);
  expect(f.intervals.size).toBe(1);
  expect(await f.api.admit('test/latest')).toMatchObject({ configApplyPendingReason: OpenClawConfigApplyPendingReason.ModelSettings });
  const applied = f.applied.length;
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.applied).toHaveLength(applied);
  f.account.commitAuthMutation(refresh);
  await vi.advanceTimersByTimeAsync(3000);
  await f.api.settled();
  expect(f.api.state.pending).toBe(false);
  expect(f.applied.at(-1)).toContain('latest');
  expect(await f.api.admit('test/latest')).toBeNull();
  expect(f.intervals.size).toBe(0);
  expect(f.timeouts.size).toBe(0);
  expect(f.events).not.toContain('stop');
});

async function runningConfigFixture() {
  const f = fixture(true);
  await f.api.sync({ reason: 'bootstrap' }); f.start();
  await f.api.sync({ reason: 'confirm' });
  return f;
}

async function interruptedConfigFixture() {
  const f = await runningConfigFixture();
  f.desired(raw(['latest']));
  let refresh = 0;
  f.onGet(() => { f.onGet(null); refresh = f.account.beginAuthMutation(); });
  const sync = f.api.sync({ reason: 'server-models-updated' });
  await vi.advanceTimersByTimeAsync(3000);
  expect((await sync).success).toBe(false);
  expect(f.api.state.pending).toBe(true);
  expect(f.intervals.size).toBe(1);
  return { ...f, refresh };
}

test('main retains one deferred poll across repeated same-account refresh cancellations', async () => {
  const f = await interruptedConfigFixture();
  let refresh = f.refresh;
  for (let index = 0; index < 3; index++) {
    f.onGet(() => { f.onGet(null); refresh = f.account.beginAuthMutation(); });
    f.account.commitAuthMutation(refresh);
    for (let second = 0; second < 6; second++) {
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.intervals.size).toBeLessThanOrEqual(1);
    }
    await f.api.settled();
    expect(f.api.state.pending).toBe(true);
    expect(f.intervals.size).toBe(1);
    expect(f.api.state.requiresRespawn).toBe(false);
  }
  f.account.commitAuthMutation(refresh);
  f.desired(raw(['current-after-refresh']));
  await vi.advanceTimersByTimeAsync(3000); await f.api.settled();
  expect(f.api.state.pending).toBe(false);
  expect(f.applied.at(-1)).toContain('current-after-refresh');
  expect(f.intervalSchedules.every(delay => delay === 3000)).toBe(true);
  expect(f.events).not.toContain('stop');
});

test.each(['auth', 'apply', 'repair', 'busy'] as const)(
  'main interval and five-minute timeout respect the %s guard, then recover at idle', async guard => {
    const f = await interruptedConfigFixture();
    let queued: Promise<{ success: boolean }> | null = null;
    let release = () => {};
    if (guard !== 'auth') f.account.commitAuthMutation(f.refresh);
    if (guard === 'repair') f.manualRepair(true);
    if (guard === 'busy') f.busy(true);
    if (guard === 'apply') {
      let entered!: () => void;
      const entry = new Promise<void>(resolve => { entered = resolve; });
      f.migration(() => new Promise(resolve => {
        release = () => resolve({ status: OpenClawPluginInstallMigrationStatus.NotNeeded }); entered();
      }));
      queued = f.api.sync({ reason: 'newer-sync-in-progress' });
      await entry;
      expect(f.api.syncing()).toBe(true);
    }
    const calls = f.rpcCalls.length, starts = f.diagnostics.filter(event => event.event === 'sync-start').length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.rpcCalls).toHaveLength(calls);
    expect(f.diagnostics.filter(event => event.event === 'sync-start')).toHaveLength(starts);
    expect(f.intervals.size).toBe(1);
    expect(f.api.state.pending).toBe(true);
    expect(f.events).not.toContain('stop');
    if (guard === 'auth') f.account.commitAuthMutation(f.refresh);
    if (guard === 'repair') f.manualRepair(false);
    if (guard === 'busy') f.busy(false);
    if (guard === 'apply') { release(); expect((await queued!).success).toBe(true); }
    await vi.advanceTimersByTimeAsync(3000); await f.api.settled();
    expect(f.api.state.pending).toBe(false);
    expect(f.intervals.size).toBe(0);
    expect(f.timeouts.size).toBe(0);
  },
);

test('main does not let an older cancelled sync schedule over a newer queued target', async () => {
  const f = await runningConfigFixture();
  f.desired(raw(['obsolete']));
  let newer: Promise<{ success: boolean }> | undefined;
  f.onGet(() => {
    f.onGet(null);
    const refresh = f.account.beginAuthMutation(); f.account.commitAuthMutation(refresh);
    f.desired(raw(['newest']));
    newer = f.api.sync({ reason: 'newer-models' });
  });
  const older = f.api.sync({ reason: 'older-models' });
  await vi.advanceTimersByTimeAsync(3000);
  expect((await older).success).toBe(false);
  expect((await newer!).success).toBe(true);
  expect(f.applied.at(-1)).toContain('newest');
  expect(f.applied.some(value => value.includes('obsolete'))).toBe(false);
  expect(f.api.state.pending).toBe(false);
  expect(f.intervalSchedules).toHaveLength(0);
});

test.each(['owner', 'quit', 'restore'] as const)('main never re-arms old recovery after %s invalidates a delivery', async change => {
  const f = await runningConfigFixture();
  f.desired(raw(['obsolete']));
  f.onGet(() => {
    f.onGet(null);
    if (change === 'owner') { f.changeOwner(); f.desired(raw(['new-owner'])); }
    if (change === 'quit') f.quit();
    if (change === 'restore') f.restore();
  });
  const operation = f.api.sync({ reason: 'old-models' });
  await vi.advanceTimersByTimeAsync(3000);
  expect((await operation).success).toBe(false);
  expect(f.intervalSchedules).toHaveLength(0);
  expect(f.applied.some(value => value.includes('obsolete'))).toBe(false);
  if (change === 'owner') {
    expect(f.api.state.pending).toBe(false);
    expect((await f.api.sync({ reason: 'new-owner-models' })).success).toBe(true);
    expect(f.applied.at(-1)).toContain('new-owner');
  }
});

test('main discards callbacks captured before the account reset', async () => {
  const f = await interruptedConfigFixture();
  const stale = [...f.intervals, ...f.timeouts];
  f.changeOwner(); f.account.commitAuthMutation(f.refresh);
  expect(f.intervals.size).toBe(0); expect(f.timeouts.size).toBe(0);
  expect(f.api.state.pending).toBe(false);
  const calls = f.rpcCalls.length;
  for (const callback of stale) callback();
  await vi.advanceTimersByTimeAsync(3000); await f.api.settled();
  expect(f.rpcCalls).toHaveLength(calls);
  expect(f.intervalSchedules).toHaveLength(1);
});

test('main restores the retry chain when waiting for auth commit fails before enqueueing', async () => {
  const f = await interruptedConfigFixture();
  // A consumed retry loses its interval before the auth wait; failure must re-arm it.
  const retry = f.api.retry();
  f.account.failAuthMutation(f.refresh, new Error('Profile refresh failed'));
  await retry;
  expect(f.intervals.size).toBe(1);
  expect(f.api.state.pending).toBe(true);
  expect(f.api.syncing()).toBe(false);
  const refresh = f.account.beginAuthMutation(); f.account.commitAuthMutation(refresh);
  await vi.advanceTimersByTimeAsync(3000); await f.api.settled();
  expect(f.api.state.pending).toBe(false);
  expect(f.intervals.size).toBe(0);
});

test('main leaves a deliberately stopped gateway stopped while refreshing its next-start config', async () => {
  const f = await interruptedConfigFixture();
  f.stopped(); f.account.commitAuthMutation(f.refresh);
  const generation = f.generation(), applied = f.applied.length;
  await vi.advanceTimersByTimeAsync(3000); await f.api.settled();
  expect(f.capture().raw).toContain('latest');
  expect(f.events.at(-2)).toBe('persist');
  expect(f.generation()).toBe(generation);
  expect(f.applied).toHaveLength(applied);
  expect(f.intervals.size).toBe(0);
});

test.each(['rejected', 'stalled', 'cooldown'] as const)('main automatic recovery respects %s even at the overdue deadline', async state => {
  const f = await interruptedConfigFixture();
  f.account.commitAuthMutation(f.refresh);
  const target = f.api.state.pendingTarget!;
  if (state === 'rejected') f.api.state.reject(target, 'Invalid target');
  if (state === 'stalled') {
    f.api.state.restarted();
    f.api.state.failedAfterRespawn(target, 'Cannot confirm');
    f.api.state.failedAfterRespawn(target, 'Cannot confirm');
  }
  if (state === 'cooldown') f.api.state.retryAfter(10 * 60_000);
  const calls = f.rpcCalls.length;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(f.rpcCalls).toHaveLength(calls);
  expect(f.api.state.pending).toBe(true);
  expect(f.events).not.toContain('stop');
});
