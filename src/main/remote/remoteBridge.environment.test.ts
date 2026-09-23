import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { REMOTE_PROTOCOL_VERSION, RemoteCapability, type RemoteOwner } from '../../shared/remote/constants';
import { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteRetention, type RetentionState } from '../../shared/remote/retention';
import { RemoteSyncTarget, type RemoteSyncTargetIdentity } from '../../shared/remote/syncTarget';
import { RemoteBridge } from './remoteBridge';
import { RemoteStore } from './remoteStore';

const owner: RemoteOwner = { userId: '10001', scopeKey: 'personal' };
const disposables: Array<() => void> = [];
const response = (data: unknown): Response => new Response(JSON.stringify({ code: 0, data }));
const missing = (): Response => new Response(JSON.stringify({ code: RemoteRetention.StateMissingCode, message: 'missing' }), { status: 404 });
const targetA: RemoteSyncTargetIdentity = { version: 1, dataSpaceId: 'space-a', dataGeneration: '1' };
const targetB: RemoteSyncTargetIdentity = { version: 1, dataSpaceId: 'space-b', dataGeneration: '1' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(initialTarget: RemoteSyncTargetIdentity | null = targetA) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false });
  let environment: RemoteEnvironment = RemoteEnvironment.Test;
  let apiBaseUrl = 'https://first.example.com';
  let target = initialTarget;
  let deviceId = 'desktop';
  const states = new Map<string, RetentionState>();
  const request = vi.fn(async (_owner: RemoteOwner, pathname: string, _init: RequestInit): Promise<Response> => {
    if (pathname.endsWith('/capabilities')) return response({ enabled: true, protocolVersions: [REMOTE_PROTOCOL_VERSION],
      capabilities: [RemoteCapability.SameAccountAccess, ...(target ? [RemoteSyncTarget.Capability] : [])], ...(target ? { syncTarget: target } : {}) });
    if (pathname.endsWith('/devices/register')) return response({ deviceId, ...owner, metadataVersion: '1', ...(target ? { syncTarget: target } : {}) });
    if (pathname.includes('/sync/state?')) {
      const id = new URL(`https://unused${pathname}`).searchParams.get('localSessionId')!;
      return states.has(id) ? response(states.get(id)) : missing();
    }
    if (pathname.endsWith('/settings')) return response({ settingsVersion: '2' });
    throw new Error(`Unexpected request: ${pathname}`);
  });
  const deps = {
    store, identity: { installationId: 'installation', deviceKey: 'key', databaseId: 'database' },
    runSessionTransaction: <T>(operation: () => T) => store.transaction(operation),
    getOwner: () => owner, getEnvironment: () => environment, getApiBaseUrl: () => apiBaseUrl, request,
    metadata: { name: 'Desktop', hostName: 'desktop.local', instanceLabel: 'default', platform: 'macos', appVersion: '1' },
    prepare: vi.fn(), execute: vi.fn(), onAccountChange: vi.fn(),
  };
  const bridge: any = new RemoteBridge(deps);
  vi.spyOn(bridge, 'schedule').mockImplementation(() => undefined);
  bridge.accountChanged();
  disposables.push(() => { bridge.stop(); db.close(); });
  const seed = (id = 'local', mode = 'https://legacy.example.com', actor = owner) => {
    store.transaction(() => {
      db.prepare('INSERT INTO cowork_sessions VALUES (?,?,1,1,?)').run(id, id, 'idle');
      store.assignNew(id, actor, 'local_create');
    });
    db.prepare('UPDATE remote_sync SET session_id=?,device_id=?,sync_environment=?,source_seq=12,ack_seq=9,server_seq=? WHERE local_id=?')
      .run(`remote-${id}`, deviceId, mode, '10', id);
    const state: RetentionState = { deviceId, sessionId: `remote-${id}`, localSessionId: id, syncProtocolVersion: 1,
      streamEpoch: null, lastSourceSeq: '9', lastSeq: '10', sourcePurgeSeq: '0', eventPurgeSeq: '0', deleted: false };
    states.set(id, state);
    return state;
  };
  return { bridge, db, store, request, deps, states, seed,
    switchMode(next: RemoteEnvironment) { environment = next; bridge.accountChanged(); },
    switchRoute(url: string, nextTarget = target, nextDevice = deviceId) {
      apiBaseUrl = url; target = nextTarget; deviceId = nextDevice; bridge.accountChanged();
    },
    replaceTarget(next: RemoteSyncTargetIdentity | null) { target = next; },
    silentlySwitchRoute(url: string) { apiBaseUrl = url; },
  };
}
afterEach(() => { for (const dispose of disposables.splice(0).reverse()) dispose(); });

