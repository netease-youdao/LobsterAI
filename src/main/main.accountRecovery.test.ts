import fs from 'node:fs';
import vm from 'node:vm';

import ts from 'typescript';
import { expect, test } from 'vitest';

import { LogReporterStoreKey } from '../shared/analytics/constants';
import { OpenClawEnginePhase } from '../shared/openclawEngine/constants';
import type { RemoteOwner } from '../shared/remote/constants';
import { AccountRecoveryCancelledError, AccountRecoveryPhase, OpenClawAccountRecovery } from './libs/openclawAccountRecovery';
import { OpenClawConfigRecovery } from './libs/openclawConfigRecovery';
import type { OpenClawEngineStatus } from './libs/openclawEngineManager';
import { payloadHash, sameOwner } from './remote/canonical';
import { RemoteAccountTransition } from './remote/remoteAccountTransition';

// Run the actual main-process account listener + recovery wiring, including
// projection and external admission. I/O is controlled; orchestration is not copied.
const source = ts.createSourceFile('main.ts', fs.readFileSync(new URL('./main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
let core: ts.Block | undefined;
const topNames = new Set(['projectOpenClawStatus', 'forwardOpenClawStatus', 'waitForAccountGatewayRecovery', 'restartGatewayPromise']);
const selected: string[] = [];
let manualRestart = '';
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'initializeSessionExecutionCore'
    && node.initializer && ts.isArrowFunction(node.initializer) && ts.isBlock(node.initializer.body)) core = node.initializer.body;
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => topNames.has(d.name.getText(source)))) {
    selected.push(node.getText(source));
  }
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(source) === 'ipcMain.handle'
    && node.expression.arguments[0]?.getText(source) === 'OpenClawEngineIpc.RestartGateway') manualRestart = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
