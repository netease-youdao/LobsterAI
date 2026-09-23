import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteCapability } from '../../shared/remote/constants';
import { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteReplyCapability } from '../../shared/remote/reply';
import { RemoteRetention } from '../../shared/remote/retention';
import { RemoteBridge } from './remoteBridge';
import { retentionEventId, safeSourceSequence } from './remoteRetention';
import { RemoteStore } from './remoteStore';

const owner = { userId: '10001', scopeKey: 'personal' };
const epoch = '11111111-2222-4333-8444-555555555555';
const databases: Database.Database[] = [];
const directories: string[] = [];
const bridges: RemoteBridge[] = [];
function fixture(file = ':memory:') {
  const db = new Database(file); databases.push(db);
  db.exec(`CREATE TABLE IF NOT EXISTS cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE IF NOT EXISTS cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db); store.setEnabledOwner(owner); store.setWake(() => {});
  return store;
}
function create(store: RemoteStore, id = 'local') {
  store.transaction(() => {
    store.db.prepare("INSERT INTO cowork_sessions VALUES (?, 'Task',1,1,'idle')").run(id);
    store.assignNew(id, owner, 'local_create');
  });
  store.bindRemote(id, store.sync(id)!.session_id, 'desktop');
}
function activated(store: RemoteStore) {
  const row = store.sync('local')!;
  store.transaction(() => {
    store.applyRetentionAck('local', { syncProtocolVersion: 2, streamEpoch: epoch, sourcePurgeSeq: String(row.source_seq), eventPurgeSeq: '0' }, true);
    store.acknowledge('local', 'desktop', row.session_id, String(row.source_seq), '1', true);
  });
}
function update(store: RemoteStore, title = 'Changed') { store.transaction(() => store.db.prepare('UPDATE cowork_sessions SET title=? WHERE id=?').run(title, 'local')); }
function bridgeFixture() {
  const store = fixture(); create(store);
  const execute = vi.fn();
  const request = vi.fn();
  const bridge: any = new RemoteBridge({ store, identity: { installationId: 'i', deviceKey: 'secret', databaseId: 'db' },
    runSessionTransaction: operation => store.transaction(operation), getOwner: () => owner,
    getEnvironment: () => RemoteEnvironment.Test, getApiBaseUrl: () => 'https://example.com', request, execute, prepare: vi.fn(), onAccountChange: vi.fn(),
    metadata: { name: 'Desktop', hostName: 'host', platform: 'macos', appVersion: '1', instanceLabel: 'default' },
  });
  bridge.owner = owner; bridge.registration = { deviceId: 'desktop', ...owner, metadataVersion: '1' };
  bridge.generation = '1'; bridge.retentionSupported = true; bridge.fenceCheckedAt = Date.now();
  store.setWake(() => {}); bridges.push(bridge);
  return { store, bridge, request, execute };
}
function response(data: unknown, code = 0, status = 200) { return new Response(JSON.stringify({ code, data }), { status }); }
function receipt(store: RemoteStore, state = 'committed') {
  const saved = store.get<any>('import:local')!;
  return { importId: saved.importId, sessionId: saved.sessionId, syncProtocolVersion: 2, targetStreamEpoch: epoch,
    ...(state === 'committed' ? { streamEpoch: epoch, committedSourceSeq: saved.baseSourceSeq, committedSeq: '5', sourcePurgeSeq: saved.baseSourceSeq, eventPurgeSeq: '0' } : {}),
    manifestHash: saved.manifest.manifestHash, state, stateVersion: '1', partsExpired: state === 'committed' };
}
function state(store: RemoteStore, lastSourceSeq?: string) {
  const row = store.sync('local')!;
  return { deviceId: 'desktop', sessionId: row.session_id, localSessionId: 'local', syncProtocolVersion: row.sync_protocol_version,
    streamEpoch: row.stream_epoch, lastSourceSeq: lastSourceSeq || String(row.ack_seq), lastSeq: row.server_seq,
    sourcePurgeSeq: row.source_purge_seq, eventPurgeSeq: row.event_purge_seq, activeImport: null };
}
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.stop();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('retention protocol persistence', () => {
  it('matches the cross-language event identity and rejects imprecise/noncanonical sequences', () => {
    expect(retentionEventId('dev_pc_demo', 'session_demo', epoch, '42')).toBe('e2_Vck7wl6vbphlOngJDSFvQ7SOBxpXFWIcksQ-bmHRztU');
    expect(() => safeSourceSequence('01')).toThrow();
    expect(() => safeSourceSequence('9007199254740992')).toThrow();
  });
  it('preserves frozen dirty records across transactions and restart without wake loops', () => {
    const dir = mkdtempSync(join(tmpdir(), 'retention-')); directories.push(dir);
    const file = join(dir, 'db.sqlite'); let store = fixture(file); create(store);
    const source = store.sync('local')!.source_seq;
    store.transaction(() => store.freezeMigration('local'));
    const wake = vi.fn(); store.setWake(wake); update(store);
    store.transaction(() => {});
    expect(store.sync('local')!.source_seq).toBe(source); expect(wake).not.toHaveBeenCalled();
    store.db.close(); store = fixture(file);
    expect(store.sync('local')!.migration_frozen).toBe(1);
    expect(store.db.prepare('SELECT * FROM remote_content_dirty').all()).toHaveLength(1);
    store.transaction(() => {
      store.applyRetentionAck('local', { syncProtocolVersion: 2, streamEpoch: epoch, sourcePurgeSeq: String(source), eventPurgeSeq: '0' }, true);
      store.acknowledge('local', 'desktop', store.sync('local')!.session_id, String(source), '1', true);
      store.unfreezeMigration('local');
    });
    const next = store.pending('local')[0];
    expect(next.sourceSeq).toBe(String(source + 1));
    expect(next.eventId).toBe(retentionEventId('desktop', store.sync('local')!.session_id, epoch, next.sourceSeq));
    expect(next.payload.session.title).toBe('Changed');
    expect(store.db.prepare('SELECT * FROM remote_content_dirty').all()).toHaveLength(0);
  });
  it('does not reimport unchanged confirmed projection on ten process restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'retention-mode-')); directories.push(dir);
    const file = join(dir, 'db.sqlite'); let store = fixture(file); create(store);
    store.setProjectionIdentity(RemoteEnvironment.Test, owner, 'desktop'); store.setReplyProjectionSupported(true);
    const row = store.sync('local')!; store.acknowledge('local', 'desktop', row.session_id, String(row.source_seq), '1', true);
    for (let i = 0; i < 10; i++) {
      store.db.close(); store = fixture(file);
      store.setProjectionIdentity(RemoteEnvironment.Test, owner, 'desktop'); store.setReplyProjectionSupported(true);
      expect(store.sync('local')!.needs_snapshot).toBe(0);
    }
  });
  it('limits a real projection change to the active account', () => {
    const store = fixture(); create(store); create(store, 'other');
    store.db.prepare("UPDATE cowork_session_ownership SET owner_user_id='20002' WHERE session_id='other'").run();
    store.db.prepare('UPDATE remote_sync SET needs_snapshot=0').run();
    store.setProjectionIdentity(RemoteEnvironment.Test, owner, 'desktop'); store.setReplyProjectionSupported(true);
    expect(store.sync('local')!.needs_snapshot).toBe(1); expect(store.sync('other')!.needs_snapshot).toBe(0);
  });
  it('rejects an old epoch ACK atomically without clearing the outbox', () => {
    const store = fixture(); create(store); activated(store); update(store);
    const pending = store.pending('local');
    expect(() => store.transaction(() => {
      store.applyRetentionAck('local', { syncProtocolVersion: 2, streamEpoch: 'other', sourcePurgeSeq: '0', eventPurgeSeq: '0' });
      store.acknowledge('local', 'desktop', store.sync('local')!.session_id, String(store.sync('local')!.source_seq), '2');
    })).toThrow();
    expect(store.pending('local')).toEqual(pending);
  });
});

describe('retention bridge recovery', () => {
  it('does not downgrade confirmed modes during account initialization or ten WS negotiations', async () => {
    const { store, bridge, request } = bridgeFixture();
    request.mockImplementation(async () => response({ enabled: true, protocolVersions: [1], projectionVersions: [1, 4], capabilities: [RemoteCapability.SameAccountAccess, RemoteReplyCapability] }));
    await bridge.refreshCapabilities();
    const row = store.sync('local')!; store.acknowledge('local', 'desktop', row.session_id, String(row.source_seq), '1', true);
    for (let i = 0; i < 10; i++) { bridge.disconnect(); await bridge.refreshCapabilities(); expect(store.sync('local')!.needs_snapshot).toBe(0); }
    bridge.owner = null; bridge.ensureAccount();
    expect(store.sync('local')!.needs_snapshot).toBe(0);
    bridge.registration = { deviceId: 'desktop', ...owner, metadataVersion: '1' };
    await bridge.refreshCapabilities(); expect(store.sync('local')!.needs_snapshot).toBe(0);
  });

  for (const lostAt of ['begin', 'commit'] as const) it(`resumes the same import after lost ${lostAt} ACK and projects frozen changes only after activation`, async () => {
    const { store, bridge, request, execute } = bridgeFixture();
    let failed = false; let committed = false;
    request.mockImplementation(async (_actor, path: string) => {
      if (path.includes('/sync/state?')) return response({ reason: 'SYNC_STATE_NOT_FOUND' }, RemoteRetention.StateMissingCode, 404);
      if (path.endsWith('/sync/imports')) {
        if (lostAt === 'begin' && !failed) { failed = true; throw new TypeError('fetch failed'); }
        return response(receipt(store, committed ? 'committed' : 'uploading'));
      }
      if (path.includes('/parts/')) return response({});
      if (path.endsWith('/commit')) {
        committed = true;
        if (lostAt === 'commit' && !failed) { failed = true; throw new TypeError('fetch failed'); }
        return response(receipt(store));
      }
      throw new Error(path);
    });
    await expect(bridge.syncSessions()).resolves.toBeUndefined();
    const saved = store.get<any>('import:local')!; const old = store.pending('local');
    expect(store.sync('local')!.migration_frozen).toBe(1); update(store);
    expect(store.pending('local')).toEqual(old);
    store.db.prepare("UPDATE remote_sync_task_state SET next_retry_at=0,server_retry_at=0 WHERE local_session_id='local'").run();
    await bridge.syncSessions();
    const beginCalls = request.mock.calls.filter(call => call[1].endsWith('/sync/imports'));
    expect(beginCalls.map(call => JSON.parse(String(call[2].body)).importId)).toEqual([saved.importId, saved.importId]);
    expect(store.sync('local')!.stream_epoch).toBe(epoch); expect(store.sync('local')!.migration_frozen).toBe(0);
    expect(store.get('import:local')).toBeNull(); expect(store.pending('local')[0].sourceSeq).toBe(String(Number(saved.baseSourceSeq) + 1));
    expect(execute).not.toHaveBeenCalled();
  });
  it('turns an expired source window into a snapshot without advancing ACK from GET state', async () => {
    const { store, bridge, request } = bridgeFixture(); activated(store); update(store);
    const before = store.sync('local')!;
    request.mockImplementation(async (_actor, path: string) => path.endsWith('/sync/batches')
      ? response({ reason: 'RESYNC_REQUIRED', reasonDetail: RemoteRetention.SourceExpired }, RemoteRetention.ResyncCode, 409)
      : response(state(store)));
    await bridge.syncSessions();
    expect(store.sync('local')!.needs_snapshot).toBe(1);
    expect(store.sync('local')!.ack_seq).toBe(before.ack_seq); expect(store.pending('local').length).toBeGreaterThan(0);
    expect(store.sync('local')!.stream_epoch).toBe(epoch);
  });
  it('blocks server-ahead history locally and does not create a new import', async () => {
    const { store, bridge, request } = bridgeFixture();
    request.mockResolvedValue(response(state(store, '999')));
    await bridge.syncSessions();
    expect(store.get<any>('syncFailure:local')!.blocked).toBe(true);
    expect(store.get('import:local')).toBeNull(); expect(request).toHaveBeenCalledTimes(1);
    await bridge.syncSessions(); expect(request).toHaveBeenCalledTimes(1);
  });
  it('ignores missing execution payloads in terminal compacted receipts', async () => {
    const { bridge, request, execute } = bridgeFixture();
    request.mockResolvedValue(response({ items: [{ command: { commandId: 'old', type: 'create_session', status: 'applied', statusVersion: '4', detailState: RemoteRetention.Compacted } }], nextCursor: null }));
    await bridge.reconcile();
    expect(request).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled();
  });
  it('preserves an active v2 stream when the new-migration flag is off', async () => {
    const { store, bridge, request } = bridgeFixture(); activated(store); update(store); bridge.retentionSupported = false;
    request.mockImplementation(async (_actor, path: string, init: RequestInit) => {
      if (path.includes('/sync/state?')) return response(state(store));
      const body = JSON.parse(String(init.body));
      expect(body.syncProtocolVersion).toBe(2); expect(body.streamEpoch).toBe(epoch);
      const row = store.sync('local')!;
      return response({ batchId: body.batchId, deviceId: 'desktop', sessionId: row.session_id, syncProtocolVersion: 2, streamEpoch: epoch,
        committedSourceSeq: body.events.at(-1).sourceSeq, committedSeq: '2', sourcePurgeSeq: row.source_purge_seq, eventPurgeSeq: '0' });
    });
    await bridge.syncSessions();
    expect(store.pending('local')).toEqual([]); expect(store.sync('local')!.stream_epoch).toBe(epoch);
  });
  it('blocks a migrated session when an old server cannot recognize its state endpoint', async () => {
    const { store, bridge, request } = bridgeFixture(); activated(store); update(store); bridge.retentionSupported = false;
    request.mockImplementation(async () => response({}, 404, 404));
    await bridge.syncSessions();
    expect(store.get<any>('syncFailure:local')!.blocked).toBe(true);
    expect(store.pending('local').length).toBeGreaterThan(0); expect(store.sync('local')!.sync_protocol_version).toBe(2);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('uses the terminal parent receipt when import parts expire during upload', async () => {
    const { store, bridge, request, execute } = bridgeFixture();
    request.mockImplementation(async (_actor, path: string) => {
      if (path.includes('/sync/state?')) return response({ reason: 'SYNC_STATE_NOT_FOUND' }, RemoteRetention.StateMissingCode, 404);
      if (path.endsWith('/sync/imports')) return response(receipt(store, 'uploading'));
      if (path.includes('/parts/')) return response({ reason: 'IMPORT_STATE_CONFLICT', reasonDetail: 'IMPORT_PARTS_EXPIRED' }, 47025, 409);
      if (path.includes('/sync/imports/')) return response(receipt(store));
      throw new Error(path);
    });
    await bridge.syncSessions();
    expect(store.sync('local')!.stream_epoch).toBe(epoch); expect(store.get('import:local')).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
  it('waits for server fence blockers instead of deleting unavailable legacy sessions', async () => {
    const { store, bridge, request } = bridgeFixture(); activated(store); bridge.fenceCheckedAt = 0;
    request.mockResolvedValue(response({ deviceId: 'desktop', minSyncProtocolVersion: 1, syncProtocolFenceVersion: '0', blockers: [{ sessionId: 'not-on-this-disk' }] }));
    await bridge.ensureRetentionFence();
    expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0][2].method).toBe('GET');
  });
});
