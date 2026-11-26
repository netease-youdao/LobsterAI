import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { REMOTE_CONNECTION_MANAGEMENT_CAPABILITY, RemoteConnectionReleaseState, RemoteDeviceAdmissionState, RemoteDeviceConnectionState } from '../../shared/remote/connections';
import { RemoteCapability, RemoteConnectionReason, type RemoteOwner } from '../../shared/remote/constants';
import { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteSyncTarget } from '../../shared/remote/syncTarget';
import { type InboxEntry, RemoteApiError, RemoteBridge } from './remoteBridge';
import { RemoteStore } from './remoteStore';

const owner: RemoteOwner = { userId: '10001', scopeKey: 'personal' };
const dispose: Array<() => void> = [];
function fixture(managed = true, identified = false) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db);
  let currentOwner: RemoteOwner | null = owner;
  let connectionState: string = RemoteDeviceConnectionState.Allowed;
  let connectionVersion = '1';
  const syncTarget = identified ? { version: RemoteSyncTarget.Version, dataSpaceId: 'space', dataGeneration: '1' } : undefined;
  const currentDevice = () => ({ deviceId: 'desktop', name: 'Desktop', connectionVersion, connectionState,
    admissionState: connectionState === RemoteDeviceConnectionState.Removed ? RemoteDeviceAdmissionState.Removed : RemoteDeviceAdmissionState.QuotaBlocked,
    slotOccupied: false });
  const request = vi.fn(async (_owner: RemoteOwner, path: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    let data: unknown;
    if (path.endsWith('/capabilities')) data = { enabled: true, protocolVersions: [1],
      capabilities: [RemoteCapability.SameAccountAccess, ...(managed ? [REMOTE_CONNECTION_MANAGEMENT_CAPABILITY] : [])],
      syncTarget, deviceConnectionPolicy: managed ? { version: 2 } : undefined };
    else if (path.endsWith('/devices/register')) data = { deviceId: 'desktop', ...owner, metadataVersion: '1', syncTarget };
    else if (path.endsWith('/device-connections')) data = { observedAt: new Date().toISOString(), presenceAvailable: true,
      quota: { onlineSlotsUsed: 5, maxOnlineDesktops: 5, scope: 'account_scope' }, currentDevice: currentDevice(), connections: [] };
    else if (path.endsWith('/connection/resume') || path.endsWith('/connection/remove')) {
      const target = path.split('/')[5];
      if (target === 'desktop') { connectionState = path.endsWith('/resume') ? RemoteDeviceConnectionState.Allowed : RemoteDeviceConnectionState.Removed;
        connectionVersion = String(BigInt(connectionVersion) + 1n); }
      data = { requestId: body.requestId, deviceId: target, connectionState, connectionVersion,
        releaseState: RemoteConnectionReleaseState.Released, nextAction: 'connect' };
    } else if (path.endsWith('/settings')) data = { settingsVersion: '1' };
    else if (path.endsWith('/connection-tickets')) throw new RemoteApiError(47022, 'Online desktop limit reached');
    else if (path.endsWith('/reconcile')) data = { command: { status: 'unknown', statusVersion: '4' } };
    else throw new Error(`Unexpected request: ${path}`);
    return new Response(JSON.stringify({ code: 0, data }));
  });
  const execute = vi.fn();
  const deps = { store, identity: { installationId: 'installation', deviceKey: 'private-key', databaseId: 'database' },
    runSessionTransaction: <T>(action: () => T) => store.transaction(action),
    getOwner: () => currentOwner, getEnvironment: () => RemoteEnvironment.Test, getApiBaseUrl: () => 'https://example.com', request,
    metadata: { name: 'Desktop', hostName: 'desktop.local', platform: 'macos', appVersion: '1', instanceLabel: 'default' },
    prepare: vi.fn(), execute, onAccountChange: vi.fn() };
  const bridge: any = new RemoteBridge(deps);
  vi.spyOn(bridge, 'schedule').mockImplementation(() => undefined);
  bridge.accountChanged();
  dispose.push(() => { bridge.stop(); db.close(); });
  return { bridge, store, deps, request, execute,
    removeAtServer() { connectionState = RemoteDeviceConnectionState.Removed; connectionVersion = '2'; },
    switchAccount(next: RemoteOwner | null) { currentOwner = next; bridge.accountChanged(); } };
}
afterEach(() => { for (const clean of dispose.splice(0).reverse()) clean(); vi.unstubAllGlobals(); });