if (!core) throw new Error('Missing main account recovery wiring');
const index = core.statements.findIndex(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(d => d.name.getText(source) === 'accountFenceKey'));
if (index < 0) throw new Error('Missing main account fence');
const compiled = ts.transpileModule(`
let openClawAccountRecovery = null;
let captureOpenClawAccountSnapshot = () => () => true;
let remoteCredentialsAllowed = true, accountGatewayStartupRequested = false, accountRecoveryManualRetry = false;
let ownershipAccountEpoch = 0, authAccountGeneration = 0;
${selected.join('\n')}
${core.statements.slice(index).map(statement => statement.getText(source)).join('\n')}
${manualRestart}
globalThis.api = {
  recovery: openClawAccountRecovery, wait: waitForAccountGatewayRecovery,
  credentials: () => remoteCredentialsAllowed, snapshot: () => captureOpenClawAccountSnapshot(),
  status: () => projectOpenClawStatus(getOpenClawEngineManager().getStatus()),
  relogin: () => { authAccountGeneration++; },
};
`, { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }

function fixture(initialPhase: OpenClawEngineStatus['phase'] = OpenClawEnginePhase.Running) {
  let owner: RemoteOwner | null = { userId: '1', scopeKey: 'personal' };
  let phase = initialPhase;
  let generation = 1;
  let token = 0;
  let stopBarrier = Promise.resolve();
  let restartBarrier = Promise.resolve();
  let configOwner: RemoteOwner | null = null;
  const values = new Map<string, unknown>();
  const listeners = new Map<string, () => void>();
  const events: string[] = [];
  const statuses: OpenClawEngineStatus[] = [];
  const configs: Array<RemoteOwner | null> = [];
  const handlers = new Map<string, () => Promise<{ success: boolean; status: OpenClawEngineStatus }>>();
  const configRecovery = new OpenClawConfigRecovery();
  const remoteAccountTransition = new RemoteAccountTransition();
  const store = {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => { values.set(key, value); },
    onCriticalChange: (key: string, listener: () => void) => listeners.set(key, listener),
  };
  const manager = {
    getStatus: (): OpenClawEngineStatus => ({ phase, version: 'fixture', canRetry: false }),
    getStateDir: () => '/fixture', getGatewayProcessGeneration: () => generation,
    isGatewayStartupBlocked: () => false,
    stopGateway: async () => {
      events.push('stop');
      await stopBarrier;
      phase = OpenClawEnginePhase.Ready;
    },
    startGateway: async () => {
      expect(api.recovery.captureStartPermit()?.()).toBe(true);
      expect(api.credentials()).toBe(true);
      expect(configOwner).toEqual(owner);
      if (phase !== OpenClawEnginePhase.Running) { events.push('spawn'); generation++; }
      phase = OpenClawEnginePhase.Running;
      return manager.getStatus();
    },
    restartGateway: async () => {
      events.push('manual-restart');
      await restartBarrier;
      return manager.getStatus();
    },
  };
  const adapter = {
    prepareForAccountTransition: () => { events.push('disconnect'); return ++token; },
    confirmAccountGatewayRecovery: async (expected: number, current: () => boolean) => {
      expect(expected).toBe(token);
      expect(current()).toBe(true);
      expect(phase).toBe(OpenClawEnginePhase.Running);
      expect(api.status().accountRecoveryPending).toBe(true);
      events.push('handshake');
    },
    finishAccountGatewayRecovery: (expected: number) => {
      expect(expected).toBe(token);
      expect(events.at(-1)).toBe('confirm');
      events.push('business');
    },
    connectGatewayIfNeeded: async () => { await api.wait(); },
  };
  const context = vm.createContext({
    AccountRecoveryCancelledError, AccountRecoveryPhase, OpenClawAccountRecovery, OpenClawEnginePhase,
    LogReporterStoreKey, payloadHash, sameOwner, remoteAccountTransition,
    openClawConfigRecovery: configRecovery, deferredRestartReason: null,
    isQuitting: false, isDataMigrationRestoreInProgress: false,
    getRemoteAccountEpoch: () => vm.runInContext('`${ownershipAccountEpoch}:${authAccountGeneration}`', context),
    getCurrentRemoteOwner: () => owner, getAuthTokens: () => owner ? { accessToken: 'fixture' } : null,
    getOpenClawEngineManager: () => manager, openClawRuntimeAdapter: adapter,
    getStore: () => store, getCoworkStore: () => ({ remote: {} }),
    resetOpenClawConfigRecoveryForAccount: (identity: string) => configRecovery.resetForOwner(identity),
    startAskUserServer: async () => {},
    syncOpenClawConfig: async ({ reason }: { reason: string }) => {
      await remoteAccountTransition.wait(); // Same dependency as the real config queue.
      expect(api.recovery.authMutationPending).toBe(false);
      if (reason.endsWith('prepare')) {
        configOwner = owner && { ...owner };
        configs.push(configOwner);
        events.push('prepare');
      } else events.push('confirm');
      return { success: true };
    },
    fenceCronJobs: () => { events.push('fence'); },
    desktopCompanionManager: null, remoteSessionCommands: null, remoteBridge: null, remoteSettingsController: null,
    revalidateArtifactPreviews: () => {},
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_channel: string, status: OpenClawEngineStatus) => statuses.push(status) } }] },
    OpenClawEngineIpc: { OnProgress: 'progress', RestartGateway: 'restart' }, t: (key: string) => key,
    ipcMain: { handle: (channel: string, handler: () => Promise<{ success: boolean; status: OpenClawEngineStatus }>) => handlers.set(channel, handler) },
    console: { info: () => {}, warn: () => {}, error: () => {} },
  });
  vm.runInContext(compiled, context);
  const api = (context as unknown as { api: {
    recovery: OpenClawAccountRecovery; wait(): Promise<void>; credentials(): boolean;
    snapshot(): () => boolean; status(): OpenClawEngineStatus; relogin(): void;
  } }).api;
  return {
    api, events, statuses, configs, values, manager,
    stopAfter: (barrier: Promise<void>) => { stopBarrier = barrier; },
    restartAfter: (barrier: Promise<void>) => { restartBarrier = barrier; },
    restart: () => handlers.get('restart')!(),
    change: (next: RemoteOwner | null) => { owner = next; listeners.get(LogReporterStoreKey.AuthUser)!(); },
    refresh: () => listeners.get('auth_tokens')!(),
  };
}

