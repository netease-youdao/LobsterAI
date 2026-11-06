import { transformSync } from 'esbuild';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { expect, it, vi } from 'vitest';
import vm from 'vm';

import { AuthRefreshFailureKind, AuthSessionStatus } from '../../shared/auth/constants';
import { CoworkIpcChannel } from '../../shared/cowork/constants';
import { formatLlmTraceparent } from '../../shared/cowork/llmTurnUsage';
import { AuthSessionRequestError } from '../libs/authSessionManager';
import {
  clearLlmUsageContexts, configureLlmUsageContextResolver, getLlmUsageContext,
  getLlmUsageHeaders, LlmUsageHeader, registerLlmUsageContext,
} from '../libs/llmUsageContext';
import { clearNativeRunTurnUsage, recordNativeRunLlmTrace } from '../libs/nativeRunTurnUsage';
import { OpenClawAccountRecovery } from '../libs/openclawAccountRecovery';
import { remoteNetworkBinaryDownload } from './remoteNetworkProtocol';
import { currentRemoteExecution, SessionCommandService } from './sessionCommandService';

it.each([false, true])('does not recover or register inaccessible turn usage (persisted ownership=%s)', persisted => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
  const start = source.indexOf('  configureLlmUsageContextResolver(');
  const end = source.indexOf('  coworkTurnUsageService =', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const traceId = 'a'.repeat(32);
  const traceparent = formatLlmTraceparent(traceId, 'b'.repeat(16));
  const owner = 'account-a:1';
  const scope = { ownerAccountKey: 'personal:account-a', accountGeneration: 1 };
  const target = {
    sessionId: 'private-session',
    message: { id: 'private-message', content: 'private prompt', metadata: { llmTrace: {
      traceId,
      ...(persisted ? { usageContext: {
        sessionId: 'private-session', ownerAccountKey: scope.ownerAccountKey, serverBaseUrl: 'https://example.invalid',
      } } : {}),
    } } },
  };
  let accessible = false;
  const canView = vi.fn(() => accessible);
  const updateMessage = vi.fn();
  const sandbox = {
    configureLlmUsageContextResolver, getAuthSessionKey: () => owner,
    getCoworkStore: () => ({ findUserMessageByTrace: () => target, updateMessage }),
    canViewCoworkSession: canView, getCurrentMediaAccountScope: () => scope,
    getServerApiBaseUrl: () => 'https://example.invalid',
    mediaTurnAccountScopeBySession: new Map(),
  };
  clearLlmUsageContexts();
  clearNativeRunTurnUsage();
  try {
    vm.runInNewContext(transformSync(source.slice(start, end), { loader: 'ts', format: 'cjs' }).code, sandbox);
    expect(getLlmUsageContext(traceId, owner)).toEqual({ sessionId: target.sessionId, userMessage: '', owner: null });
    expect(getLlmUsageHeaders(traceparent, undefined, owner)).toEqual({});
    expect(recordNativeRunLlmTrace({ runId: 'late-heartbeat', traceId }, Date.now(), owner)).toBe(false);
    registerLlmUsageContext(traceId, target.sessionId, target.message.content, { owner });
    expect(getLlmUsageHeaders(traceparent, undefined, owner)).toEqual({});
    expect(updateMessage).not.toHaveBeenCalled();
    expect(canView).toHaveBeenCalledWith(target.sessionId);

    accessible = true;
    clearLlmUsageContexts();
    registerLlmUsageContext(traceId, target.sessionId, target.message.content, { owner });
    expect(getLlmUsageHeaders(traceparent, undefined, owner)).toMatchObject({
      [LlmUsageHeader.Session]: target.sessionId,
      [LlmUsageHeader.UserMessage]: encodeURIComponent(target.message.content),
    });
    expect(updateMessage).toHaveBeenCalledTimes(persisted ? 0 : 1);
  } finally {
    configureLlmUsageContextResolver(undefined);
    clearLlmUsageContexts();
    clearNativeRunTurnUsage();
  }
});

