import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteApiError, RemoteBridge } from './remoteBridge';
import { RemoteStore } from './remoteStore';
import { REMOTE_SYNC_REQUEST_ID_HEADER, remoteSyncRequestId } from './remoteSyncLog';

const owner = { userId: '10001', scopeKey: 'personal' };
const privateText = 'private conversation /Users/test/private.txt Bearer secret-token';
const databases: Database.Database[] = [];
const bridges: RemoteBridge[] = [];

function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db);
  const request = vi.fn(async (_owner, _pathname, _init): Promise<Response> => new Response(JSON.stringify({ code: 0, data: {} })));
  const bridge: any = new RemoteBridge({ store, identity: { installationId: 'instance', deviceKey: privateText, databaseId: 'db' },
    runSessionTransaction: <T>(operation: () => T) => store.transaction(operation),
    getOwner: () => owner, getEnvironment: () => RemoteEnvironment.Test, getApiBaseUrl: () => 'https://example.com', request,
    metadata: { name: 'Desktop', hostName: 'host', platform: 'macos', appVersion: '1', instanceLabel: 'default' },
    prepare: vi.fn(), execute: vi.fn(), onAccountChange: vi.fn() });
  bridge.owner = owner; bridge.registration = { deviceId: 'desktop', ...owner, metadataVersion: '1' };
  bridge.generation = '1'; bridge.sameAccountAccess = true;
  bridges.push(bridge); store.setWake(() => {}); store.setEnabledOwner(owner);
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { bridge, store, request, debug, warning };
}

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.stop();
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

const batchBody = () => ({ batchId: 'batch-1', deviceId: 'desktop', localSessionId: 'local', sessionId: 'session',
  mode: 'online', connectionGeneration: '1', events: [{ eventId: 'event-1', eventType: 'message.upsert', sourceSeq: '7',
    payload: { message: { messageId: 'message-1', revision: '2', content: privateText, input: privateText, path: privateText } } }] });

function syncing() {
  const value = fixture();
  const { store, request } = value;
  store.transaction(() => {
    store.db.prepare('INSERT INTO cowork_sessions VALUES (?, ?, 1, 1, ?)').run('sync-task', privateText, 'idle');
    store.assignNew('sync-task', owner, 'local_create');
    store.db.prepare('INSERT INTO cowork_messages VALUES (?, ?, ?, ?, ?, 1, 1)').run('message-1', 'sync-task', 'user', privateText, '{}');
    store.db.prepare('INSERT INTO cowork_messages VALUES (?, ?, ?, ?, ?, 2, 2)').run('message-2', 'sync-task', 'assistant', privateText, '{}');
  });
  request.mockImplementation(async (_actor, pathname, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const saved = store.get<any>('import:sync-task');
    const receipt = saved ? { sessionId: saved.sessionId, importId: saved.importId, committedSourceSeq: saved.baseSourceSeq,
      committedSeq: '1', stateVersion: '1' } : {};
    let data: any;
    if (pathname.endsWith('/sync/imports')) data = { ...receipt, state: 'uploading' };
    else if (pathname.endsWith('/commit')) data = { ...receipt, state: 'committed' };
    else if (pathname.includes('/parts/')) data = {};
    else if (pathname.endsWith('/sync/batches')) data = { batchId: body.batchId, deviceId: body.deviceId,
      sessionId: body.sessionId, committedSourceSeq: body.events.at(-1).sourceSeq, committedSeq: String(1 + body.events.length) };
    else throw new Error('Unexpected test request');
    return new Response(JSON.stringify({ code: 0, data }));
  });
  return value;
}

