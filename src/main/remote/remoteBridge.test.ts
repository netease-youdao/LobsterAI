import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { payloadHash } from './canonical';
import { type InboxEntry, RemoteApiError,RemoteBridge } from './remoteBridge';
import { RemoteStore } from './remoteStore';

const owner = { userId: '10001', scopeKey: 'personal' };
const databases: Database.Database[] = [];
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db);
  const request = { commandId: 'command-1', type: 'create_session', deviceId: 'desktop', expiresAt: new Date(Date.now() + 60000).toISOString(), payload: { text: 'hello', workspaceId: 'workspace' } };
  const command = { sessionId: 'remote', runId: 'server-run', commandId: request.commandId, type: request.type, status: 'claimed', statusVersion: '2', expiresAt: request.expiresAt };
  const envelope = { command, request, requestHash: payloadHash(request), claimId: 'claim', claimToken: 'secret', claimUntil: new Date(Date.now() + 15000).toISOString(), statusVersion: '2' };
  const calls: string[] = [];
  let disconnectOnReceipt = false;
  let receiptStatus = 'received';
  const execute = vi.fn(async (entry: InboxEntry, stillPermitted: () => boolean) => {
    expect(store.get<InboxEntry>('inbox:command-1')?.state).toBe('executing');
    expect(stillPermitted()).toBe(true); calls.push('execute'); return { outcome: 'started' };
  });
  const requestApi = vi.fn(async (_owner, pathname, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push(`${pathname}:${body?.status || ''}`);
    let data: any;
    if (pathname.endsWith('/commands/claim')) data = { items: [envelope] };
    else if (pathname.endsWith('/ack')) {
      // Mirror RemoteCommandService.mapping/result/error validators, rather than a permissive self-mock.
      expect(body.sessionId).toBe(command.sessionId); expect(body.runId).toBe(command.runId);
      if (body.status === 'applied') expect(body.result).toEqual({ outcome: 'started' });
      else expect(body.result).toBeNull();
      if (body.error) {
        expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'reason', 'reasonDetail', 'retryAfterMs', 'retryable']);
        expect(typeof body.error.code).toBe('number'); expect(typeof body.error.retryable).toBe('boolean');
      }
      if (body.status === 'received') {
        expect(store.get<InboxEntry>('inbox:command-1')?.state).toBe('prepared');
        if (disconnectOnReceipt) bridge.generation = null;
      }
      data = { ...command, status: body.status === 'received' ? receiptStatus : body.status, statusVersion: body.status === 'received' ? '3' : '4' };
    } else if (pathname.includes('/commands?')) data = { items: [envelope], nextCursor: null };
    else if (pathname.endsWith('/reconcile')) data = { command: { ...command, status: 'unknown', statusVersion: '4' }, executionPermit: null };
    else throw new Error(`Unexpected request ${pathname}`);
    return new Response(JSON.stringify({ code: 0, message: 'success', data }));
  });
  const bridge: any = new RemoteBridge({ store, identity: { installationId: 'instance', deviceKey: 'key', databaseId: 'db' },
    getOwner: () => owner, getApiBaseUrl: () => 'https://example.com', request: requestApi,
    metadata: { name: 'Desktop', hostName: 'host', platform: 'macos', appVersion: '1', instanceLabel: 'default' },
    prepare: () => { store.db.prepare("INSERT INTO cowork_sessions VALUES ('local','hello',1,1,'idle')").run(); store.assignNew('local', owner, 'remote_command'); return { localSessionId: 'local', remoteSessionId: 'remote', runId: command.runId }; },
    execute, onAccountChange: vi.fn(),
  });
  bridge.owner = owner; bridge.registration = { deviceId: 'desktop', ...owner, metadataVersion: '1' }; bridge.generation = '1'; bridge.sameAccountAccess = true;
  store.put('settings:10001:personal', { enabled: true, name: 'Desktop', settingsVersion: '1', workspaces: [{ workspaceId: 'workspace', name: 'Folder', path: '/work', available: true }] });
  return { store, bridge, envelope, calls, execute, requestApi, disconnect: () => { disconnectOnReceipt = true; }, terminalReceipt: () => { receiptStatus = 'applied'; } };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('command execution safety', () => {
  it('durably prepares before received ACK and dispatches only once across duplicate claims', async () => {
    const { bridge, execute, store, calls } = fixture();
    await bridge.claim(); await bridge.claim();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.get<InboxEntry>('inbox:command-1')?.state).toBe('applied');
    expect(calls.indexOf('/api/remote/v1/commands/command-1/ack:received')).toBeLessThan(calls.indexOf('execute'));
    expect(store.sync('local')!.device_id).toBe('desktop'); bridge.stop();
  });
  it('does not dispatch after generation loss during received ACK', async () => {
    const { bridge, execute, store, disconnect } = fixture(); disconnect();
    await bridge.claim(); expect(execute).not.toHaveBeenCalled(); expect(store.get<InboxEntry>('inbox:command-1')?.state).toBe('prepared'); bridge.stop();
  });
  it('rejects tampered request hashes without calling the executor', async () => {
    const { bridge, envelope, execute, store } = fixture(); envelope.request.payload.text = 'changed';
    await bridge.claim(); expect(execute).not.toHaveBeenCalled(); expect(store.get<InboxEntry>('inbox:command-1')?.state).toBe('rejected'); bridge.stop();
  });
  it('reports uncertain execution after restart without requesting a new permit', async () => {
    const { bridge, execute, requestApi, store } = fixture(); await bridge.claim();
    const entry = store.get<InboxEntry>('inbox:command-1')!; entry.state = 'executing'; store.put('inbox:command-1', entry);
    execute.mockClear(); await bridge.reconcile(); expect(execute).not.toHaveBeenCalled();
    const reconcile = requestApi.mock.calls.find((call: any[]) => call[1].endsWith('/reconcile'))!;
    const body = JSON.parse(String(reconcile[2].body)); expect(body.observedExecution).toBe('unknown'); expect(body.requestExecutionPermit).toBe(false); bridge.stop();
  });
  it('merges terminal received responses without dispatching an already-applied command', async () => {
    const { bridge, execute, terminalReceipt, store } = fixture(); terminalReceipt();
    await bridge.claim(); expect(execute).not.toHaveBeenCalled(); expect(store.get<InboxEntry>('inbox:command-1')?.state).toBe('applied'); bridge.stop();
  });
  it('does not cancel local runs when the remote socket closes', () => {
    const { bridge, execute } = fixture(); bridge.disconnect(); expect(execute).not.toHaveBeenCalled(); expect(bridge.generation).toBeNull(); bridge.stop();
  });
});


