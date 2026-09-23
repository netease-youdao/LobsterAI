import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteApiError, RemoteBridge } from './remoteBridge';
import { RemoteStore } from './remoteStore';

const owner = { userId: 'isolation-owner', scopeKey: 'personal' };
const dispose: Array<() => void> = [];
afterEach(() => { dispose.splice(0).reverse().forEach(fn => fn()); vi.restoreAllMocks(); });
const ok = (data: unknown): Response => new Response(JSON.stringify({ code: 0, data }));
function fixture() {
  const db = new Database(':memory:'); dispose.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db);
  const request = vi.fn(async (_owner, path, init) => {
    const body = JSON.parse(String(init.body));
    if (path.endsWith('/sync/batches')) return ok({ batchId: body.batchId, deviceId: body.deviceId, sessionId: body.sessionId,
      committedSourceSeq: body.events.at(-1).sourceSeq, committedSeq: '2' });
    throw new Error('Unexpected test request');
  });
  const bridge: any = new RemoteBridge({ store, identity: { installationId: 'install', deviceKey: 'key', databaseId: 'db' },
    runSessionTransaction: operation => store.transaction(operation), getOwner: () => owner,
    getEnvironment: () => RemoteEnvironment.Test, getApiBaseUrl: () => 'https://example.invalid', request,
    metadata: { name: 'Desktop', hostName: 'host', platform: 'macos', appVersion: '1', instanceLabel: 'default' },
    execute: vi.fn(), prepare: vi.fn(), onAccountChange: vi.fn(),
  });
  dispose.push(() => bridge.stop());
  bridge.owner = owner; bridge.registration = { deviceId: 'desktop', ...owner, metadataVersion: '1' };
  bridge.generation = '1'; bridge.sameAccountAccess = true;
  store.put(`settings:${owner.userId}:${owner.scopeKey}`, { enabled: true, name: 'Desktop', settingsVersion: '1', workspaces: [] });
  const target = bridge.targets.activateLegacy({ owner, deviceId: 'desktop', allowPartialLegacy: true });
  bridge.targetId = target.targetId;
  store.setProjectionIdentity(target.targetId, owner, 'desktop'); store.setFileEnvironment(target.targetId);
  store.setWake(() => {}); store.setEnabledOwner(owner);
  vi.spyOn(bridge, 'schedule').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  const add = (id: string): void => {
    store.transaction(() => {
      db.prepare('INSERT INTO cowork_sessions VALUES(?,?,1,1,?)').run(id, id, 'idle');
      store.assignNew(id, owner, 'local_create');
    });
    const snapshot = store.snapshot(id), row = store.sync(id)!;
    store.bindRemote(id, row.session_id, 'desktop');
    store.acknowledge(id, 'desktop', row.session_id, snapshot.baseSourceSeq, '1', true, snapshot.snapshotEpoch);
    store.transaction(() => {
      db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,NULL,2,1)').run(`${id}-message`, id, 'assistant', 'Preserve this content');
      store.project(id);
    });
  };
  const acknowledged = (id: string): boolean => store.sync(id)!.source_seq === store.sync(id)!.ack_seq;
  return { db, store, bridge, request, add, acknowledged };
}