describe('remote sync request logging', () => {
  for (const echo of ['absent', 'valid', 'invalid'] as const) it(`correlates a successful sync without leaking request or response bodies (server echo: ${echo})`, async () => {
    const { bridge, request, debug, warning } = fixture();
    request.mockImplementation(async (_actor, _path, init) => {
      const id = init.headers[REMOTE_SYNC_REQUEST_ID_HEADER];
      expect(remoteSyncRequestId(id)).toBe(id);
      expect(init.headers['X-Remote-Device-Credential']).toBe(`desktop.${privateText}`);
      return new Response(JSON.stringify({ code: 0, data: { sessionId: 'session', committedSourceSeq: '7', committedSeq: '11',
        token: privateText, body: privateText } }), { headers: echo === 'absent' ? {} : { [REMOTE_SYNC_REQUEST_ID_HEADER]: echo === 'valid' ? id : privateText } });
    });
    const result = await bridge.api('/sync/batches', 'POST', batchBody());
    expect(result.committedSourceSeq).toBe('7');
    const id = request.mock.calls[0][2].headers[REMOTE_SYNC_REQUEST_ID_HEADER];
    const start = debug.mock.calls.find(([message]) => message === '[RemoteSync] Request started')![1];
    const success = debug.mock.calls.find(([message]) => message === '[RemoteSync] Request succeeded')![1];
    expect(start).toMatchObject({ requestId: id, operation: 'batch', firstSourceSeq: '7', lastSourceSeq: '7', deviceId: 'desktop' });
    expect(success).toMatchObject({ requestId: id, operation: 'batch', responseRequestId: echo === 'valid' ? id : null, httpStatus: 200,
      result: { sessionId: 'session', committedSourceSeq: '7', committedSeq: '11' } });
    expect(start.events[0]).toMatchObject({ sourceSeq: '7', revision: '2' });
    expect(warning).not.toHaveBeenCalled();
    expect(JSON.stringify(debug.mock.calls)).not.toContain(privateText);
  });

  for (const failure of ['business', 'network', 'timeout', 'invalid-json'] as const) {
    it(`preserves request correlation and failure stage for ${failure} errors`, async () => {
      const { bridge, request, debug } = fixture();
      request.mockImplementation(async (_actor, _path, init) => {
        if (failure === 'network') throw new TypeError(privateText);
        if (failure === 'timeout') throw new DOMException(privateText, 'TimeoutError');
        if (failure === 'invalid-json') return new Response(`<html>${privateText}</html>`, { status: 502 });
        return new Response(JSON.stringify({ code: 47025, message: privateText,
          data: { reason: 'RESYNC_REQUIRED', currentSourceSeq: '6', currentServerSeq: '10', token: privateText } }),
        { status: 409, headers: { [REMOTE_SYNC_REQUEST_ID_HEADER]: init.headers[REMOTE_SYNC_REQUEST_ID_HEADER] } });
      });
      await expect(bridge.api('/sync/batches', 'POST', batchBody())).rejects.toBeInstanceOf(Error);
      const id = request.mock.calls[0][2].headers[REMOTE_SYNC_REQUEST_ID_HEADER];
      expect(remoteSyncRequestId(id)).toBe(id);
      expect(request.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);
      const start = debug.mock.calls.find(([message]) => message === '[RemoteSync] Request started')![1];
      const failed = debug.mock.calls.find(([message]) => message === '[RemoteSync] Request failed')![1];
      expect(start.requestId).toBe(id);
      expect(failed).toMatchObject({ requestId: id, operation: 'batch',
        stage: failure === 'network' || failure === 'timeout' ? 'transport' : 'response' });
      if (failure === 'business') expect(failed.error).toMatchObject({ code: 47025, httpStatus: 409, requestId: id,
        reason: 'RESYNC_REQUIRED', currentSourceSeq: '6', currentServerSeq: '10' });
      if (failure === 'invalid-json') expect(failed.error).toMatchObject({ httpStatus: 502, requestId: id, validation: 'Invalid remote response' });
      if (failure === 'timeout') expect(failed.error.errorType).toBe('TimeoutError');
      expect(debug.mock.calls.some(([message]) => message === '[RemoteSync] Request succeeded')).toBe(false);
      expect(JSON.stringify(debug.mock.calls)).not.toContain(privateText);
    });
  }

  it('identifies preparation failures without sending or logging an invalid request body', async () => {
    const { bridge, request, debug } = fixture();
    await expect(bridge.api('/sync/batches', 'POST', { ...batchBody(), invalidValue: undefined }))
      .rejects.toThrow('Remote payload must contain finite JSON values');
    expect(request).not.toHaveBeenCalled();
    const failed = debug.mock.calls.find(([message]) => message === '[RemoteSync] Request failed')![1];
    expect(remoteSyncRequestId(failed.requestId)).toBe(failed.requestId);
    expect(failed).toMatchObject({ operation: 'batch', stage: 'prepare',
      error: { validation: 'Remote payload must contain finite JSON values' } });
    expect(JSON.stringify(debug.mock.calls)).not.toContain(privateText);
  });

  it('does not add correlation headers or sync logs to unrelated APIs', async () => {
    const { bridge, request, debug } = fixture();
    await bridge.api('/devices/desktop/settings', 'GET');
    expect(request.mock.calls[0][2].headers).not.toHaveProperty(REMOTE_SYNC_REQUEST_ID_HEADER);
    expect(debug).not.toHaveBeenCalled();
  });
});

