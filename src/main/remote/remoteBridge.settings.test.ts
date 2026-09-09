import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { REMOTE_PROTOCOL_VERSION, RemoteCapability, RemoteConnectionReason, RemoteConnectionStatus, RemoteSyncStatus } from '../../shared/remote/constants';
import { RemoteApiError, RemoteBridge } from './remoteBridge';
import { RemoteStore } from './remoteStore';

const disposables: Array<() => void> = [];
const firstOwner = { userId: '10001', scopeKey: 'personal' };
function fixture(registered = true) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db);
  let owner: typeof firstOwner | null = firstOwner;
  let supportsAutomaticAccess = true;
  let settingsVersion = 1;
  let metadataVersion = 1;
  const changed = vi.fn();
  const accountChanged = vi.fn();
  const request = vi.fn(async (_owner, pathname, init) => {
    let data: unknown;
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (pathname.endsWith('/capabilities')) data = { enabled: true, protocolVersions: [REMOTE_PROTOCOL_VERSION], capabilities: supportsAutomaticAccess ? [RemoteCapability.SameAccountAccess] : [] };
    else if (pathname.endsWith('/devices/register')) data = { deviceId: 'desktop', ...owner, metadataVersion: String(metadataVersion) };
    else if (pathname.endsWith('/settings')) data = { settingsVersion: String(init.method === 'PATCH' ? ++settingsVersion : settingsVersion) };
    else if (pathname.endsWith('/metadata')) {
      if (body.expectedMetadataVersion !== String(metadataVersion)) return new Response(JSON.stringify({ code: 47020, message: 'conflict', data: { currentMetadataVersion: String(metadataVersion) } }), { status: 409 });
      data = { metadataVersion: String(++metadataVersion) };
    } else if (pathname.endsWith('/connection-tickets')) data = { wsUrl: 'wss://example.com/api/remote/v1/ws?ticket=test' };
    else if (pathname.includes('/commands?')) data = { items: [], nextCursor: null };
    else if (pathname.endsWith('/commands/claim')) data = { items: [] };
    else throw new Error(`Unexpected request ${pathname}`);
    return new Response(JSON.stringify({ code: 0, data }));
  });
  const deps = { store, identity: { installationId: 'instance', deviceKey: 'key', databaseId: 'db' },
    getOwner: () => owner, getApiBaseUrl: () => 'https://example.com', request,
    metadata: { name: 'host.local', hostName: 'host.local', instanceLabel: 'default', platform: 'macos', appVersion: '1' },
    getDefaultWorkspace: undefined as undefined | (() => { path: string; name: string; available?: boolean }),
    onStateChange: changed, onAccountChange: accountChanged, prepare: vi.fn(), execute: vi.fn(),
  };
  const bridge: any = new RemoteBridge(deps);
  bridge.owner = owner;
  if (registered) { bridge.registration = { deviceId: 'desktop', ...owner, metadataVersion: '1' }; bridge.sameAccountAccess = true; }
  vi.spyOn(bridge, 'schedule').mockImplementation(() => undefined);
  disposables.push(() => { bridge.stop(); db.close(); });
  return { bridge, store, request, deps, changed, accountChanged,
    switchOwner: (next: typeof owner) => { owner = next; bridge.accountChanged(); },
    legacyServer: () => { supportsAutomaticAccess = false; }, metadataConflict: () => { metadataVersion = 4; },
  };
}
const settingsPatches = (request: ReturnType<typeof vi.fn>) => request.mock.calls
  .filter(([, pathname, init]) => pathname.endsWith('/settings') && init.method === 'PATCH')
  .map(([, , init]) => JSON.parse(String(init.body)));