describe('task synchronization isolation', () => {
  it('isolates a failed interrupted publication instead of deferring it forever', async () => {
    const f = fixture(); f.add('a-bad'); f.add('b-good');
    const before = f.store.sync('a-bad')!;
    vi.spyOn(f.store, 'projectionPublishing').mockImplementation(id => id === 'a-bad');
    f.store.recordProjectionFailure('a-bad', 'REMOTE_PROJECTION_PUBLICATION_INVALID');
    await f.bridge.syncSessions(true);
    expect(f.acknowledged('b-good')).toBe(true);
    expect(f.store.sync('a-bad')!.ack_seq).toBe(before.ack_seq);
    expect(f.bridge.taskSync.get(f.bridge.taskContext(), 'a-bad').phase).toBe('isolated');
    expect(f.bridge.state().syncHealth.failedSessions).toBe(1);
  });
  it('does not permanently isolate a task after shared authentication fails and later recovers', async () => {
    const f = fixture(); f.add('reauthenticate');
    const usual = f.request.getMockImplementation()!;
    f.request.mockResolvedValueOnce(new Response(JSON.stringify({ code: 401, message: 'Authentication required' }), { status: 401 }));
    await expect(f.bridge.syncSessions(true)).rejects.toMatchObject({ code: 401 });
    const state = f.bridge.taskSync.get(f.bridge.taskContext(), 'reauthenticate');
    expect(state.phase).toBe('ready'); expect(state.failure_count).toBe(0);
    expect(f.bridge.taskMemoryBlocks.has('reauthenticate')).toBe(false);
    expect(f.store.get('syncFailure:reauthenticate')).toBeNull();
    expect(f.acknowledged('reauthenticate')).toBe(false);
    f.request.mockImplementation(usual);
    await f.bridge.syncSessions(true);
    expect(f.acknowledged('reauthenticate')).toBe(true);
    expect(f.bridge.taskSync.get(f.bridge.taskContext(), 'reauthenticate').phase).toBe('ready');
  });

  it('opens a bounded history circuit after transport failures span independent tasks', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = fixture(); f.add('a-network'); f.add('b-network'); f.add('c-network');
    const usual = f.request.getMockImplementation()!;
    f.request.mockRejectedValue(new TypeError('fetch failed'));
    await f.bridge.syncSessions(true);
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(f.bridge.historyCircuitProbe).toBe(true);
    expect(f.bridge.historyRetryAt).toBe(now + 30000);
    expect(f.bridge.historyCircuitDelay).toBe(60000);
    for (const id of ['a-network', 'b-network', 'c-network']) {
      expect(f.bridge.taskSync.get(f.bridge.taskContext(), id)).toMatchObject({ phase: 'backoff', failure_count: 1 });
      expect(f.acknowledged(id)).toBe(false);
    }
    await f.bridge.syncSessions(true); expect(f.request).toHaveBeenCalledTimes(3);
    now += 40000; f.request.mockImplementation(usual);
    await f.bridge.syncSessions(true);
    expect(f.bridge.historyCircuitProbe).toBe(false); expect(f.bridge.historyCircuitDelay).toBe(30000);
    for (const id of ['a-network', 'b-network', 'c-network']) expect(f.acknowledged(id)).toBe(true);
  });

  for (const corrupt of ['outbox', 'import'] as const) it(`isolates corrupt ${corrupt} without losing evidence or blocking a healthy task`, async () => {
    const f = fixture(); f.add('a-bad'); f.add('b-good');
    const before = f.store.sync('a-bad')!;
    if (corrupt === 'outbox') f.db.prepare('UPDATE remote_outbox SET event_json=? WHERE session_id=?').run('{', 'a-bad');
    else f.db.prepare('INSERT INTO remote_state VALUES(?,?)').run('import:a-bad', '{');
    await f.bridge.syncSessions(true);
    expect(f.acknowledged('b-good')).toBe(true);
    expect(f.store.sync('a-bad')!.ack_seq).toBe(before.ack_seq);
    expect(f.bridge.taskSync.get(f.bridge.taskContext(), 'a-bad').phase).toBe('isolated');
    expect(f.bridge.registration.deviceId).toBe('desktop');
    if (corrupt === 'outbox') expect(f.db.prepare('SELECT event_json FROM remote_outbox WHERE session_id=?').get('a-bad')).toEqual({ event_json: '{' });
    else expect(f.db.prepare('SELECT value FROM remote_state WHERE key=?').get('import:a-bad')).toEqual({ value: '{' });
    await f.bridge.syncSessions(true);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('allows a healthy ACK while another task HTTP request is still pending', async () => {
    const f = fixture(); f.add('a-slow'); f.add('b-ready');
    const usual = f.request.getMockImplementation()!;
    let release!: (value: Response) => void;
    f.request.mockImplementation(async (actor, path, init) => {
      const body = JSON.parse(String(init.body));
      if (body.localSessionId === 'a-slow') return new Promise<Response>(resolve => { release = resolve; });
      return usual(actor, path, init);
    });
    const work = f.bridge.syncSessions(true);
    await vi.waitFor(() => expect(f.acknowledged('b-ready')).toBe(true));
    expect(f.acknowledged('a-slow')).toBe(false);
    const call = f.request.mock.calls.find(([, , init]) => JSON.parse(String(init.body)).localSessionId === 'a-slow')!;
    release(await usual(...call)); await work;
    expect(f.acknowledged('a-slow')).toBe(true);
  });

  it('contains an exception raised during conflict recovery', async () => {
    const f = fixture(); f.add('a-conflict'); f.add('b-ready');
    const usual = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (actor, path, init) => {
      if (JSON.parse(String(init.body)).localSessionId === 'a-conflict') throw new RemoteApiError(47025, 'conflict', { currentImport: { importId: 'original' } }, 409);
      return usual(actor, path, init);
    });
    vi.spyOn(f.bridge, 'recoverImportConflict').mockRejectedValue(new Error('corrupt recovery record'));
    await f.bridge.syncSessions(true);
    expect(f.acknowledged('b-ready')).toBe(true);
    expect(f.acknowledged('a-conflict')).toBe(false);
    expect(f.bridge.taskSync.get(f.bridge.taskContext(), 'a-conflict').phase).toBe('isolated');
  });

  it('keeps healthy tasks moving when a task failure record cannot be written', async () => {
    const f = fixture(); f.add('a-bad'); f.add('b-ready');
    f.db.prepare('UPDATE remote_outbox SET event_json=? WHERE session_id=?').run('{', 'a-bad');
    vi.spyOn(f.bridge.taskSync, 'fail').mockImplementation(() => { throw new Error('derived state write failed'); });
    await f.bridge.syncSessions(true);
    expect(f.acknowledged('b-ready')).toBe(true);
    expect(f.bridge.taskMemoryBlocks.has('a-bad')).toBe(true);
    expect(f.acknowledged('a-bad')).toBe(false);
  });

  it('does not require state or diagnostics support from an old v1 server', async () => {
    const f = fixture(); f.add('legacy');
    await f.bridge.syncSessions(true);
    expect(f.acknowledged('legacy')).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0][1]).toBe('/api/remote/v1/sync/batches');
    expect(f.request.mock.calls[0][2].headers['X-Remote-Sync-Diagnostics']).toBeUndefined();
  });

  it('keeps Retry-After outside the legacy response body and prevents an early retry', async () => {
    const f = fixture(); f.add('rate-limited');
    f.request.mockResolvedValue(new Response(JSON.stringify({ code: 429, data: { reason: 'RATE_LIMITED' } }), { status: 429, headers: { 'Retry-After': '120' } }));
    const now = Date.now(); await f.bridge.syncSessions(true);
    const state = f.bridge.taskSync.get(f.bridge.taskContext(), 'rate-limited');
    expect(state.server_retry_at).toBeGreaterThanOrEqual(now + 120000);
    expect(f.bridge.taskSync.manualRetry(f.bridge.taskContext(), 'rate-limited')).toBe(false);
    await f.bridge.syncSessions(true); expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('does not make transient task failures reset their budget on reconnect', async () => {
    const f = fixture(); f.add('offline');
    f.request.mockRejectedValue(new TypeError('fetch failed'));
    await f.bridge.syncSessions(true);
    const context = f.bridge.taskContext(), before = f.bridge.taskSync.get(context, 'offline');
    await f.bridge.configure({ retry: true });
    expect(f.bridge.taskSync.get(context, 'offline')).toEqual(before);
    expect(f.store.get('syncFailure:offline')).not.toBeNull();
  });
});