it('wires the real desktop IPC through its actor-aware service when every optional remote initializer fails', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
  const initializers = source.slice(source.indexOf('  const initializeSessionExecutionCore ='), source.indexOf('  registerOwnershipHandlers'));
  const submissionsStart = source.indexOf('  const submitStart =');
  const submissionsEnd = source.indexOf('  ipcMain.handle(CoworkIpcChannel.SubmitBtw,', submissionsStart);
  expect(submissionsStart).toBeGreaterThan(-1);
  expect(submissionsEnd).toBeGreaterThan(submissionsStart);
  const submissions = source.slice(submissionsStart, submissionsEnd);
  // The bridge now starts after startup configuration is settled, separately from optional controls.
  const startupStart = source.indexOf('    remoteStartupReady = true;');
  const startupEnd = source.indexOf('    void ensureOpenClawRunningForCowork()', startupStart);
  expect(startupStart).toBeGreaterThan(-1);
  expect(startupEnd).toBeGreaterThan(startupStart);
  const bridgeStartup = source.slice(startupStart, startupEnd);
  const owner = { userId: 'owner', scopeKey: 'personal' };
  const handlers = new Map<string, (...args: any[]) => any>();
  const authObservers = new Map<string, () => void>();
  const runtime = new EventEmitter();
  const localStore = { remote: { setApprovalLifecycle: vi.fn() }, assertAgentAccess: vi.fn(), getAgent: () => ({ enabled: true }),
    agentOwnership: { get: () => ({ version: '1' }) } };
  const failures = [vi.fn(() => { throw new Error('telemetry unavailable'); }), vi.fn(() => { throw new Error('gc unavailable'); }),
    vi.fn(() => { throw new Error('settings unavailable'); }), vi.fn(() => { throw new Error('bridge unavailable'); })];
  const sandbox = {
    console: { warn: vi.fn(), error: vi.fn() }, path, setTimeout, payloadHash: () => 'hash',
    openClawRuntimeAdapter: null, isQuitting: false, isDataMigrationRestoreInProgress: false,
    getCurrentRemoteOwner: () => owner, getCoworkStore: () => localStore, getCoworkEngineRouter: () => runtime,
    getSessionDeletionService: vi.fn(), SessionCommandService,
    OwnershipAssociationService: class { constructor(_options: unknown) {} },
    ownershipOperationGate: undefined, ownershipAccountEpoch: 0, ownershipBootId: 'boot', authAccountGeneration: 0,
    getStore: () => ({ get: () => null, onDidChange: vi.fn(), onCriticalChange: (key: string, callback: () => void) => authObservers.set(key, callback) }),
    OpenClawAccountRecovery, remotePerformance: { start: vi.fn() }, PREVENT_SLEEP_STORE_KEY: 'prevent_sleep_enabled',
    LogReporterStoreKey: { AuthUser: 'auth_user' }, app: { getPath: () => '/tmp', getVersion: () => 'test' },
    getMainLogReporter: () => ({}), getServerApiBaseUrl: () => 'https://example.invalid',
    initializeRemoteTelemetry: failures[0], RemoteLocalGc: class { constructor() { failures[1](); } },
    RemoteSettingsController: class { constructor() { failures[2](); } }, initializeRemoteBridge: failures[3],
    remoteDiagnosticLog: vi.fn(), readRemoteState: () => ({}), getRemoteAccountEpoch: () => 'epoch',
    setPreventSleepBlockerEnabled: vi.fn(),
    startCoworkSession: async (_options: unknown, senderId?: number) => ({ owner: currentRemoteExecution()?.owner, senderId }),
    continueCoworkSession: vi.fn(), CoworkIpcChannel,
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) },
  };
  const script = `let remoteSessionCommands=null, ownershipAssociations=null, remoteTelemetryRuntime=null, remoteLocalGc=null,
    remoteSettingsController=null, remoteBridge=null, remoteCredentialsAllowed=true,
    openClawAccountRecovery=null, remoteStartupReady=false;
    ${submissions}
    ${initializers}
    initializeSessionExecutionCore(); initializeRemoteControl();
    ${bridgeStartup}`;
  vm.runInNewContext(transformSync(script, { loader: 'ts', format: 'cjs' }).code, sandbox);
  expect(failures.every(failure => failure.mock.calls.length === 1)).toBe(true);
  expect(authObservers.size).toBe(3);
  expect(handlers.has(CoworkIpcChannel.SessionContinue)).toBe(true);
  await expect(handlers.get(CoworkIpcChannel.SessionStart)!({ sender: { id: 42 } }, {}))
    .resolves.toEqual({ owner, senderId: 42 });
  expect(localStore.assertAgentAccess).toHaveBeenCalledWith('main', owner);
});