describe('device connection management bridge', () => {
  it('discovers v2 and lists other connections with the local switch off, without opening a socket', async () => {
    const { bridge, store, request } = fixture();
    store.put('settings:10001:personal', { enabled: false, name: 'Desktop', workspaces: [], settingsVersion: '1' });
    const result = await bridge.queryConnections();
    expect(result.supported).toBe(true);
    expect(request.mock.calls.map(([, path]) => path)).toEqual([
      '/api/remote/v1/capabilities', '/api/remote/v2/devices/register', '/api/remote/v2/device-connections',
    ]);
    expect(request.mock.calls[2][2].headers).toMatchObject({ 'X-Remote-Device-Credential': 'desktop.private-key' });
    expect(bridge.state()).toMatchObject({ enabled: false, connected: false, deviceConnectionManagementSupported: true });
    expect(JSON.stringify(result)).not.toContain('private-key');
  });

  it('uses v1 registration and an explicit unsupported result against old servers', async () => {
    const { bridge, request } = fixture(false);
    expect(await bridge.queryConnections()).toMatchObject({ supported: false, presenceAvailable: false, quota: { onlineSlotsUsed: null } });
    expect(request.mock.calls.map(([, path]) => path)).toEqual(['/api/remote/v1/capabilities', '/api/remote/v1/devices/register']);
  });

  it('keeps GET and explicit resume usable when new connection management admission is disabled', async () => {
    const { bridge, request, removeAtServer } = fixture(false);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (actor, path, init) => path.endsWith('/capabilities')
      ? new Response(JSON.stringify({ code: 0, data: { enabled: true, protocolVersions: [1], capabilities: [RemoteCapability.SameAccountAccess],
        deviceConnectionPolicy: { version: 2, enabled: false, clusterReady: true } } }))
      : original(actor, path, init));
    removeAtServer(); await bridge.queryConnections();
    expect(bridge.state()).toMatchObject({ deviceConnectionManagementSupported: true, deviceConnectionManagementEnabled: false,
      deviceConnectionManagementClusterReady: true, connectionReason: RemoteConnectionReason.Removed });
    expect(request.mock.calls.some(([, path]) => path === '/api/remote/v1/devices/register')).toBe(true);
    await bridge.resumeCurrentConnection({ requestId: 'resume-disabled', expectedConnectionVersion: '2' });
    expect(bridge.connectionRemoved).toBe(false);
  });

  it('leaves the local preference enabled at quota and never calls business synchronization or command claiming', async () => {
    const { bridge, request } = fixture();
    const sync = vi.spyOn(bridge, 'syncSessions');
    const claim = vi.spyOn(bridge, 'claim');
    await bridge.tick();
    expect(bridge.state()).toMatchObject({ enabled: true, connected: false, connectionReason: RemoteConnectionReason.QuotaBlocked });
    expect(sync).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([, path]) => path.endsWith('/connection-tickets'))).toBe(true);
    request.mockClear(); await bridge.tick();
    expect(request).not.toHaveBeenCalled();
  });

  it('persists removal across restart, prevents automatic ticket requests and resumes only through the explicit action', async () => {
    const { bridge, request, deps, removeAtServer } = fixture();
    removeAtServer(); await bridge.queryConnections();
    expect(bridge.state()).toMatchObject({ enabled: true, connectionReason: RemoteConnectionReason.Removed });
    const restarted: any = new RemoteBridge(deps);
    vi.spyOn(restarted, 'schedule').mockImplementation(() => undefined);
    try {
      restarted.accountChanged(); request.mockClear(); await restarted.tick();
      expect(restarted.state().connectionReason).toBe(RemoteConnectionReason.Removed);
      expect(request.mock.calls.some(([, path]) => path.endsWith('/connection-tickets'))).toBe(false);
      await restarted.configure({ retry: true }); await restarted.tick();
      expect(request.mock.calls.some(([, path]) => path.endsWith('/connection/resume'))).toBe(false);
      const result = await restarted.resumeCurrentConnection({ requestId: 'resume-1', expectedConnectionVersion: '2' });
      expect(result.connectionState).toBe(RemoteDeviceConnectionState.Allowed);
      expect(restarted.connectionRemoved).toBe(false);
      expect(request.mock.calls.some(([, path]) => path === '/api/remote/v2/devices/desktop/connection/resume')).toBe(true);
      expect(restarted.state().connected).toBe(false);
    } finally { restarted.stop(); }
  });

  it('keeps the removal version from a rejected write so a delayed allowed snapshot cannot re-enable it', async () => {
    const { bridge, request } = fixture(); await bridge.queryConnections();
    bridge.quotaBlocked = false;
    request.mockRejectedValueOnce(new RemoteApiError(47121, 'Removed', { connectionVersion: '2' }));
    await expect(bridge.api('/connection-tickets', 'POST', {})).rejects.toThrow('Removed');
    bridge.observeConnection({ deviceId: 'desktop', connectionVersion: '1', connectionState: RemoteDeviceConnectionState.Allowed });
    expect(bridge.connectionRemoved).toBe(true); expect(bridge.connectionVersion).toBe('2');
    bridge.observeConnection({ deviceId: 'desktop', connectionVersion: '2', connectionState: RemoteDeviceConnectionState.Allowed });
    expect(bridge.connectionRemoved).toBe(true);
  });

  it('rejects stale list data after switching accounts and clears the previous removal state', async () => {
    const { bridge, request, removeAtServer, switchAccount } = fixture();
    removeAtServer(); await bridge.queryConnections();
    const original = request.getMockImplementation()!;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    request.mockImplementation(async (actor, path, init) => {
      const response = await original(actor, path, init);
      if (path.endsWith('/device-connections')) await blocked;
      return response;
    });
    const pending = bridge.queryConnections();
    await vi.waitFor(() => expect(request.mock.calls.filter(([, path]) => path.endsWith('/device-connections')).length).toBe(2));
    switchAccount({ userId: '20002', scopeKey: 'personal' }); release();
    await expect(pending).rejects.toThrow('Account changed');
    expect(bridge.state()).toMatchObject({ owner: { userId: '20002' }, name: 'desktop.local', error: undefined });
    expect(bridge.connectionRemoved).toBe(false);
  });

  it('uses only bounded existing-claim receipts while removed, never granting execution permission', async () => {
    const { bridge, store, request, execute, removeAtServer } = fixture();
    removeAtServer(); await bridge.queryConnections(); request.mockClear();
    for (let i = 0; i < 25; i++) store.put(`inbox:${String(i).padStart(2, '0')}`, { owner, targetId: bridge.getSyncTargetId(), command: { commandId: `c${i}`, claimId: 'claim', claimToken: 'claim-token', statusVersion: '2', status: 'received' },
      localSessionId: 'local', remoteSessionId: 'remote', runId: 'run', state: 'unknown', result: null } as InboxEntry);
    await bridge.reconcilePaused();
    expect(request).toHaveBeenCalledTimes(20);
    for (const [, path, init] of request.mock.calls) {
      expect(path).toMatch(/\/commands\/c\d+\/reconcile$/u);
      expect(JSON.parse(String(init.body))).toMatchObject({ mode: 'recovery', requestExecutionPermit: false, claimId: 'claim' });
    }
    expect(execute).not.toHaveBeenCalled();
    request.mockClear(); await bridge.reconcilePaused(); expect(request).toHaveBeenCalledTimes(5);
  });

  it('refreshes a stale receipt version from a scoped conflict without requesting an execution permit', async () => {
    const { bridge, store, request, removeAtServer } = fixture();
    removeAtServer(); await bridge.queryConnections();
    store.put('inbox:receipt', { owner, targetId: bridge.getSyncTargetId(), command: { commandId: 'receipt', claimId: 'claim', claimToken: 'claim-token', statusVersion: '2', status: 'received' },
      localSessionId: 'local', remoteSessionId: 'remote', runId: 'run', state: 'unknown', result: null } as InboxEntry);
    request.mockRejectedValueOnce(new RemoteApiError(47024, 'Conflict', { currentCommand: {
      commandId: 'receipt', sessionId: 'remote', runId: 'run', status: 'reconciling', statusVersion: '3' } }));
    await bridge.reconcilePaused();
    expect(store.get<InboxEntry>('inbox:receipt')?.command.statusVersion).toBe('3');
    request.mockClear(); await bridge.reconcilePaused();
    expect(JSON.parse(String(request.mock.calls[0][2].body))).toMatchObject({ expectedStatusVersion: '3', requestExecutionPermit: false });
  });

  it('does not disconnect a healthy socket when management listing is temporarily unavailable', async () => {
    const { bridge, request } = fixture();
    await bridge.queryConnections(); bridge.generation = '1'; bridge.quotaBlocked = false;
    request.mockRejectedValueOnce(new Error('offline'));
    await expect(bridge.queryConnections()).rejects.toThrow('offline');
    expect(bridge.generation).toBe('1');
  });

  it('blocks a dispatch if removal arrives while its received ACK is in flight', async () => {
    const { bridge, request, execute } = fixture();
    await bridge.queryConnections(); bridge.generation = '1'; bridge.quotaBlocked = false;
    const entry = { owner, targetId: bridge.getSyncTargetId(), command: { commandId: 'command', claimId: 'claim', claimToken: 'token', claimUntil: new Date(Date.now() + 20000).toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(), statusVersion: '2', status: 'claimed' },
      localSessionId: 'local', remoteSessionId: 'remote', runId: 'run', state: 'prepared', result: null } as InboxEntry;
    request.mockImplementationOnce(async () => {
      bridge.observeConnection({ deviceId: 'desktop', connectionVersion: '2', connectionState: RemoteDeviceConnectionState.Removed });
      return new Response(JSON.stringify({ code: 0, data: { status: 'received', statusVersion: '3' } }));
    });
    await bridge.applyEntry(entry, '1'); expect(execute).not.toHaveBeenCalled();
  });
});


