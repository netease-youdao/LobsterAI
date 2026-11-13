import fs from 'node:fs';
import vm from 'node:vm';

import ts from 'typescript';
import { afterEach, expect, test, vi } from 'vitest';

import { LogReporterStoreKey } from '../shared/analytics/constants';
import { AuthIpcChannel, AuthSessionChangeReason, AuthSessionStatus } from '../shared/auth/constants';
import { EnterpriseAccountMode, EnterpriseAccountRequestHeader, EnterpriseAccountStoreKey, EnterpriseApiErrorCode } from '../shared/enterpriseAccount/constants';
import { authQuotaGateStateFromQuota, AuthSubscriptionStatus, createDefaultAuthQuotaGateState, normalizeAuthQuota } from './authQuota';
import { buildEnterpriseAccountRequestHeaders, clearEnterpriseAccountContext, fetchEnterpriseAccountContext, getPersistedEnterpriseAccountContext, normalizeEnterpriseAccountContext, persistEnterpriseAccountContext, readAccountMode } from './enterpriseAccount/context';
import { resolveAuthSessionStatusFromError } from './libs/authSessionManager';
import { OpenClawAccountRecovery } from './libs/openclawAccountRecovery';
import { isAuthExchangeIntentCurrent, isAuthStateSnapshotCurrent } from './mediaAccountIsolation';
import { sameOwner } from './remote/canonical';

