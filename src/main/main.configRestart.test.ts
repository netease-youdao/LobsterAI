import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import ts from 'typescript';
import { expect, test } from 'vitest';

import { OPENCLAW_MODEL_COMPAT_PLUGIN_ID, OpenClawEnginePhase } from '../shared/openclawEngine/constants';
import {
  CONFIG_DELIVERY_FALLBACK_REASON_PREFIX,
  DEFERRED_SYNC_REASON_PREFIX,
  isConfigDeliveryFallbackReason,
  isPersistentConfigDeliveryFailure,
  mergeDeferredGatewayRestartReason,
  type OpenClawConfigDeliveryInput,
  OpenClawConfigDeliveryMode,
} from './libs/openclawConfigDelivery';
import { createStableConfigFingerprint, OpenClawConfigImpact } from './libs/openclawConfigImpact';
import { ConfigDiagnosticErrorKind } from './libs/openclawConfigObservation';
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
  };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

const raw = (models = ['first'], compat = false) => JSON.stringify({
  models: { providers: { test: { apiKey: '${KEY}', api: compat ? OPENCLAW_MODEL_COMPAT_PLUGIN_ID : 'openai-completions', models } } },
});
type Phase = typeof OpenClawEnginePhase[keyof typeof OpenClawEnginePhase];
type SyncOptions = { reason: string; isAccountCurrent?: () => boolean; restartGatewayIfRunning?: boolean };

function fixture() {
  const noop = () => {};
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
    setInterval: (callback: () => void) => { intervals.add(callback); return callback; },
    clearInterval: (callback: () => void) => { intervals.delete(callback); },
    setTimeout: (callback: () => void) => { timeouts.add(callback); return callback; },
    clearTimeout: (callback: () => void) => { timeouts.delete(callback); },
    OpenClawConfigRecovery, OpenClawImConfigRestartTracker, OpenClawEnginePhase, OpenClawConfigImpact,
    OpenClawConfigDeliveryMode, OpenClawPluginInstallMigrationStatus, ConfigDiagnosticErrorKind,
    CONFIG_DELIVERY_FALLBACK_REASON_PREFIX, DEFERRED_SYNC_REASON_PREFIX,
    isConfigDeliveryFallbackReason, mergeDeferredGatewayRestartReason, isPersistentConfigDeliveryFailure,
    createStableConfigFingerprint, createOpenClawConfigStartupInputs, sameOpenClawConfigContent,
    collectReferencedEnvVarNames, pickReferencedSecretEnvVars, rebaseOpenClawConfigTarget,
    OpenClawConfigApplyPendingReason: { Applying: 'applying' },
    app: { getPath: () => '/fixture' }, gwDiagTs: () => '', t: (key: string) => key,
    getOpenClawEngineManager: () => manager, getOpenClawConfigSync: () => configSync,
    getCoworkStore: () => ({ listUserPlugins: () => [] }),
    patchEnabledNspClawguard: () => false,
    getElectronNodeRuntimePath: () => '/fixture/node',
    migrateLegacyOpenClawPluginInstalls: () => migrate(),
    getMcpRuntime: () => ({ refreshResolvedServersCache: async () => {}, clearResolvedServersCache: noop }),
    remoteAccountTransition: { wait: async () => {} },
    openClawAccountRecovery: null,
    captureOpenClawAccountSnapshot: () => { const captured = ownerEpoch; return () => captured === ownerEpoch; },
    runLegacyWeixinAllowFromMigration: noop,
    getIMGatewayManager: () => ({ getConfig: () => ({}) }),
    prepareEnterpriseOpenclawConfig: (text: string) => text,
    hasActiveConfigRestartWorkloads: () => workloads,
    persistOpenClawConfigTarget: (_path: string, target: ReturnType<typeof createOpenClawConfigTarget>) => {
      disk = rebaseOpenClawConfigTarget(target, disk); events.push('persist'); return disk;
    },
    readOpenClawConfigRaw: () => disk,
    openClawRuntimeAdapter: { disconnectGatewayClient: () => events.push('disconnect'),
      ensureGatewayRpcClient: async () => { events.push('connect'); return {}; } },
    deliverOpenClawConfigToGateway: async (input: OpenClawConfigDeliveryInput) => {
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
    writeConfigDiagnostic: noop, forwardOpenClawStatus: noop,
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
  };
  return { api, events, applied, restartDemands, intervals, timeouts, start, capture,
    desired: (next: string, env = desiredEnv) => { desired = next; desiredEnv = env; },
    starting: () => { phase = OpenClawEnginePhase.Starting; },
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