it('requires explicit retirement recovery, uses the persisted replacement and preserves local preferences', async () => {
  const f = fixture(); await f.bridge.queryConnections();
  const original = { ...f.deps.identity };
  let identity = original;
  const replace = vi.fn(() => { identity = { ...original, installationId: 'replacement-install', deviceKey: 'replacement-key', registrationScope: 'replacement-install' } as typeof original; return identity; });
  f.bridge.deps.registrationIdentities = { get: () => identity, replace };
  await expect(f.bridge.configure({ reregister: true })).rejects.toThrow('unavailable');
  expect(replace).not.toHaveBeenCalled();
  f.bridge.recordConnectionFailure(new RemoteApiError(47023, 'retired'));
  await f.bridge.configure({ retry: true });
  expect(replace).not.toHaveBeenCalled();
  const previousTarget = f.bridge.targetId;
  f.store.put(`settings:${previousTarget}:10001:personal`, { name: 'My computer', enabled: true,
    workspaces: [{ workspaceId: 'work', name: 'Work', path: '/private/tmp', available: true }], settingsVersion: '9' });
  f.bridge.recordConnectionFailure(new RemoteApiError(47023, 'retired'));
  const originalRequest = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (actor, path, init) => path.endsWith('/devices/register')
    ? new Response(JSON.stringify({ code: 0, data: { deviceId: 'replacement', ...owner, metadataVersion: '1' } }))
    : originalRequest(actor, path, init));
  await f.bridge.configure({ reregister: true });
  await expect(f.bridge.configure({ reregister: true })).rejects.toThrow('unavailable');
  await f.bridge.ensureRegistration();
  expect(replace).toHaveBeenCalledTimes(1);
  expect(f.deps.identity).toEqual(original);
  expect(f.bridge.state()).toMatchObject({ deviceId: 'replacement', name: 'My computer', enabled: true,
    workspaces: [{ workspaceId: 'work', name: 'Work', available: true }] });
  const registration = f.request.mock.calls.filter(([, path]) => path.endsWith('/devices/register')).at(-1)!;
  expect(JSON.parse(String(registration[2].body))).toMatchObject({ installationId: 'replacement-install', deviceKey: 'replacement-key' });
  expect(f.bridge.targetId).not.toBe(previousTarget);
  expect(f.bridge.isEntryCurrent({ targetId: previousTarget, owner, command: { commandId: 'old' } })).toBe(false);
  f.request.mockClear(); await f.bridge.api('/settings', 'GET');
  expect(f.request.mock.calls[0][2].headers).toMatchObject({ 'X-Remote-Device-Credential': 'replacement.replacement-key' });
});