describe('remote sync persistence logging', () => {
  it('records local acknowledgement only after durable snapshot and subsequent batch state are updated', async () => {
    const { bridge, store, request, debug } = syncing();
    const acknowledged: Array<{ message: string; ack: number; source: number; snapshot: number; pending: number; saved: unknown }> = [];
    debug.mockImplementation((message: unknown) => {
      if (message !== '[RemoteSync] Snapshot acknowledged locally' && message !== '[RemoteSync] Batch acknowledged locally') return;
      const row = store.sync('sync-task')!;
      acknowledged.push({ message, ack: row.ack_seq, source: row.source_seq, snapshot: row.needs_snapshot,
        pending: store.pending('sync-task').length, saved: store.get('import:sync-task') });
    });
    await bridge.syncSessions();
    const firstAck = store.sync('sync-task')!.ack_seq;
    store.transaction(() => {
      store.db.prepare('INSERT INTO cowork_messages VALUES (?, ?, ?, ?, ?, 3, 3)').run('message-3', 'sync-task', 'user', privateText, '{}');
      store.db.prepare('INSERT INTO cowork_messages VALUES (?, ?, ?, ?, ?, 4, 4)').run('message-4', 'sync-task', 'assistant', privateText, '{}');
      store.db.prepare('UPDATE cowork_sessions SET updated_at=4 WHERE id=?').run('sync-task');
    });
    expect(store.pending('sync-task').length).toBeGreaterThan(0);
    await bridge.syncSessions();
    expect(acknowledged).toHaveLength(2);
    expect(acknowledged.map(item => item.message)).toEqual(['[RemoteSync] Snapshot acknowledged locally', '[RemoteSync] Batch acknowledged locally']);
    for (const item of acknowledged) {
      expect(item.ack).toBe(item.source); expect(item.snapshot).toBe(0); expect(item.pending).toBe(0); expect(item.saved).toBeNull();
    }
    expect(acknowledged[1].ack).toBeGreaterThan(firstAck);
    expect(request.mock.calls.filter(call => call[1].endsWith('/sync/batches'))).toHaveLength(1);
    const ids = request.mock.calls.map(call => call[2].headers[REMOTE_SYNC_REQUEST_ID_HEADER]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => remoteSyncRequestId(id) === id)).toBe(true);
    expect(JSON.stringify(debug.mock.calls)).not.toContain(privateText);
  });

  for (const failureAt of ['part', 'ack'] as const) it(`does not claim local snapshot success when ${failureAt} fails`, async () => {
    const { bridge, store, request, debug, warning } = syncing();
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (actor, pathname, init) => {
      if (failureAt === 'part' && pathname.includes('/parts/')) return new Response(JSON.stringify({ code: 47019,
        message: privateText, data: { reason: 'EXECUTION_FAILED', privateText } }), { status: 409 });
      if (failureAt === 'ack' && pathname.endsWith('/commit')) return new Response(JSON.stringify({ code: 0,
        data: { committedSourceSeq: '999999', committedSeq: '1' } }));
      return originalRequest(actor, pathname, init);
    });
    const before = store.sync('sync-task')!;
    const pending = store.pending('sync-task');
    // A malformed import receipt pauses that session without failing the independent control lane.
    await bridge.syncSessions();
    expect(store.sync('sync-task')!.ack_seq).toBe(before.ack_seq);
    expect(store.sync('sync-task')!.needs_snapshot).toBe(1);
    expect(store.pending('sync-task')).toEqual(pending);
    expect(store.get('import:sync-task')).not.toBeNull();
    expect(debug.mock.calls.some(([message]) => message === '[RemoteSync] Snapshot acknowledged locally')).toBe(false);
    expect(warning.mock.calls.find(([message]) => message === '[RemoteSync] Session synchronization failed')![1])
      .toMatchObject({ localSessionId: 'sync-task', phase: 'snapshot', ...(failureAt === 'ack' ? { validation: 'Remote import receipt identity mismatch' } : {}) });
    if (failureAt === 'part') expect(request.mock.calls.some(call => call[1].endsWith('/commit'))).toBe(false);
    expect(JSON.stringify([...debug.mock.calls, ...warning.mock.calls])).not.toContain(privateText);
  });

  it('does not emit logs while synchronized tasks remain idle', async () => {
    const { bridge, request, debug, warning } = syncing();
    await bridge.syncSessions();
    request.mockClear(); debug.mockClear(); warning.mockClear();
    await bridge.syncSessions(); await bridge.syncSessions(); await bridge.syncSessions();
    expect(request).not.toHaveBeenCalled(); expect(debug).not.toHaveBeenCalled(); expect(warning).not.toHaveBeenCalled();
  });

  it('emits one retry deferral per unchanged deadline and logs a changed deadline again', async () => {
    const { bridge, store, request, debug, warning } = syncing();
    request.mockRejectedValue(new RemoteApiError(47019, privateText, { reason: 'EXECUTION_FAILED' }, 409));
    await bridge.syncSessions();
    const failure = store.get<any>('syncFailure:sync-task')!;
    await bridge.syncSessions(); await bridge.syncSessions(); await bridge.syncSessions();
    expect(request).toHaveBeenCalledTimes(1); expect(warning).toHaveBeenCalledTimes(1);
    const deferred = () => debug.mock.calls.filter(([message]) => message === '[RemoteSync] Session synchronization deferred');
    expect(deferred()).toHaveLength(1);
    expect(deferred()[0][1]).toMatchObject({ reason: 'retry_backoff', retryAt: failure.retryAt, localSessionId: 'sync-task' });
    store.put('syncFailure:sync-task', { ...failure, retryAt: failure.retryAt + 1000 });
    await bridge.syncSessions();
    expect(deferred()).toHaveLength(2);
  });
});