afterEach(() => { for (const dispose of disposables.splice(0).reverse()) dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('remote settings persistence', () => {
  it('defaults to enabled without overriding an explicit disabled preference', () => {
    const { bridge, store, switchOwner } = fixture();
    expect(bridge.state()).toMatchObject({ enabled: true, name: 'host.local' });
    store.put('settings:10001:personal', { enabled: false, name: 'Custom', workspaces: [], settingsVersion: '1' });
    expect(bridge.state()).toMatchObject({ enabled: false, name: 'Custom' });
    switchOwner(null);
    expect(bridge.state()).toMatchObject({ enabled: false, owner: null, connectionReason: RemoteConnectionReason.SignedOut, name: 'host.local' });
    switchOwner(firstOwner);
    expect(bridge.state()).toMatchObject({ enabled: false, name: 'Custom' });
  });
  it('stays disabled without login and only enables the default after an account is available', async () => {
    const { bridge, store, switchOwner, request } = fixture();
    switchOwner(null);
    await expect(bridge.configure({ enabled: true })).rejects.toThrow('Sign in');
    await bridge.tick();
    expect(bridge.state()).toMatchObject({ enabled: false, connected: false, owner: null });
    expect(store.get('settings:undefined:undefined')).toBeNull();
    expect(request).not.toHaveBeenCalled();
    switchOwner(firstOwner);
    expect(bridge.state()).toMatchObject({ enabled: true, owner: firstOwner });
  });
  it('saves while offline and replays disable before a subsequent enable after restart', async () => {
    const { bridge, store, request, deps } = fixture();
    request.mockRejectedValueOnce(new Error('offline'));
    await expect(bridge.configure({ enabled: false })).resolves.toMatchObject({ enabled: false, settingsSyncStatus: RemoteSyncStatus.Pending });
    await expect(bridge.configure({ enabled: true })).resolves.toMatchObject({ enabled: true, settingsSyncStatus: RemoteSyncStatus.Pending });
    expect(request).not.toHaveBeenCalled();
    await expect(bridge.writeSettings()).rejects.toThrow('offline');
    const restarted: any = new RemoteBridge(deps);
    restarted.owner = firstOwner; restarted.registration = { deviceId: 'desktop', ...firstOwner, metadataVersion: '1' }; restarted.sameAccountAccess = true;
    vi.spyOn(restarted, 'schedule').mockImplementation(() => undefined);
    try {
      await restarted.writeSettings();
      expect(settingsPatches(request).map(body => body.remoteEnabled)).toEqual([false, true]);
      expect(store.get('controlQueue:10001:personal')).toEqual([]);
      expect(restarted.state().settingsSyncStatus).toBe(RemoteSyncStatus.Synced);
    } finally { restarted.stop(); }
  });
  it('flushes a saved disable even while the local feature is off', async () => {
    const { bridge, request } = fixture();
    await bridge.configure({ enabled: false });
    await bridge.tick();
    expect(settingsPatches(request).map(body => body.remoteEnabled)).toEqual([false]);
    expect(bridge.state()).toMatchObject({ enabled: false, connected: false, settingsSyncStatus: RemoteSyncStatus.Synced });
    expect(request.mock.calls.some(([, pathname]) => pathname.endsWith('/connection-tickets'))).toBe(false);
  });
  it('renames with metadata-only CAS and retries against the current version', async () => {
    const { bridge, request, metadataConflict } = fixture(); metadataConflict();
    await bridge.configure({ name: '  Work computer  ' });
    expect(bridge.state()).toMatchObject({ name: 'Work computer', nameSyncStatus: RemoteSyncStatus.Pending });
    await bridge.writeSettings();
    expect(settingsPatches(request)).toHaveLength(0);
    const updates = request.mock.calls.map(([, , init]) => JSON.parse(String(init.body)));
    expect(updates).toEqual([{ name: 'Work computer', expectedMetadataVersion: '1' }, { name: 'Work computer', expectedMetadataVersion: '4' }]);
    expect(bridge.state().nameSyncStatus).toBe(RemoteSyncStatus.Synced);
  });
  it('rejects invalid names without changing the saved name', async () => {
    const { bridge } = fixture();
    for (const name of ['', '  ', 'x'.repeat(101), 'unsafe\nname', 'valid\n', '\tvalid', 'invalid\u0085name']) await expect(bridge.configure({ name })).rejects.toThrow('Invalid device name');
    expect(bridge.state().name).toBe('host.local');
  });
  it('does not lose a control change received while a synchronization tick is running', async () => {
    const { bridge } = fixture();
    bridge.schedule.mockRestore(); bridge.running = true;
    await bridge.configure({ enabled: false });
    expect(bridge.tickRequested).toBe(true);
    expect(bridge.timer).toBeNull();
    bridge.running = false;
    const schedule = vi.spyOn(bridge, 'schedule').mockImplementation(() => undefined);
    await bridge.tick();
    expect(schedule).toHaveBeenLastCalledWith(0);
    expect(bridge.tickRequested).toBe(false);
  });
  it('does not spin its retry loop while signed out', async () => {
    const { bridge, switchOwner } = fixture(); switchOwner(null);
    bridge.schedule.mockClear(); await bridge.tick();
    expect(bridge.schedule).toHaveBeenCalledTimes(1);
    expect(bridge.schedule.mock.calls[0][0]).toBeGreaterThanOrEqual(5000);
  });
  it('isolates account settings and immediately clears stale status and pending requests', async () => {
    const { bridge, switchOwner, accountChanged, changed } = fixture();
    await bridge.configure({ name: 'Private computer', enabled: false });
    bridge.error = 'previous error'; bridge.errorCode = 47013; bridge.accesses = [{ requestId: 'private' }];
    switchOwner({ userId: '20002', scopeKey: 'team:20' });
    expect(bridge.state()).toMatchObject({ name: 'host.local', enabled: true, connected: false, error: undefined, errorCode: undefined, accessRequests: [], settingsSyncStatus: RemoteSyncStatus.Synced });
    expect(accountChanged).toHaveBeenCalledWith(firstOwner, { userId: '20002', scopeKey: 'team:20' });
    expect(changed).toHaveBeenCalled();
    switchOwner(firstOwner);
    expect(bridge.state()).toMatchObject({ name: 'Private computer', enabled: false, settingsSyncStatus: RemoteSyncStatus.Pending });
  });
});

describe('rollout and automatic workspace', () => {
  it('probes support before registering automatic access', async () => {
    const { bridge, request } = fixture(false);
    await bridge.ensureRegistration();
    const paths = request.mock.calls.map(([, pathname]) => pathname);
    expect(paths[0]).toBe('/api/remote/v1/capabilities');
    const registration = request.mock.calls.find(([, pathname]) => pathname.endsWith('/devices/register'))!;
    expect(JSON.parse(registration[2].body).capabilities).toContain(RemoteCapability.SameAccountAccess);
  });
  it('shows upgrade-required and never claims automatic access against an old server', async () => {
    const { bridge, request, legacyServer } = fixture(false); legacyServer();
    await bridge.tick();
    expect(bridge.state()).toMatchObject({ connected: false, connectionReason: RemoteConnectionReason.ServerUpgradeRequired, errorCode: 47000 });
    expect(request.mock.calls).toHaveLength(1);
    expect(bridge.suspended).toBe(false);
  });
  it('can still revoke old grants with a persisted disable on a legacy server', async () => {
    const { bridge, request, legacyServer } = fixture(false); legacyServer();
    await bridge.configure({ enabled: false }); await bridge.tick();
    expect(settingsPatches(request)).toHaveLength(1);
    expect(settingsPatches(request)[0]).toMatchObject({ remoteEnabled: false });
    for (const [, , init] of request.mock.calls) if (init.body) expect(JSON.parse(String(init.body)).capabilities || []).not.toContain(RemoteCapability.SameAccountAccess);
  });
  it('keeps old workspace IDs and paths while publishing the current default first', async () => {
    const { bridge, store, deps } = fixture();
    const one = mkdtempSync(join(tmpdir(), 'remote-workspace-a-')); const two = mkdtempSync(join(tmpdir(), 'remote-workspace-b-'));
    disposables.push(() => { rmSync(one, { recursive: true }); rmSync(two, { recursive: true }); });
    deps.getDefaultWorkspace = () => ({ path: one, name: 'One' });
    await bridge.ensureDefaultWorkspace();
    const original = store.get<any>('settings:10001:personal').workspaces[0];
    deps.getDefaultWorkspace = () => ({ path: two, name: 'Two' }); await bridge.ensureDefaultWorkspace();
    const changed = store.get<any>('settings:10001:personal').workspaces;
    expect(changed[0]).toMatchObject({ path: two, name: 'Two', available: true });
    expect(changed[1]).toEqual(original);
    deps.getDefaultWorkspace = () => ({ path: one, name: 'One renamed' }); await bridge.ensureDefaultWorkspace();
    const returned = store.get<any>('settings:10001:personal').workspaces;
    expect(returned).toHaveLength(2); expect(returned[0].workspaceId).toBe(original.workspaceId);
  });
  it('disables only new-session capability when a new default cannot fit without deleting old mappings', async () => {
    const { bridge, store, request, deps } = fixture();
    const workspaces = Array.from({ length: 50 }, (_, index) => ({ workspaceId: `old-${index}`, path: `/old-${index}`, name: `Old ${index}`, available: true }));
    store.put('settings:10001:personal', { enabled: true, name: 'host', workspaces, settingsVersion: '1' });
    deps.getDefaultWorkspace = () => ({ path: '/new', name: 'New' });
    await bridge.ensureDefaultWorkspace(); await bridge.writeSettings();
    expect(store.get<any>('settings:10001:personal').workspaces).toEqual(workspaces);
    const advertised = settingsPatches(request)[0].capabilities;
    expect(advertised).not.toContain(RemoteCapability.CreateSession);
    expect(advertised).toContain('session.read'); expect(advertised).toContain('session.continue');
    expect(bridge.state().connectionReason).toBe(RemoteConnectionReason.WorkspaceUnavailable);
  });
  it('keeps usable historical mappings when the current default directory is unavailable', async () => {
    const { bridge, store, deps } = fixture();
    const old = mkdtempSync(join(tmpdir(), 'remote-workspace-old-'));
    disposables.push(() => rmSync(old, { recursive: true }));
    store.put('settings:10001:personal', { enabled: true, name: 'host', workspaces: [{ workspaceId: 'old', path: old, name: 'Old', available: true }], settingsVersion: '1' });
    deps.getDefaultWorkspace = () => ({ path: join(old, 'unavailable'), name: 'Unavailable', available: false });
    await bridge.ensureDefaultWorkspace();
    expect(bridge.state().workspaces[0]).toMatchObject({ name: 'Unavailable', available: false });
    expect(bridge.state().workspaces[1]).toEqual({ workspaceId: 'old', name: 'Old', available: true });
    expect(bridge.state().connectionReason).toBe(RemoteConnectionReason.WorkspaceUnavailable);
    expect(store.get<any>('settings:10001:personal').workspaces[1].path).toBe(old);
  });
});

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
  constructor(_url: string) { super(); FakeSocket.instances.push(this); }
  frame(data: unknown): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
}
describe('truthful remote connection state', () => {
  it('keeps a failed ticket request visible while recovering existing work over HTTPS', async () => {
    const { bridge, request } = fixture();
    request.mockRejectedValueOnce(new RemoteApiError(47022, 'Online desktop limit reached'));
    await bridge.tick();
    expect(bridge.state()).toMatchObject({ connected: false, connectionReason: RemoteConnectionReason.ServerUnavailable, errorCode: 47022 });
    expect(request.mock.calls.some(([, pathname]) => pathname.includes('/commands?'))).toBe(true);
    bridge.disconnect();
    expect(bridge.state()).toMatchObject({ connectionReason: RemoteConnectionReason.ServerUnavailable, errorCode: 47022 });
  });
  it('retains socket errors through cleanup and automatic retries until hello succeeds', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const { bridge } = fixture(); await bridge.connect();
    const failed = FakeSocket.instances.at(-1)!;
    failed.dispatchEvent(new Event('error'));
    expect(bridge.state()).toMatchObject({ connected: false, connectionReason: RemoteConnectionReason.ServerUnavailable, errorCode: 1006 });
    expect(failed.close).toHaveBeenCalledTimes(1);
    failed.dispatchEvent(Object.assign(new Event('close'), { code: 1000 }));
    await bridge.connect();
    expect(bridge.state()).toMatchObject({ connectionReason: RemoteConnectionReason.ServerUnavailable, errorCode: 1006 });
    FakeSocket.instances.at(-1)!.frame({ type: 'hello', protocolVersion: REMOTE_PROTOCOL_VERSION, connectionGeneration: '2' });
    expect(bridge.state()).toMatchObject({ connected: true, error: undefined, errorCode: undefined });
  });
  it('reports a handshake timeout as a failure instead of an endless reconnecting state', async () => {
    vi.useFakeTimers(); vi.stubGlobal('WebSocket', FakeSocket);
    const { bridge } = fixture(); await bridge.connect();
    vi.advanceTimersByTime(15000);
    expect(bridge.state()).toMatchObject({ connected: false, connectionReason: RemoteConnectionReason.ServerUnavailable, errorCode: 1006 });
    expect(bridge.state().error).toContain('handshake timed out');
    expect(bridge.socket).toBeNull(); expect(bridge.handshake).toBeNull();
  });
  it('suspends invalid credentials without discarding durable work or retrying on an ordinary save', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const { bridge, store, request, deps } = fixture(); await bridge.connect();
    const socket = FakeSocket.instances.at(-1)!;
    socket.frame({ type: 'hello', protocolVersion: REMOTE_PROTOCOL_VERSION, connectionGeneration: '1' });
    store.put('inbox:retained', { state: 'unknown', owner: firstOwner });
    await bridge.configure({ name: 'Renamed' });
    request.mockResolvedValueOnce(new Response(JSON.stringify({ code: 47013, message: 'Device credential is invalid', data: { reason: 'DEVICE_CREDENTIAL_INVALID' } }), { status: 403 }));
    await bridge.tick();
    expect(bridge.state()).toMatchObject({ connected: false, connectionReason: RemoteConnectionReason.DeviceUnavailable, errorCode: 47013 });
    expect(socket.close).toHaveBeenCalled(); expect(bridge.suspended).toBe(true);
    const count = request.mock.calls.length;
    await bridge.configure({ name: 'Another name', enabled: true }); await bridge.tick();
    expect(request).toHaveBeenCalledTimes(count);
    expect(bridge.state().errorCode).toBe(47013);
    expect(store.get('inbox:retained')).toEqual({ state: 'unknown', owner: firstOwner });
    expect(deps.identity.deviceKey).toBe('key'); expect(bridge.registration.deviceId).toBe('desktop');
    await bridge.configure({ retry: true });
    expect(bridge.suspended).toBe(false);
    expect(bridge.state()).toMatchObject({ connected: false, connectionReason: RemoteConnectionReason.Reconnecting, error: undefined, errorCode: undefined });
  });
  it('manual retry replaces the old socket and ignores its late frames', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const { bridge, request } = fixture(); await bridge.connect();
    const old = FakeSocket.instances.at(-1)!;
    old.frame({ type: 'hello', protocolVersion: REMOTE_PROTOCOL_VERSION, connectionGeneration: '1' });
    const state = await bridge.configure({ retry: true });
    expect(state).toMatchObject({ connected: false, connectionReason: RemoteConnectionReason.Reconnecting });
    expect(old.close).toHaveBeenCalledTimes(1);
    await bridge.tick();
    expect(request.mock.calls.filter(([, pathname]) => pathname.endsWith('/connection-tickets'))).toHaveLength(2);
    const replacement = FakeSocket.instances.at(-1)!;
    expect(replacement).not.toBe(old);
    old.frame({ type: 'hello', protocolVersion: REMOTE_PROTOCOL_VERSION, connectionGeneration: '1' });
    expect(bridge.state().connected).toBe(false);
    replacement.frame({ type: 'hello', protocolVersion: REMOTE_PROTOCOL_VERSION, connectionGeneration: '2' });
    expect(bridge.state().connected).toBe(true);
  });
  it('manual retry invalidates an in-flight ticket without changing the device identity', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const { bridge, request, deps } = fixture();
    let release!: (value: Response) => void;
    request.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    const connecting = bridge.connect();
    await bridge.configure({ retry: true });
    const count = FakeSocket.instances.length;
    release(new Response(JSON.stringify({ code: 0, data: { wsUrl: 'wss://example.com/api/remote/v1/ws?ticket=obsolete' } })));
    await connecting;
    expect(FakeSocket.instances).toHaveLength(count);
    await bridge.tick();
    expect(FakeSocket.instances).toHaveLength(count + 1);
    expect(deps.identity).toEqual({ installationId: 'instance', deviceKey: 'key', databaseId: 'db' });
  });
  it('goes online only after hello and goes offline when heartbeats expire', async () => {
    vi.useFakeTimers(); vi.stubGlobal('WebSocket', FakeSocket);
    const { bridge, changed } = fixture(); await bridge.connect();
    const socket = FakeSocket.instances.at(-1)!;
    expect(bridge.state().connectionStatus).toBe(RemoteConnectionStatus.Offline);
    socket.frame({ type: 'hello', protocolVersion: REMOTE_PROTOCOL_VERSION, connectionGeneration: '1', heartbeatTimeoutSeconds: 20, heartbeatIntervalSeconds: 10 });
    expect(bridge.state().connectionStatus).toBe(RemoteConnectionStatus.Online);
    vi.advanceTimersByTime(15000); socket.frame({ type: 'pong' });
    vi.advanceTimersByTime(15000); expect(bridge.state().connected).toBe(true);
    vi.advanceTimersByTime(10000); expect(bridge.state().connected).toBe(false);
    expect(bridge.state()).toMatchObject({ connectionReason: RemoteConnectionReason.ServerUnavailable, errorCode: 4408 });
    expect(socket.close).toHaveBeenCalled(); expect(changed).toHaveBeenCalled();
  });
  it('keeps routine pongs silent and notifies only when a pong restores online state', async () => {
    vi.useFakeTimers(); vi.stubGlobal('WebSocket', FakeSocket);
    const { bridge, changed } = fixture(); await bridge.connect();
    const socket = FakeSocket.instances.at(-1)!;
    socket.frame({ type: 'hello', protocolVersion: REMOTE_PROTOCOL_VERSION, connectionGeneration: '1', heartbeatTimeoutSeconds: 20 });
    changed.mockClear();
    socket.frame({ type: 'pong' }); socket.frame({ type: 'pong' });
    expect(changed).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 20001);
    expect(bridge.state().connected).toBe(false);
    socket.frame({ type: 'pong' });
    expect(bridge.state().connected).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed hello and ignores late frames from a previous account', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const { bridge, switchOwner } = fixture(); await bridge.connect();
    const invalid = FakeSocket.instances.at(-1)!; invalid.frame({ type: 'hello' });
    expect(bridge.state().connected).toBe(false); expect(invalid.close).toHaveBeenCalled();
    await bridge.connect(); const stale = FakeSocket.instances.at(-1)!;
    switchOwner({ userId: '20002', scopeKey: 'personal' });
    stale.frame({ type: 'hello', protocolVersion: REMOTE_PROTOCOL_VERSION, connectionGeneration: '2' });
    expect(bridge.state()).toMatchObject({ connected: false, owner: { userId: '20002', scopeKey: 'personal' } });
  });
});