it('does not mark this desktop retired when removing another retired desktop fails', async () => {
  const f = fixture(); await f.bridge.queryConnections();
  f.request.mockRejectedValueOnce(new RemoteApiError(47023, 'other desktop retired'));
  await expect(f.bridge.api('/devices/other/connection/remove', 'POST', {}, true, 2)).rejects.toThrow('other desktop retired');
  expect(f.bridge.state().errorCode).not.toBe(47023);
});

it('recognizes retirement during management reads with the local connection disabled', async () => {
  const f = fixture(); await f.bridge.queryConnections();
  await f.bridge.configure({ enabled: false });
  f.request.mockRejectedValueOnce(new RemoteApiError(47023, 'retired'));
  await expect(f.bridge.queryConnections()).rejects.toThrow('retired');
  expect(f.bridge.state()).toMatchObject({ enabled: false, errorCode: 47023 });
});


it('reuses recovery credentials across restart and service aliases after a lost registration response', async () => {
  const f = fixture(true, true); await f.bridge.queryConnections();
  const identities = new Map<string, typeof f.deps.identity>();
  const get = vi.fn((_actor: RemoteOwner, scope: string) => identities.get(scope) ?? f.deps.identity);
  const replace = vi.fn((_actor: RemoteOwner, scope: string) => {
    const value = { ...f.deps.identity, installationId: 'new-install', deviceKey: 'new-key', registrationScope: 'new-install' };
    identities.set(scope, value); return value;
  });
  f.bridge.deps.registrationIdentities = { get, replace };
  f.bridge.recordConnectionFailure(new RemoteApiError(47023, 'retired'));
  await f.bridge.configure({ reregister: true });
  const request = f.request.getMockImplementation()!;
  let loseResponse = true;
  f.request.mockImplementation(async (actor, path, init) => {
    if (!path.endsWith('/devices/register')) return request(actor, path, init);
    if (loseResponse) { loseResponse = false; throw new Error('Response lost'); }
    return new Response(JSON.stringify({ code: 0, data: { deviceId: 'new-desktop', ...owner, metadataVersion: '1',
      syncTarget: { version: RemoteSyncTarget.Version, dataSpaceId: 'space', dataGeneration: '1' } } }));
  });
  await expect(f.bridge.ensureRegistration()).rejects.toThrow('Response lost');
  const restarted: any = new RemoteBridge(f.bridge.deps);
  vi.spyOn(restarted, 'schedule').mockImplementation(() => undefined);
  try {
    restarted.accountChanged(); await restarted.ensureRegistration();
    expect(restarted.state().deviceId).toBe('new-desktop');
    const target = restarted.targetId;
    f.deps.getApiBaseUrl = () => 'https://alias.example.com';
    restarted.accountChanged(); await restarted.ensureRegistration();
    expect(restarted.targetId).toBe(target);
    expect(replace).toHaveBeenCalledTimes(1);
    const requests = f.request.mock.calls.filter(([, path]) => path.endsWith('/devices/register')).slice(1);
    expect(requests).toHaveLength(3);
    for (const [, , init] of requests) expect(JSON.parse(String(init.body))).toMatchObject({ installationId: 'new-install', deviceKey: 'new-key' });
  } finally { restarted.stop(); }
});