test('main actively restores a running gateway after fence and auth commit, without tasks or a websocket', async () => {
  const f = fixture();
  const revision = f.api.recovery.beginAuthMutation();
  f.change({ userId: '2', scopeKey: 'enterprise:10' });
  expect(f.api.credentials()).toBe(false);
  await flush();
  expect(f.values.get('remote_account_execution_fence')).toMatchObject({ phase: 'ready' });
  expect(f.api.credentials()).toBe(false);
  expect(f.events).not.toContain('spawn');
  f.api.recovery.commitAuthMutation(revision);
  await f.api.recovery.wait();
  expect(f.events).toEqual(['disconnect', 'stop', 'fence', 'prepare', 'spawn', 'handshake', 'confirm', 'business']);
  expect(f.configs).toEqual([{ userId: '2', scopeKey: 'enterprise:10' }]);
  expect(f.statuses.slice(0, -1).every(status => status.phase === OpenClawEnginePhase.Starting)).toBe(true);
  expect(f.statuses.at(-1)?.phase).toBe(OpenClawEnginePhase.Running);
});

test('main waits for old process stop even when auth commits first', async () => {
  const f = fixture();
  const stopping = deferred();
  f.stopAfter(stopping.promise);
  const revision = f.api.recovery.beginAuthMutation();
  f.change(null);
  f.api.recovery.commitAuthMutation(revision);
  await flush();
  expect(f.api.credentials()).toBe(false);
  expect(f.events).not.toContain('prepare');
  stopping.resolve();
  await f.api.recovery.wait();
  expect(f.configs).toEqual([null]);
  expect(f.events.at(-1)).toBe('business');
});

test('main renews same-owner login generation but ordinary token refresh does not restart', async () => {
  const f = fixture();
  f.refresh();
  expect(f.events).toEqual([]);
  const revision = f.api.recovery.beginAuthMutation();
  f.api.relogin();
  f.refresh();
  f.api.recovery.commitAuthMutation(revision);
  await f.api.recovery.wait();
  const oldPermit = f.api.recovery.captureStartPermit()!;
  const next = f.api.recovery.beginAuthMutation();
  f.api.relogin();
  f.refresh();
  expect(oldPermit()).toBe(false);
  f.api.recovery.commitAuthMutation(next);
  await f.api.recovery.wait();
  f.refresh();
  expect(f.events.filter(event => event === 'spawn')).toHaveLength(2);
  expect(f.api.recovery.captureStartPermit()?.()).toBe(true);
});

test('main preserves stopped intent, then external startup completes the already prepared recovery', async () => {
  const f = fixture(OpenClawEnginePhase.Ready);
  f.change({ userId: '2', scopeKey: 'personal' });
  await f.api.recovery.wait();
  expect(f.events).not.toContain('spawn');
  await f.api.wait();
  expect(f.events.filter(event => event === 'stop')).toHaveLength(1);
  expect(f.events.filter(event => event === 'prepare')).toHaveLength(1);
  expect(f.events.at(-1)).toBe('business');
});

test('main continuous switches publish only the latest account config after a delayed stop', async () => {
  const f = fixture();
  const stopping = deferred();
  f.stopAfter(stopping.promise);
  const first = f.api.recovery.beginAuthMutation();
  f.change({ userId: '2', scopeKey: 'personal' });
  await flush();
  const latest = f.api.recovery.beginAuthMutation();
  f.change({ userId: '1', scopeKey: 'personal' });
  f.api.recovery.commitAuthMutation(first);
  stopping.resolve();
  await flush();
  expect(f.api.credentials()).toBe(false);
  f.api.recovery.commitAuthMutation(latest);
  await f.api.recovery.wait();
  expect(f.configs).toEqual([{ userId: '1', scopeKey: 'personal' }]);
  expect(f.events.filter(event => event === 'spawn')).toHaveLength(1);
});

test('manual restart resumes a stopped account through confirmation without a preliminary bare restart', async () => {
  const f = fixture(OpenClawEnginePhase.Ready);
  f.change({ userId: '2', scopeKey: 'personal' });
  await f.api.recovery.wait();
  const result = await f.restart();
  expect(result.success).toBe(true);
  expect(f.events).not.toContain('manual-restart');
  expect(f.events.at(-1)).toBe('business');
});

test('manual restart cancelled by an account change cannot report success', async () => {
  const f = fixture();
  const restarting = deferred();
  f.restartAfter(restarting.promise);
  const pending = f.restart();
  await flush();
  const revision = f.api.recovery.beginAuthMutation();
  f.change({ userId: '2', scopeKey: 'personal' });
  restarting.resolve();
  const result = await pending;
  expect(result.success).toBe(false);
  expect(result.status.accountRecoveryPending).toBe(true);
  f.api.recovery.commitAuthMutation(revision);
  await f.api.recovery.wait();
});