it('preserves successful JSON attachment streams while still checking enterprise API errors', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
  const wrapper = source.slice(source.indexOf('  const fetchWithAuth = async'), source.indexOf('  let sessionDeletionService:'));
  const revoked = vi.fn(), session = { userId: 'owner' };
  let sessionKey = 'owner:route-1';
  let response: Response;
  const sandbox = {
    authSessionManager: { fetchWithAuth: vi.fn(async () => response) },
    getAuthSessionKey: () => sessionKey, AuthSessionRequestError, AuthSessionStatus, AuthRefreshFailureKind,
    captureEnterpriseAuthSessionSnapshot: () => session, remoteNetworkBinaryDownload,
    readEnterpriseApiErrorCode: (value: { code?: number }) => value.code,
    EnterpriseApiErrorCode: { NotMember: 40301 },
    handleEnterpriseMembershipRevocation: revoked,
    resolveEnterpriseMembershipRevocationSource: () => 'remote',
  };
  const fetchWithAuth = vm.runInNewContext(transformSync(`${wrapper}
fetchWithAuth;`, { loader: 'ts', format: 'cjs' }).code, sandbox);
  const assetUrl = 'https://example.invalid/api/remote/v1/input-assets/asset/content?preparationId=prepared';
  const pull = vi.fn(controller => { controller.enqueue(new TextEncoder().encode('{"code":40301}')); controller.close(); });
  response = new Response(new ReadableStream({ pull }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } });
  const clone = vi.spyOn(response, 'clone');
  const downloaded = await fetchWithAuth(assetUrl);
  expect(downloaded).toBe(response); expect(clone).not.toHaveBeenCalled(); expect(pull).not.toHaveBeenCalled();
  expect(revoked).not.toHaveBeenCalled();
  expect(await downloaded.text()).toBe('{"code":40301}');

  for (const [url, status] of [[assetUrl, 403], ['https://example.invalid/api/remote/v1/capabilities', 200]] as const) {
    response = new Response('{"code":40301}', { status, headers: { 'content-type': 'application/json' } });
    const original = response;
    expect(await fetchWithAuth(url)).toBe(original);
    expect(await original.text()).toBe('{"code":40301}');
  }
  expect(revoked).toHaveBeenCalledTimes(2);
  expect(revoked).toHaveBeenLastCalledWith({ code: 40301, source: 'remote', requestSession: session });

  let release!: () => void, reading!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { reading = resolve; });
  response = new Response('{"code":40301}', { headers: { 'content-type': 'application/json' } });
  vi.spyOn(response, 'clone').mockImplementation(() => {
    const copy = new Response();
    copy.json = async () => { reading(); await paused; return { code: 40301 }; };
    return copy;
  });
  const stale = fetchWithAuth('https://example.invalid/api/remote/v1/capabilities');
  const rejected = expect(stale).rejects.toMatchObject({ failureKind: AuthRefreshFailureKind.ContextChanged });
  await started; sessionKey = 'owner:route-3'; release();
  await rejected;
  expect(revoked).toHaveBeenCalledTimes(2);
});