describe('settings intent ordering', () => {
  for (const pauseAt of ['GET', 'PATCH']) it(`preserves a newer disable while an older ${pauseAt} is in flight`, async () => {
    const { bridge, requestApi, store } = fixture();
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const updates: boolean[] = [];
    let paused = false;
    requestApi.mockImplementation(async (_owner, pathname, init) => {
      if (pathname.endsWith('/settings')) {
        if (init.method === pauseAt && !paused) { paused = true; reached(); await gate; }
        if (init.method === 'PATCH') updates.push(JSON.parse(String(init.body)).remoteEnabled);
        return new Response(JSON.stringify({ code: 0, data: { settingsVersion: '2' } }));
      }
      if (pathname.endsWith('/metadata')) return new Response(JSON.stringify({ code: 0, data: { metadataVersion: '2' } }));
      throw new Error(`Unexpected ${pathname}`);
    });
    await bridge.configure({ enabled: true });
    const enable = bridge.writeSettings();
    await waiting;
    await bridge.configure({ enabled: false });
    const disable = bridge.writeSettings();
    await Promise.resolve(); await Promise.resolve();
    expect(store.get<any>('settings:10001:personal').enabled).toBe(false);
    release();
    await Promise.all([enable, disable]);
    expect(store.get<any>('settings:10001:personal').enabled).toBe(false);
    expect(updates.at(-1)).toBe(false);
    expect(updates).toEqual([true, false]);
    bridge.stop();
  });
});


describe('temporary rollout unavailability', () => {
  for (const code of [404, 47000]) it(`automatically probes again after ${code} without dropping durable work`, async () => {
    vi.useFakeTimers();
    const { bridge, store } = fixture();
    try {
      vi.spyOn(bridge, 'schedule').mockImplementation(() => undefined);
      const registration = vi.spyOn(bridge, 'ensureRegistration').mockRejectedValueOnce(new RemoteApiError(code, 'temporarily unavailable')).mockResolvedValue(undefined);
      vi.spyOn(bridge, 'connect').mockResolvedValue(undefined);
      vi.spyOn(bridge, 'pollAccess').mockResolvedValue(undefined);
      vi.spyOn(bridge, 'reconcile').mockResolvedValue(undefined);
      const sync = vi.spyOn(bridge, 'syncSessions').mockResolvedValue(undefined);
      vi.spyOn(bridge, 'claim').mockResolvedValue(undefined);
      store.put('inbox:retained', { state: 'unknown' });
      await bridge.tick();
      expect(bridge.suspended).toBe(false); expect(bridge.backoff).toBe(60000);
      await bridge.tick(); expect(registration).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 60001);
      await bridge.tick();
      expect(registration).toHaveBeenCalledTimes(2); expect(sync).toHaveBeenCalledTimes(1);
      expect(store.get<any>('inbox:retained')).toEqual({ state: 'unknown' });
      expect(bridge.owner).toEqual(owner);
    } finally { bridge.stop(); vi.useRealTimers(); }
  });
});