it('retains settings when the old registration is rejected before the target is restored on restart', async () => {
  const f = fixture(); await f.bridge.queryConnections();
  const settings = { enabled: false, name: 'Saved before restart', workspaces: [
    { workspaceId: 'work', name: 'Workspace', path: '/private/tmp', available: true }], settingsVersion: '8' };
  f.store.put(`settings:${f.bridge.targetId}:10001:personal`, settings);
  let identity = f.deps.identity;
  f.bridge.deps.registrationIdentities = { get: () => identity, replace: () => {
    identity = { ...identity, installationId: 'new-install', deviceKey: 'new-key', registrationScope: 'new-install' } as typeof identity;
    return identity;
  } };
  const request = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (actor, path, init) => {
    if (!path.endsWith('/devices/register')) return request(actor, path, init);
    if (identity.installationId === 'installation') throw new RemoteApiError(47023, 'retired');
    return new Response(JSON.stringify({ code: 0, data: { deviceId: 'new-desktop', ...owner, metadataVersion: '1' } }));
  });
  const restarted: any = new RemoteBridge(f.bridge.deps);
  vi.spyOn(restarted, 'schedule').mockImplementation(() => undefined);
  try {
    restarted.accountChanged(); await expect(restarted.queryConnections()).rejects.toThrow('retired');
    expect(restarted.targetId).toBeNull();
    await restarted.configure({ reregister: true }); await restarted.ensureRegistration();
    expect(restarted.state()).toMatchObject({ name: settings.name, enabled: false, workspaces: [{ workspaceId: 'work' }] });
  } finally { restarted.stop(); }
});