describe('remote synchronization follows the effective service', () => {
  it('reconnects after an address change but preserves verified same-service progress', async () => {
    const f = fixture(); f.seed();
    await f.bridge.ensureRegistration();
    const targetId = f.bridge.getSyncTargetId();
    const socket = { close: vi.fn() }; f.bridge.socket = socket; f.bridge.generation = 'old';
    const current = f.bridge.syncContext();
    f.switchRoute('https://alias.example.com');
    expect(current()).toBe(false); expect(socket.close).toHaveBeenCalledOnce();
    expect(f.bridge.registration).toBeNull();
    await f.bridge.ensureRegistration();
    expect(f.bridge.getSyncTargetId()).toBe(targetId);
    expect(f.store.sync('local')).toMatchObject({ session_id: 'remote-local', source_seq: 12, ack_seq: 9, server_seq: '10' });
  });
  it('ignores client mode changes that leave the effective address unchanged', async () => {
    const f = fixture(); await f.bridge.ensureRegistration();
    const registration = f.bridge.registration, epoch = f.bridge.accountGeneration;
    f.switchMode(RemoteEnvironment.Production);
    expect(f.bridge.registration).toBe(registration); expect(f.bridge.accountGeneration).toBe(epoch);
  });
  it.each([false, true])('rejects late responses after a route switch, including a round trip (%s)', async roundTrip => {
    const f = fixture(); await f.bridge.ensureRegistration();
    const delayed = deferred<Response>(); f.request.mockImplementationOnce(() => delayed.promise);
    const pending = f.bridge.api('/devices/desktop/settings');
    const rejected = expect(pending).rejects.toThrow('Account changed during remote request');
    f.switchRoute('https://alias.example.com'); await f.bridge.ensureRegistration();
    if (roundTrip) { f.switchRoute('https://first.example.com'); await f.bridge.ensureRegistration(); }
    delayed.resolve(response({ settingsVersion: 'stale' })); await rejected;
  });
  it('rejects a body that finishes after A to B to A', async () => {
    const f = fixture(); await f.bridge.ensureRegistration();
    const started = deferred<void>(), body = deferred<string>();
    const delayed = response(null); vi.spyOn(delayed, 'text').mockImplementation(() => { started.resolve(); return body.promise; });
    f.request.mockResolvedValueOnce(delayed);
    const pending = f.bridge.api('/devices/desktop/settings');
    const rejected = expect(pending).rejects.toThrow('Account changed during remote response'); await started.promise;
    f.switchRoute('https://alias.example.com'); await f.bridge.ensureRegistration();
    f.switchRoute('https://first.example.com'); await f.bridge.ensureRegistration();
    body.resolve(JSON.stringify({ code: 0, data: {} })); await rejected;
  });
  it('does not send old credentials when the route changes before its notification arrives', async () => {
    const f = fixture(); await f.bridge.ensureRegistration(); f.request.mockClear();
    f.silentlySwitchRoute('https://different.example.com');
    await expect(f.bridge.api('/devices/desktop/settings', 'PATCH', {})).rejects.toThrow('route changed');
    expect(f.request).not.toHaveBeenCalled();
  });
  it('starts an independent mapping on a new space and restores the previous ACK on return', async () => {
    const f = fixture(); f.seed(); await f.bridge.ensureRegistration();
    const targetId = f.bridge.getSyncTargetId();
    f.switchRoute('https://other.example.com', targetB, 'desktop-b');
    await f.bridge.ensureRegistration();
    expect(f.bridge.getSyncTargetId()).not.toBe(targetId);
    expect(f.store.sync('local')).toMatchObject({ device_id: 'desktop-b', ack_seq: 0, source_seq: 0, server_seq: '0', needs_snapshot: 1 });
    expect(f.store.sync('local')?.session_id).not.toBe('remote-local');
    f.switchRoute('https://first.example.com', targetA, 'desktop'); await f.bridge.ensureRegistration();
    expect(f.bridge.getSyncTargetId()).toBe(targetId);
    expect(f.store.sync('local')).toMatchObject({ session_id: 'remote-local', ack_seq: 9, source_seq: 12, server_seq: '10', needs_snapshot: 1 });
    expect(f.deps.execute).not.toHaveBeenCalled();
  });
  it('blocks a generation change without clearing previous progress', async () => {
    const f = fixture(); f.seed(); await f.bridge.ensureRegistration();
    f.switchRoute('https://restored.example.com', { ...targetA, dataGeneration: '2' });
    await expect(f.bridge.ensureRegistration()).rejects.toThrow('generation requires recovery');
    expect(f.store.sync('local')?.ack_seq).toBe(9);
  });
  it.each(['https://unknown.test.example', RemoteEnvironment.Test, RemoteEnvironment.Production])('claims legacy %s only after server state confirms it', async environment => {
    const f = fixture(); f.seed('local', environment); f.seed('foreign', environment, { ...owner, userId: 'foreign' });
    await f.bridge.ensureRegistration();
    expect(f.store.sync('local')?.sync_environment).toBe(f.bridge.getSyncTargetId());
    expect(f.store.sync('foreign')?.sync_environment).toBe(environment);
    expect(f.store.sync('local')?.ack_seq).toBe(9);
  });
  it.each(['missing', 'rollback', 'ahead', 'wrong-session'])('does not claim an unproven legacy mapping (%s)', async reason => {
    const f = fixture(); const state = f.seed();
    if (reason === 'missing') f.states.clear();
    if (reason === 'rollback') state.lastSourceSeq = '8';
    if (reason === 'ahead') state.lastSourceSeq = '13';
    if (reason === 'wrong-session') state.sessionId = 'different';
    await expect(f.bridge.ensureRegistration()).rejects.toThrow();
    expect(f.store.sync('local')).toMatchObject({ sync_environment: 'https://legacy.example.com', ack_seq: 9 });
  });
  it('blocks a deleted remote session instead of creating a new snapshot mapping', async () => {
    const f = fixture(); const state = f.seed(); state.deleted = true;
    await f.bridge.ensureRegistration();
    expect(f.store.get('syncFailure:local')).toMatchObject({ blocked: true });
    expect(f.store.sync('local')).toMatchObject({ session_id: 'remote-local', ack_seq: 9 });
    await expect(f.bridge.readSyncState(f.store.sync('local'))).rejects.toThrow('deleted');
  });
  it('supports a proven legacy server but refuses an identified target downgrade', async () => {
    const f = fixture(null); f.seed(); await f.bridge.ensureRegistration();
    expect(f.bridge.getSyncTargetId()).toMatch(/^legacy:/u);
    f.switchRoute('https://upgraded.example.com', targetA); await f.bridge.ensureRegistration();
    expect(f.bridge.getSyncTargetId()).not.toMatch(/^legacy:/u);
    f.switchRoute('https://old-node.example.com', null);
    await expect(f.bridge.ensureRegistration()).rejects.toThrow('cannot be downgraded');
  });
  it('reconciles a committed upgrade import before comparing the previous stream epoch', async () => {
    const f = fixture(); const state = f.seed();
    f.store.put('import:local', { importId: 'upgrade', sessionId: 'remote-local', baseSourceSeq: '12', snapshotEpoch: 0,
      expectedSourceSeq: '9', expectedServerSeq: '10', syncProtocolVersion: RemoteRetention.Version, expectedStreamEpoch: null,
      beginAttempted: true, owner, deviceId: 'desktop', environment: 'https://legacy.example.com', manifest: { manifestHash: 'hash' }, parts: [] });
    Object.assign(state, { syncProtocolVersion: RemoteRetention.Version, streamEpoch: 'new-epoch', lastSourceSeq: '12', lastSeq: '18' });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((actor, pathname, init) => pathname.endsWith('/sync/imports/upgrade')
      ? Promise.resolve(response({ state: 'committed', importId: 'upgrade', sessionId: 'remote-local', manifestHash: 'hash',
        syncProtocolVersion: RemoteRetention.Version, targetStreamEpoch: 'new-epoch', streamEpoch: 'new-epoch',
        committedSourceSeq: '12', committedSeq: '18', sourcePurgeSeq: '0', eventPurgeSeq: '0' })) : original(actor, pathname, init));
    await f.bridge.ensureRegistration();
    expect(f.store.get('import:local')).toBeNull();
    expect(f.store.sync('local')).toMatchObject({ ack_seq: 12, server_seq: '18', stream_epoch: 'new-epoch' });
  });
  it.each([false, true])('isolates missing imports of verified deleted sessions and still synchronizes a new task (known target: %s)', async knownTarget => {
    const f = fixture();
    const state = f.seed();
    if (knownTarget) await f.bridge.ensureRegistration();
    state.deleted = true;
    const pending = { importId: 'rejected-import', sessionId: state.sessionId, beginAttempted: true,
      owner, deviceId: state.deviceId, manifest: { manifestHash: 'original-hash' }, parts: [] };
    f.store.put('import:local', pending);
    f.bridge.registration = null;
    f.bridge.error = '47002: missing import'; f.bridge.errorCode = 47002;
    f.bridge.errorRequestKey = '1:GET:/sync/imports/rejected-import';
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (actor, pathname, init) => {
      if (pathname.endsWith('/sync/imports/rejected-import')) return new Response(JSON.stringify({ code: 47002, message: 'missing' }), { status: 404 });
      if (pathname.endsWith('/sync/imports') && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return response({ state: 'committed', importId: body.importId, sessionId: body.sessionId,
          manifestHash: body.manifest.manifestHash, committedSourceSeq: body.baseSourceSeq, committedSeq: '30' });
      }
      return original(actor, pathname, init);
    });
    await f.bridge.ensureRegistration();
    expect(f.bridge.registration.deviceId).toBe('desktop');
    expect(f.bridge.getSyncTargetId()).not.toBeNull();
    expect(f.bridge.error).toBeUndefined();
    expect(f.store.get('syncFailure:local')).toMatchObject({ blocked: true });
    expect(f.store.get('import:local')).toMatchObject(pending);
    expect(f.store.sync('local')).toMatchObject({ ack_seq: 9, server_seq: '10', session_id: 'remote-local' });
    expect(f.db.prepare('SELECT id FROM cowork_sessions WHERE id=?').get('local')).toBeTruthy();
    f.store.transaction(() => {
      f.db.prepare('INSERT INTO cowork_sessions VALUES (?,?,1,1,?)').run('new-task', 'New task', 'idle');
      f.store.assignNew('new-task', owner, 'local_create');
    });
    f.bridge.generation = 'connected';
    f.request.mockClear();
    await f.bridge.syncSessions();
    const uploads = f.request.mock.calls.filter(([, path, init]) => path.endsWith('/sync/imports') && init.method === 'POST');
    expect(uploads).toHaveLength(1);
    expect(JSON.parse(String(uploads[0][2].body)).localSessionId).toBe('new-task');
    const synced = f.store.sync('new-task')!;
    expect(synced.ack_seq).toBe(synced.source_seq);
    expect(synced.needs_snapshot).toBe(0);
    expect(f.store.get('import:local')).toMatchObject(pending);
    expect(f.deps.execute).not.toHaveBeenCalled();
  });
  it.each(['not-deleted', 'wrong-device', 'wrong-session', 'wrong-local', 'rollback', 'ahead', 'server-rollback', 'epoch', 'protocol', 'active-import', 'missing-state', 'wrong-attempt'])('does not infer a deleted stream from an import 404 (%s)', async mismatch => {
    const f = fixture(); const state = f.seed();
    f.db.prepare('UPDATE remote_sync SET sync_protocol_version=2,stream_epoch=? WHERE local_id=?').run('original-epoch', 'local');
    Object.assign(state, { syncProtocolVersion: 2, streamEpoch: 'original-epoch', deleted: true });
    f.store.put('import:local', { importId: 'rejected-import', sessionId: mismatch === 'wrong-attempt' ? 'foreign' : state.sessionId,
      beginAttempted: true, owner, deviceId: state.deviceId });
    if (mismatch === 'not-deleted') state.deleted = false;
    if (mismatch === 'wrong-device') state.deviceId = 'foreign';
    if (mismatch === 'wrong-session') state.sessionId = 'foreign';
    if (mismatch === 'wrong-local') state.localSessionId = 'foreign';
    if (mismatch === 'rollback') state.lastSourceSeq = '8';
    if (mismatch === 'ahead') state.lastSourceSeq = '13';
    if (mismatch === 'server-rollback') state.lastSeq = '9';
    if (mismatch === 'epoch') state.streamEpoch = 'foreign';
    if (mismatch === 'protocol') state.syncProtocolVersion = 1;
    if (mismatch === 'active-import') state.activeImport = { importId: 'unknown' };
    if (mismatch === 'missing-state') f.states.clear();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (actor, pathname, init) => pathname.endsWith('/sync/imports/rejected-import')
      ? new Response(JSON.stringify({ code: 47002, message: 'missing' }), { status: 404 }) : original(actor, pathname, init));
    await expect(f.bridge.ensureRegistration()).rejects.toThrow();
    expect(f.bridge.registration).toBeNull();
    expect(f.bridge.getSyncTargetId()).toBeNull();
    expect(f.store.sync('local')).toMatchObject({ ack_seq: 9, server_seq: '10', stream_epoch: 'original-epoch' });
    expect(f.store.get('import:local')).not.toBeNull();
    expect(f.request.mock.calls.some(([, path, init]) => path.endsWith('/sync/imports') && init.method === 'POST')).toBe(false);
  });
  it.each([[403, 47002], [500, 500], [404, 404]])('does not treat HTTP %s / code %s as a missing import receipt', async (status, code) => {
    const f = fixture(); const state = f.seed(); state.deleted = true;
    f.store.put('import:local', { importId: 'rejected-import', sessionId: state.sessionId, beginAttempted: true });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (actor, pathname, init) => pathname.endsWith('/sync/imports/rejected-import')
      ? new Response(JSON.stringify({ code, message: 'unavailable' }), { status }) : original(actor, pathname, init));
    await expect(f.bridge.ensureRegistration()).rejects.toThrow('unavailable');
    expect(f.request.mock.calls.some(([, path]) => path.includes('/sync/state?'))).toBe(false);
    expect(f.store.get('import:local')).not.toBeNull();
  });
  it('rejects a tombstone response arriving after a route change without binding or acknowledging it', async () => {
    const f = fixture(); const state = f.seed(); state.deleted = true;
    f.store.put('import:local', { importId: 'rejected-import', sessionId: state.sessionId, beginAttempted: true });
    const started = deferred<void>(), finish = deferred<Response>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (actor, pathname, init) => {
      if (pathname.endsWith('/sync/imports/rejected-import')) return new Response(JSON.stringify({ code: 47002, message: 'missing' }), { status: 404 });
      if (pathname.includes('/sync/state?')) { started.resolve(); return finish.promise; }
      return original(actor, pathname, init);
    });
    const registration = f.bridge.ensureRegistration();
    const rejected = expect(registration).rejects.toThrow('Account changed during remote request');
    await started.promise;
    f.switchRoute('https://other.example.com', targetB, 'desktop-b');
    finish.resolve(response(state)); await rejected;
    expect(f.bridge.registration).toBeNull(); expect(f.bridge.getSyncTargetId()).toBeNull();
    expect(f.store.sync('local')?.ack_seq).toBe(9);
    expect(f.store.get('import:local')).not.toBeNull();
  });
  it('keeps the result of an old execution in its original inbox without ACKing the new server', async () => {
    const f = fixture(); f.seed(); await f.bridge.ensureRegistration();
    const origin = f.bridge.getSyncTargetId(); f.bridge.generation = 'connected-a';
    const entry = { targetId: origin, owner, command: { commandId: 'running-command', claimId: 'claim', claimToken: 'secret',
      claimUntil: new Date(Date.now() + 60000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
      statusVersion: '2', status: 'claimed', type: 'send_message' }, localSessionId: 'local', remoteSessionId: 'remote-local',
      runId: 'run', state: 'prepared', result: null };
    f.store.put(`inbox:${origin}:running-command`, entry);
    const started = deferred<void>(), finish = deferred<{ outcome: string }>();
    f.deps.execute.mockImplementation(async () => { started.resolve(); return finish.promise; });
    f.request.mockResolvedValueOnce(response({ status: 'received', statusVersion: '3' }));
    const execution = f.bridge.applyEntry(entry, 'connected-a'); await started.promise;
    f.switchRoute('https://other.example.com', targetB, 'desktop-b'); await f.bridge.ensureRegistration();
    f.request.mockClear(); finish.resolve({ outcome: 'started' }); await execution;
    expect(f.store.get(`inbox:${origin}:running-command`)).toMatchObject({ targetId: origin, state: 'applied' });
    expect(f.request).not.toHaveBeenCalled();
    await expect(f.bridge.ack(entry, 'applied')).rejects.toThrow('another synchronization target');
    expect(f.deps.execute).toHaveBeenCalledOnce();
  });
  it('waits for pending target negotiation before completing a concurrent registration request', async () => {
    const f = fixture(); f.seed(); const original = f.request.getMockImplementation()!;
    const started = deferred<void>(), release = deferred<void>();
    f.request.mockImplementation(async (actor, pathname, init) => {
      if (pathname.includes('/sync/state?')) { started.resolve(); await release.promise; }
      return original(actor, pathname, init);
    });
    const first = f.bridge.ensureRegistration(); await started.promise;
    let completed = false;
    const second = f.bridge.ensureRegistration().then(() => { completed = true; });
    await Promise.resolve(); expect(completed).toBe(false);
    release.resolve(); await Promise.all([first, second]); expect(completed).toBe(true);
  });
  it('discovers the target even with a legacy disabled preference, then keeps synchronization disabled', async () => {
    const f = fixture();
    f.store.put('settings:10001:personal', { enabled: false, name: 'Disabled', workspaces: [], settingsVersion: '1' });
    const connect = vi.spyOn(f.bridge, 'connect').mockResolvedValue(undefined);
    await f.bridge.tick();
    expect(f.bridge.getSyncTargetId()).not.toBeNull();
    expect(f.bridge.state().enabled).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });
  it('applies settings saved during discovery to that target without changing the previous service', async () => {
    const f = fixture(); await f.bridge.ensureRegistration();
    f.switchRoute('https://other.example.com', targetB, 'desktop-b');
    await f.bridge.configure({ enabled: false, name: 'Only B' });
    await f.bridge.ensureRegistration();
    expect(f.bridge.state()).toMatchObject({ enabled: false, name: 'Only B' });
    f.switchRoute('https://first.example.com', targetA, 'desktop'); await f.bridge.ensureRegistration();
    expect(f.bridge.state()).toMatchObject({ enabled: true, name: 'desktop.local' });
  });
  it('sends target headers on protected requests but not discovery', async () => {
    const f = fixture(); await f.bridge.ensureRegistration(); await f.bridge.api('/devices/desktop/settings');
    for (const [, pathname, init] of f.request.mock.calls) {
      const headers = new Headers(init.headers);
      expect(headers.get(RemoteSyncTarget.SpaceHeader)).toBe(pathname.endsWith('/capabilities') ? null : targetA.dataSpaceId);
    }
  });
  it('rejects registration from another data space before activating a work set', async () => {
    const f = fixture(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((actor, pathname, init) => pathname.endsWith('/devices/register')
      ? Promise.resolve(response({ ...owner, deviceId: 'desktop', metadataVersion: '1', syncTarget: targetB })) : original(actor, pathname, init));
    await expect(f.bridge.ensureRegistration()).rejects.toThrow('does not match discovery');
    expect(f.bridge.getSyncTargetId()).toBeNull();
  });
});
