import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { REMOTE_PROTOCOL_VERSION, RemoteCapability } from '../../shared/remote/constants';
import { RemoteDeletion } from '../../shared/remote/deletions';
import { RemoteBridge } from './remoteBridge';
import { RemoteStore } from './remoteStore';

const dispose: Array<() => void> = [];
function fixture(failedPath = '/capabilities') {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false });
  let owner = { userId: 'retry-user', scopeKey: 'personal' };
  let route = 'https://example.com';
  const request = vi.fn(async (_owner, path: string) => {
    await new Promise(resolve => setTimeout(resolve, 50));
    if (path.endsWith(failedPath)) return new Response(JSON.stringify({ code: 503, message: 'DEVICE_NOT_READY' }), { status: 503 });
    if (path.endsWith('/capabilities')) return new Response(JSON.stringify({ code: 0, data: {
      enabled: true, protocolVersions: [REMOTE_PROTOCOL_VERSION], capabilities: [RemoteCapability.SameAccountAccess, RemoteDeletion.Capability],
    } }));
    throw new Error(`Unexpected request ${path}`);
  });
  const bridge: any = new RemoteBridge({ store, identity: { installationId: 'install', deviceKey: 'key', databaseId: 'db' },
    runSessionTransaction: operation => store.transaction(operation), getOwner: () => owner, getApiBaseUrl: () => route, request,
    metadata: { name: 'PC', hostName: 'pc', instanceLabel: 'default', platform: 'macos', appVersion: '1' },
    prepare: vi.fn(), execute: vi.fn(), onAccountChange: vi.fn(),
    deletion: { service: {} as any, runtime: {} as any, reconcileStop: vi.fn() },
  });
  const capabilityKey = `deletionCapability:unresolved:${owner.userId}:${owner.scopeKey}`;
  store.put(capabilityKey, true);
  const poll = vi.spyOn(bridge.deletions, 'poll');
  dispose.push(() => { bridge.stop(); db.close(); });
  bridge.accountChanged();
  return { bridge, store, request, poll, capabilityKey,
    count: () => request.mock.calls.filter(([, path]) => path.endsWith(failedPath)).length,
    switchAccount: () => { owner = { ...owner, userId: 'next-user' }; bridge.accountChanged(); },
    switchRoute: () => { route = 'https://next.example.com'; bridge.accountChanged(); },
  };
}
afterEach(() => {
  for (const action of dispose.splice(0).reverse()) action();
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe('remote registration retry backoff', () => {
  it('does not poll cached deletion support before registration establishes a context', async () => {
    const { bridge, store, count, poll, capabilityKey } = fixture();
    await vi.advanceTimersByTimeAsync(1000);
    expect(count()).toBe(1);
    expect(poll).not.toHaveBeenCalled();
    expect(bridge.registration).toBeNull();
    expect(store.get(capabilityKey)).toBe(true);
  });

  it.each(['/capabilities', '/devices/register'])('honors %s failure backoff despite an in-flight local wake and further changes', async failedPath => {
    const { bridge, store, count } = fixture(failedPath);
    await vi.advanceTimersByTimeAsync(10);
    store.transaction(() => store.put('local-work', 'retained'));
    await vi.advanceTimersByTimeAsync(100);
    expect(count()).toBe(1);
    for (let i = 0; i < 9; i++) {
      store.transaction(() => store.put('local-work', i));
      bridge.startDeletionSync();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(count()).toBe(1);
    expect(store.get('local-work')).toBe(8);
    await vi.advanceTimersByTimeAsync(1100);
    expect(count()).toBe(2);
  });

  it.each(['retry', 'account', 'route'])('allows explicit %s recovery before the previous deadline', async action => {
    const { bridge, count, switchAccount, switchRoute } = fixture();
    await vi.advanceTimersByTimeAsync(100);
    expect(count()).toBe(1);
    if (action === 'retry') await bridge.configure({ retry: true });
    else if (action === 'account') switchAccount();
    else switchRoute();
    await vi.advanceTimersByTimeAsync(100);
    expect(count()).toBe(2);
  });

  it.each([
    ['/capabilities', 'route'], ['/devices/register', 'route'],
    ['/capabilities', 'account'], ['/devices/register', 'account'],
    ['/capabilities', 'retry'], ['/devices/register', 'retry'],
  ])('discards the old %s failure after an in-flight %s recovery', async (failedPath, action) => {
    const { bridge, request, switchAccount, switchRoute } = fixture(failedPath);
    await vi.advanceTimersByTimeAsync(failedPath === '/capabilities' ? 10 : 60);
    const previousCalls = request.mock.calls.length;
    if (action === 'retry') await bridge.configure({ retry: true });
    else if (action === 'account') switchAccount();
    else switchRoute();
    await vi.advanceTimersByTimeAsync(50);
    expect(request.mock.calls.length).toBe(previousCalls + 1);
    expect(request.mock.calls.at(-1)![1]).toBe('/api/remote/v1/capabilities');
    expect(bridge.retryAfter).toBe(0);
    expect(bridge.error).toBeUndefined();
  });

  it('keeps the registered deletion receipt lane available during an existing retry deadline', async () => {
    const { bridge, poll } = fixture();
    bridge.registration = { deviceId: 'pc', ...bridge.owner, metadataVersion: '1' };
    bridge.targetId = 'verified-target'; bridge.deletionSupported = true;
    bridge.retryAfter = Date.now() + 60000;
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledWith(true, false);
    expect(bridge.deletions.retryDelay()).toBeGreaterThan(29000);
  });
});