// Execute the real auth declarations/IPC callbacks from main.ts with inert I/O.
// AST selection keeps this test coupled to behavior rather than copied handlers.
const source = fs.readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const declarations = new Set([
  'authMutationRevision', 'isCurrentAuthMutation', 'saveAuthTokens', 'getAuthTokens',
  'captureAuthStateSnapshot', 'isCurrentAuthStateSnapshot', 'clearAuthTokens',
  'getEnterpriseAccountHeaders', 'getAuthUser', 'saveAuthUser', 'clearAuthUser', 'getAuthQuotaGateState',
  'hasAuthQuotaGateStateChanged', 'syncOpenClawConfigIfAuthQuotaGateChanged', 'resetAuthQuotaGateState',
  'captureAuthMutationState', 'rollbackAuthMutation', 'clearLocalAuthSession', 'normalizeQuota',
  'pendingEnterpriseAccountContextRefresh', 'refreshEnterpriseAccountContext', 'syncEnterpriseAccountContextFromPayload',
]);
const selected: string[] = [];
const channels = new Set(['AuthIpcChannel.Exchange', 'AuthIpcChannel.GetUser', 'AuthIpcChannel.GetQuota', 'AuthIpcChannel.Logout']);
function select(node: ts.Node): void {
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declarations.has(declaration.name.getText(ast)))) {
    selected.push(node.getText(ast));
  } else if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(ast) === 'ipcMain.handle'
    && channels.has(node.expression.arguments[0]?.getText(ast))) {
    selected.push(node.getText(ast));
  }
  ts.forEachChild(node, select);
}
select(ast);
const compiled = ts.transpileModule(`
let authAccountGeneration = 0, authExchangeIntentSequence = 0, activeAuthExchangeIntent = null;
let cachedSubscriptionStatus = AuthSubscriptionStatus.Free, cachedMediaGenerationEntitled = false;
const MEDIA_ENTITLEMENT_SYNC_REASON = 'media-entitlement-changed';
${selected.join('\n')}
globalThis.auth = { clearLocalAuthSession, refreshEnterpriseAccountContext, getAuthQuotaGateState };
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

const personalUser = { userId: 1, accountMode: EnterpriseAccountMode.Personal };
const enterprise = { accountMode: EnterpriseAccountMode.Enterprise, enterpriseId: 20, memberId: 2, enterpriseName: 'Team', role: 'member' };
const response = (data: unknown, code = 0) => ({ ok: true, status: 200, json: async () => ({ code, data }) });

function fixture() {
  const values = new Map<string, unknown>([
    ['auth_tokens', { accessToken: 'old-access', refreshToken: 'old-refresh' }],
    [LogReporterStoreKey.AuthUser, personalUser],
  ]);
  let models: unknown[] = [{ id: 'old-model' }];
  let failUserWrite = false;
  const writes: Array<{ key: string; pending: boolean }> = [];
  const commits: Array<{ revision: number; user: unknown; context: unknown; tokens: unknown; models: unknown[]; quota: unknown }> = [];
  const recovery = new OpenClawAccountRecovery({
    identity: () => 'fixture', canRun: () => true, allowCredentials: () => {},
    prepare: async () => {}, start: async () => {}, confirm: async () => {},
    complete: () => {}, changed: () => {}, canRetry: () => false,
  });
  const store = {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      writes.push({ key, pending: recovery.authMutationPending });
      if (failUserWrite && key === LogReporterStoreKey.AuthUser) { failUserWrite = false; throw new Error('user persistence failed'); }
      values.set(key, value);
    },
    delete: (key: string) => { writes.push({ key, pending: recovery.authMutationPending }); values.delete(key); },
  };
  const handlers = new Map<string, (...args: unknown[]) => Promise<Record<string, unknown>>>();
  const fetchWithAuth = vi.fn(async () => response({ accountMode: EnterpriseAccountMode.Personal }));
  const exchangeFetch = vi.fn<(input: string, init: RequestInit) => Promise<ReturnType<typeof response>>>(async () => response({
    accessToken: 'new-access', refreshToken: 'new-refresh', user: { userId: 2, accountMode: EnterpriseAccountMode.Personal },
    quota: { subscriptionStatus: AuthSubscriptionStatus.Free },
  }));
  const purchase = vi.fn(async (): Promise<unknown> => null);
  const owner = () => {
    const user = values.get(LogReporterStoreKey.AuthUser) as { userId?: number } | undefined;
    const context = values.get(EnterpriseAccountStoreKey.Context) as { enterpriseId?: number } | undefined;
    return values.has('auth_tokens') && user?.userId ? { userId: String(user.userId), scopeKey: context?.enterpriseId ? `enterprise:${context.enterpriseId}` : 'personal' } : null;
  };
  const globals = {
    openClawAccountRecovery: recovery, LogReporterStoreKey, AuthIpcChannel, AuthSessionChangeReason, AuthSessionStatus,
    EnterpriseAccountMode, EnterpriseApiErrorCode, AuthSubscriptionStatus,
    authQuotaGateStateFromQuota, createDefaultAuthQuotaGateState, normalizeAuthQuota,
    buildEnterpriseAccountRequestHeaders, clearEnterpriseAccountContext, fetchEnterpriseAccountContext, getPersistedEnterpriseAccountContext,
    normalizeEnterpriseAccountContext, persistEnterpriseAccountContext, readAccountMode,
    isAuthExchangeIntentCurrent, isAuthStateSnapshotCurrent, resolveAuthSessionStatusFromError, sameOwner,
    getStore: () => store, getCurrentRemoteOwner: owner,
    getCurrentMediaAccountScope: () => ({ ownerAccountKey: 'fixture', accountGeneration: 0 }),
    captureEnterpriseAuthSessionSnapshot: () => null,
    getServerApiBaseUrl: vi.fn(() => 'https://test.invalid'), fetchWithAuth, net: { fetch: exchangeFetch },
    activateLowCreditPurchaseOffer: purchase, withKeyfromBody: vi.fn((value: unknown) => value),
    AbortController, setTimeout, clearTimeout,
    handleEnterpriseAccountContextMismatch: () => false, handleEnterpriseMembershipRevocation: () => false,
    getAllServerModelMetadata: () => [...models], clearServerModelMetadata: () => { models = []; },
    updateServerModelMetadata: (value: unknown[]) => { models = [...value]; },
    remoteSessionCommands: null, remoteBridge: null, desktopCompanionManager: null,
    revalidateArtifactPreviews: () => {}, clearMediaPollingStateForOwner: () => {}, stopMediaPollTimer: () => {},
    mediaSelectionBySession: new Map(), mediaTurnAccountScopeBySession: new Map(), mediaReferencesBySession: new Map(), pendingMediaTasks: new Map(),
    syncOpenClawConfig: vi.fn(async () => {}), emitAuthSessionChanged: vi.fn(), emitAuthLifecycleEvent: vi.fn(),
    t: (key: string) => key, console: { debug: () => {}, log: () => {}, warn: () => {}, error: () => {} },
    ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<Record<string, unknown>>) => handlers.set(name, handler) },
  };
  const context = vm.createContext(globals);
  vm.runInContext(compiled, context);
  const auth = (context as unknown as { auth: {
    clearLocalAuthSession(options: { reason: string; notifyRenderer: boolean }): void;
    refreshEnterpriseAccountContext(): ReturnType<typeof fetchEnterpriseAccountContext>;
    getAuthQuotaGateState(): unknown;
  } }).auth;
  const commit = recovery.commitAuthMutation.bind(recovery);
  vi.spyOn(recovery, 'commitAuthMutation').mockImplementation(revision => {
    commits.push({ revision, user: values.get(LogReporterStoreKey.AuthUser), context: values.get(EnterpriseAccountStoreKey.Context),
      tokens: values.get('auth_tokens'), models: [...models], quota: auth.getAuthQuotaGateState() });
    commit(revision);
  });
  return { values, writes, commits, recovery, fetchWithAuth, exchangeFetch, purchase, auth,
    failNextUserWrite: () => { failUserWrite = true; },
    exchange: () => handlers.get(AuthIpcChannel.Exchange)!({ sender: { id: 1 } }, { code: 'auth-code' }),
    getUser: () => handlers.get(AuthIpcChannel.GetUser)!(),
    getQuota: () => handlers.get(AuthIpcChannel.GetQuota)!(),
    logout: () => handlers.get(AuthIpcChannel.Logout)!(),
    syncConfig: globals.syncOpenClawConfig,
    getServerApiBaseUrl: globals.getServerApiBaseUrl,
    withKeyfromBody: globals.withKeyfromBody,
    emitAuthSessionChanged: globals.emitAuthSessionChanged,
  };
}

test('Exchange commits required identity, enterprise context and quota before waiting for marketing', async () => {
  const h = fixture();
  const context = Promise.withResolvers<ReturnType<typeof response>>();
  const offer = Promise.withResolvers<unknown>();
  h.exchangeFetch.mockResolvedValue(response({ accessToken: 'new', refreshToken: 'refresh', user: { userId: 2, accountMode: EnterpriseAccountMode.Enterprise }, quota: { planName: 'Team', subscriptionStatus: AuthSubscriptionStatus.Enterprise, creditsLimit: 8000, creditsUsed: 0 } }));
  h.fetchWithAuth.mockReturnValue(context.promise);
  h.purchase.mockReturnValue(offer.promise);
  const login = h.exchange();
  await vi.waitFor(() => expect(h.fetchWithAuth).toHaveBeenCalledTimes(1));
  expect(h.recovery.authMutationPending).toBe(true);
  expect(h.commits).toHaveLength(0);
  expect(h.writes.every(write => write.pending)).toBe(true);
  expect((await h.getUser()).status).toBe(AuthSessionStatus.TemporarilyUnavailable);
  expect((await h.auth.refreshEnterpriseAccountContext()).success).toBe(false);
  context.resolve(response(enterprise));
  await vi.waitFor(() => expect(h.purchase).toHaveBeenCalledTimes(1));
  expect(h.recovery.authMutationPending).toBe(false);
  expect(h.commits).toHaveLength(1);
  expect(h.commits[0]).toMatchObject({ user: { userId: 2 }, context: { enterpriseId: 20 }, models: [], quota: { subscriptionStatus: AuthSubscriptionStatus.Enterprise } });
  offer.resolve(null);
  expect((await login).success).toBe(true);
});

test('Exchange restores a complete old snapshot under a new revision after a persistence failure', async () => {
  const h = fixture();
  h.failNextUserWrite();
  expect((await h.exchange()).success).toBe(false);
  expect(h.recovery.authRevision).toBe(2);
  expect(h.recovery.authMutationPending).toBe(false);
  expect(h.commits).toEqual([expect.objectContaining({ revision: 2, user: personalUser, tokens: { accessToken: 'old-access', refreshToken: 'old-refresh' }, models: [{ id: 'old-model' }] })]);
});

test('logout commits after clearing credentials, user, context, model cache and quota', () => {
  const h = fixture();
  h.auth.clearLocalAuthSession({ reason: AuthSessionChangeReason.UserLogout, notifyRenderer: false });
  expect(h.writes.every(write => write.pending)).toBe(true);
  expect(h.commits).toEqual([expect.objectContaining({ tokens: undefined, user: undefined, context: undefined, models: [], quota: createDefaultAuthQuotaGateState() })]);
  expect(h.recovery.authMutationPending).toBe(false);
});

test('GetUser discards a delayed profile response after another auth mutation commits', async () => {
  const h = fixture();
  const profile = Promise.withResolvers<ReturnType<typeof response>>();
  h.fetchWithAuth.mockReturnValue(profile.promise);
  const refresh = h.getUser();
  await Promise.resolve();
  h.auth.clearLocalAuthSession({ reason: AuthSessionChangeReason.UserLogout, notifyRenderer: false });
  profile.resolve(response({ userId: 2, accountMode: EnterpriseAccountMode.Personal }));
  expect((await refresh).success).toBe(false);
  expect(h.values.has(LogReporterStoreKey.AuthUser)).toBe(false);
  expect(h.commits).toHaveLength(1);
});

test('GetUser early quota-body exit rolls back its revision and preserves a same-account token refresh', async () => {
  const h = fixture();
  const quota = Promise.withResolvers<{ code: number; data: unknown }>();
  h.fetchWithAuth.mockResolvedValueOnce(response({ ...personalUser, displayName: 'uncommitted' }));
  h.fetchWithAuth.mockResolvedValueOnce({ ok: true, status: 200, json: () => quota.promise });
  const refresh = h.getUser();
  await vi.waitFor(() => expect(h.fetchWithAuth).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  h.values.set('auth_tokens', { accessToken: 'refreshed-access', refreshToken: 'refreshed-refresh' });
  quota.resolve({ code: 0, data: {} });
  expect((await refresh).success).toBe(false);
  expect(h.recovery.authMutationPending).toBe(false);
  expect(h.values.get(LogReporterStoreKey.AuthUser)).toEqual(personalUser);
  expect(h.values.get('auth_tokens')).toEqual({ accessToken: 'refreshed-access', refreshToken: 'refreshed-refresh' });
  expect(h.commits).toHaveLength(1);
  expect(h.commits[0].revision).toBe(2);
});

test('standalone enterprise refresh commits only its own revision and cannot apply a late old response', async () => {
  const h = fixture();
  const context = Promise.withResolvers<ReturnType<typeof response>>();
  h.fetchWithAuth.mockReturnValue(context.promise);
  const refresh = h.auth.refreshEnterpriseAccountContext();
  expect(h.recovery.authMutationPending).toBe(true);
  h.auth.clearLocalAuthSession({ reason: AuthSessionChangeReason.UserLogout, notifyRenderer: false });
  context.resolve(response(enterprise));
  expect((await refresh).success).toBe(false);
  expect(h.values.has(EnterpriseAccountStoreKey.Context)).toBe(false);
  expect(h.commits.map(commit => commit.revision)).toEqual([2]);
  expect(h.recovery.authMutationPending).toBe(false);
});


test('GetQuota delivers changed entitlement config only after its enterprise context refresh commits', async () => {
  const h = fixture();
  const context = Promise.withResolvers<ReturnType<typeof response>>();
  const delivered: Array<{ pending: boolean; quota: unknown }> = [];
  h.syncConfig.mockImplementation(async () => {
    delivered.push({ pending: h.recovery.authMutationPending, quota: h.auth.getAuthQuotaGateState() });
  });
  h.fetchWithAuth.mockResolvedValueOnce(response({ subscriptionStatus: AuthSubscriptionStatus.Active, creditsLimit: 8000, creditsUsed: 0 }));
  h.fetchWithAuth.mockReturnValueOnce(context.promise);
  const refresh = h.getQuota();
  await vi.waitFor(() => expect(h.fetchWithAuth).toHaveBeenCalledTimes(2));
  expect(h.recovery.authMutationPending).toBe(true);
  expect(delivered).toEqual([]);
  context.resolve(response({ accountMode: EnterpriseAccountMode.Personal }));
  expect((await refresh).success).toBe(true);
  expect(h.commits).toHaveLength(1);
  expect(delivered).toEqual([{ pending: false, quota: {
    subscriptionStatus: AuthSubscriptionStatus.Active, mediaGenerationEntitled: true,
  } }]);
});


afterEach(() => vi.useRealTimers());

test('Logout clears local state and emits before a fast remote request completes', async () => {
  vi.useFakeTimers();
  const h = fixture();
  h.values.set(EnterpriseAccountStoreKey.Context, enterprise);
  h.exchangeFetch.mockImplementationOnce(async () => {
    expect(h.values.has('auth_tokens')).toBe(false);
    expect(h.values.has(LogReporterStoreKey.AuthUser)).toBe(false);
    expect(h.values.has(EnterpriseAccountStoreKey.Context)).toBe(false);
    expect(h.emitAuthSessionChanged).toHaveBeenCalledWith({ status: AuthSessionStatus.Unauthenticated, reason: AuthSessionChangeReason.UserLogout });
    expect(h.commits).toHaveLength(1);
    return response(null);
  });
  expect(await h.logout()).toEqual({ success: true });
  expect(h.exchangeFetch).toHaveBeenCalledOnce();
  expect(h.exchangeFetch.mock.calls[0]).toEqual(['https://test.invalid/api/auth/logout', expect.objectContaining({
    method: 'POST', body: '{}', headers: {
      Authorization: 'Bearer old-access', 'Content-Type': 'application/json',
      [EnterpriseAccountRequestHeader.AccountMode]: EnterpriseAccountMode.Enterprise,
      [EnterpriseAccountRequestHeader.EnterpriseId]: '20',
    },
  })]);
  expect(vi.getTimerCount()).toBe(0);
});

test('Logout succeeds locally after a remote rejection without retrying', async () => {
  vi.useFakeTimers();
  const h = fixture();
  h.exchangeFetch.mockRejectedValueOnce(new Error('network unavailable'));
  expect(await h.logout()).toEqual({ success: true });
  expect(h.values.has('auth_tokens')).toBe(false);
  expect(h.exchangeFetch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test('Logout bounds an unresponsive fetch and its late response cannot clear a new login', async () => {
  vi.useFakeTimers();
  const h = fixture();
  const remote = Promise.withResolvers<ReturnType<typeof response>>();
  h.exchangeFetch.mockReturnValueOnce(remote.promise);
  let completed = false;
  const logout = h.logout().then(result => { completed = true; return result; });
  const signal = h.exchangeFetch.mock.calls[0][1].signal;
  expect(h.values.has('auth_tokens')).toBe(false);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(completed).toBe(false);
  expect(signal?.aborted).toBe(false);
  expect((await h.exchange()).success).toBe(true);
  const tokens = h.values.get('auth_tokens');
  const user = h.values.get(LogReporterStoreKey.AuthUser);
  const commitCount = h.commits.length;
  await vi.advanceTimersByTimeAsync(1);
  expect(await logout).toEqual({ success: true });
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  remote.resolve(response(null));
  await Promise.resolve();
  expect(h.values.get('auth_tokens')).toBe(tokens);
  expect(h.values.get(LogReporterStoreKey.AuthUser)).toBe(user);
  expect(h.commits).toHaveLength(commitCount);
  expect(h.exchangeFetch).toHaveBeenCalledTimes(2);
});

test('Logout captures its old environment, credentials and body before local change notifications', async () => {
  const h = fixture();
  h.values.set(EnterpriseAccountStoreKey.Context, enterprise);
  h.withKeyfromBody.mockReturnValueOnce({ keyfrom: 'old-environment' });
  const oldTokens = h.values.get('auth_tokens') as { accessToken: string };
  h.emitAuthSessionChanged.mockImplementationOnce(() => {
    h.getServerApiBaseUrl.mockReturnValue('https://next.invalid');
    oldTokens.accessToken = 'changed-token';
    h.values.set(EnterpriseAccountStoreKey.Context, { ...enterprise, enterpriseId: 30 });
    h.withKeyfromBody.mockReturnValue({ keyfrom: 'next-environment' });
  });
  expect(await h.logout()).toEqual({ success: true });
  expect(h.exchangeFetch.mock.calls[0]).toEqual(['https://test.invalid/api/auth/logout', expect.objectContaining({
    body: '{"keyfrom":"old-environment"}', headers: expect.objectContaining({
      Authorization: 'Bearer old-access', [EnterpriseAccountRequestHeader.EnterpriseId]: '20',
    }),
  })]);
});

test('Logout without credentials still clears locally and makes no remote request', async () => {
  vi.useFakeTimers();
  const h = fixture();
  h.values.delete('auth_tokens');
  expect(await h.logout()).toEqual({ success: true });
  expect(h.values.has(LogReporterStoreKey.AuthUser)).toBe(false);
  expect(h.exchangeFetch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
