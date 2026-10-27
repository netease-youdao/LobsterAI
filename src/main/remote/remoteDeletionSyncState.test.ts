import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import { payloadHash } from './canonical';
import { RemoteDeletionProtocol, RemoteDeletionSyncKind as Kind, RemoteDeletionSyncState } from './remoteDeletionSyncPolicy';
import { hasRemoteDeletionAdoption, initializeRemoteDeletionSync, isRemoteDeletionSettled, readRemoteDeletionSync, reconcileRemoteDeletionSync,
  rememberRemoteDeletionAdoption, remoteDeletionTombstoneForBinding } from './remoteDeletionSyncState';
import { acknowledgeRemoteSessionDeletion, recordRemoteSessionDeletion, type Tombstone } from './remoteLocalGc';
import { RemoteStore } from './remoteStore';

const owner = { userId: 'test-owner', scopeKey: 'personal' };
const context = { owner, targetId: 'target-a', deviceId: 'device-a' };
const databases: Database.Database[] = [];
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec('CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT); CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER)');
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false });
  initializeRemoteDeletionSync(db);
  store.transaction(() => { db.prepare("INSERT INTO cowork_sessions VALUES ('local','title',1,1,'idle')").run(); store.assignNew('local', owner, 'local_create'); });
  db.prepare("UPDATE remote_sync SET session_id='remote-a',device_id='device-a',sync_environment='target-a',stream_epoch='stream-a',source_seq=116,ack_seq=116,needs_snapshot=0 WHERE local_id='local'").run();
  store.transaction(() => { recordRemoteSessionDeletion(store, 'local', 1000); db.prepare("DELETE FROM cowork_sessions WHERE id='local'").run(); });
  const tombstone = { ...store.get<Tombstone>('localGcDeleted:local')!, deleteRevision: 287, ackAt: 2000, ackSourceSeq: 117 };
  store.put('localGcDeleted:local', tombstone);
  db.prepare("UPDATE remote_sync SET source_seq=117,ack_seq=117,needs_snapshot=1 WHERE local_id='local'").run();
  const projection = JSON.stringify({ eventType: 'session.deleted', payload: { deletedAt: new Date(1406).toISOString() } });
  db.prepare('INSERT INTO remote_projection VALUES(?,?,?,?,?)').run('local', 'deleted', 'hash', 1, projection);
  return { db, store, tombstone, projection, result: () => reconcileRemoteDeletionSync(store, 'local', context) };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('target-scoped deletion evidence', () => {
  test('migrates the original 117/116 ACK without regenerating the legacy event, time, or sequence', () => {
    const f = fixture();
    expect(isRemoteDeletionSettled(f.store, 'local', context)).toBe(false);
    expect(f.result()).toMatchObject({ kind: Kind.Settled, protocol: RemoteDeletionProtocol.Legacy });
    expect(isRemoteDeletionSettled(f.store, 'local', context)).toBe(true);
    expect(f.store.sync('local')).toMatchObject({ source_seq: 117, ack_seq: 117, needs_snapshot: 0 });
    expect(f.store.get('localGcDeleted:local')).toEqual(f.tombstone);
    expect(f.db.prepare("SELECT record_json,revision FROM remote_projection WHERE object_key='deleted'").get()).toEqual({ record_json: f.projection, revision: 1 });
    expect(f.store.get('deletionClosed:local')).toBeNull();
    const before = f.db.prepare('SELECT evidence_digest,validated_at FROM remote_session_deletion_sync').get();
    f.result();
    expect(f.db.prepare('SELECT evidence_digest,validated_at FROM remote_session_deletion_sync').get()).toEqual(before);
  });
  test.each(['projection', 'ack', 'watermark', 'owner', 'recreated', 'corrupt-control', 'pending-import', 'pending-outbox'])(
    'does not accept incomplete or conflicting %s evidence', fault => {
      const f = fixture();
      if (fault === 'projection') f.db.prepare('DELETE FROM remote_projection').run();
      if (fault === 'ack') f.store.put('localGcDeleted:local', { ...f.tombstone, ackSourceSeq: null });
      if (fault === 'watermark') f.store.put('localGcDeleted:local', { ...f.tombstone, sourceHighWatermark: 118 });
      if (fault === 'owner') f.store.put('localGcDeleted:local', { ...f.tombstone, owner: { ...owner, userId: 'other' } });
      if (fault === 'recreated') f.db.prepare("INSERT INTO cowork_sessions VALUES ('local','recreated',1,1,'idle')").run();
      if (fault === 'corrupt-control') f.store.put('localGcDeleted:local', { ...f.tombstone, availabilityAck: { protocol: 'control_facts_v1' } });
      if (fault === 'pending-import') f.store.put('import:local', { state: 'uploading' });
      if (fault === 'pending-outbox') f.db.prepare('INSERT INTO remote_outbox VALUES(?,?,?)').run('local', 118, '{}');
      expect(f.result().kind).not.toBe(Kind.Settled);
      expect(f.store.sync('local')).toMatchObject({ source_seq: 117, ack_seq: 117, needs_snapshot: 1 });
      expect(isRemoteDeletionSettled(f.store, 'local', context)).toBe(false);
    });
  test.each(['device_id', 'stream_epoch', 'session_id', 'sync_environment'])('never carries an ACK across changed %s', field => {
    const f = fixture();
    f.db.prepare(`UPDATE remote_sync SET ${field}='different' WHERE local_id='local'`).run();
    expect(f.result().kind).not.toBe(Kind.Settled);
  });
  test('accepts full logical evidence despite a wall-clock rollback', () => {
    const f = fixture(); f.store.put('localGcDeleted:local', { ...f.tombstone, ackAt: 50 });
    expect(f.result().kind).toBe(Kind.Settled);
  });
  test('retains a core activation fence and does not downgrade after losing the sidecar', () => {
    const f = fixture();
    const binding = { scope: 'target-a:test-owner:personal:device-a', sessionId: 'remote-a', deviceId: 'device-a', writerGeneration: 'writer', controlEpoch: 'control' };
    rememberRemoteDeletionAdoption(f.store, 'local', context, binding);
    expect(f.result()).toMatchObject({ kind: Kind.ControlDelete, protocol: RemoteDeletionProtocol.Control });
    expect(isRemoteDeletionSettled(f.store, 'local', context)).toBe(false);
  });
  test('core adoption survives loss of sidecar state and is isolated from another target', () => {
    const f = fixture();
    const binding = { scope: 'target-a:test-owner:personal:device-a', sessionId: 'remote-a', deviceId: 'device-a', writerGeneration: 'writer', controlEpoch: 'control' };
    rememberRemoteDeletionAdoption(f.store, 'local', context, binding);
    const before = f.db.prepare('SELECT total_changes() AS n').get();
    expect(hasRemoteDeletionAdoption(f.store, 'local', context)).toBe(true);
    expect(hasRemoteDeletionAdoption(f.store, 'local', { ...context, targetId: 'target-b' })).toBe(false);
    expect(f.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    f.db.prepare("UPDATE remote_state SET value='{' WHERE key LIKE 'remoteDeletionAdoption:%'").run();
    expect(hasRemoteDeletionAdoption(f.store, 'local', context)).toBe(true);
    expect(f.result().kind).toBe(Kind.Blocked);
  });
  test('a retained history fence without its writer remains blocked', () => {
    const f = fixture(), manifest = { context: { scope: 'target-a:test-owner:personal:device-a', localId: 'local' }, legacy: f.store.sync('local') };
    f.db.prepare('INSERT INTO remote_history_migrations VALUES(?,?,?,?,?,?,?)').run('target-a:test-owner:personal:device-a', 'local', 'writer', 'migration', JSON.stringify(manifest), payloadHash(manifest), 'ready');
    expect(f.result()).toMatchObject({ kind: Kind.Blocked, protocol: RemoteDeletionProtocol.Control });
  });
  test('each target freezes its own watermark and confirms only its own original mapping', () => {
    const f = fixture(); f.result();
    const original = f.store.get<Tombstone>('localGcDeleted:local')!;
    f.db.prepare("UPDATE remote_sync SET sync_environment='target-b',device_id='device-b',session_id='remote-b',stream_epoch='stream-b',source_seq=10,ack_seq=10 WHERE local_id='local'").run();
    const b = { owner, targetId: 'target-b', deviceId: 'device-b' };
    expect(reconcileRemoteDeletionSync(f.store, 'local', b).kind).toBe(Kind.LegacyDelete);
    expect(remoteDeletionTombstoneForBinding(f.store, 'local', b)).toMatchObject({ sourceHighWatermark: 10, ackAt: null, ackSourceSeq: null });
    f.db.prepare("UPDATE remote_sync SET source_seq=11,ack_seq=11,needs_snapshot=0 WHERE local_id='local'").run();
    acknowledgeRemoteSessionDeletion(f.store, 'local', 3000);
    expect(isRemoteDeletionSettled(f.store, 'local', b)).toBe(true);
    expect(f.store.get('localGcDeleted:local')).toEqual(original);
    expect(f.db.prepare('SELECT target_id,pre_delete_source_seq,deletion_source_seq,state FROM remote_session_deletion_sync ORDER BY target_id').all()).toEqual([
      { target_id: 'target-a', pre_delete_source_seq: 116, deletion_source_seq: 117, state: RemoteDeletionSyncState.Acknowledged },
      { target_id: 'target-b', pre_delete_source_seq: 10, deletion_source_seq: 11, state: RemoteDeletionSyncState.Acknowledged },
    ]);
  });
  test('a new target without a mapping does not create a remote deletion shell', () => {
    const f = fixture(); f.db.prepare("DELETE FROM remote_sync WHERE local_id='local'").run();
    expect(f.result().kind).toBe(Kind.NotApplicable);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM remote_session_deletion_sync').get()).toEqual({ n: 0 });
  });
  test.each(['digest', 'budget', 'revision'])('rejects %s corruption without changing ACKs', corrupt => {
    const f = fixture(); f.result();
    if (corrupt === 'digest') f.db.prepare("UPDATE remote_session_deletion_sync SET evidence_digest='wrong'").run();
    if (corrupt === 'budget') f.db.prepare('UPDATE remote_session_deletion_sync SET evidence_json=?').run(' '.repeat(65537));
    if (corrupt === 'revision') f.store.put('localGcDeleted:local', { ...f.tombstone, deleteRevision: 288 });
    expect(readRemoteDeletionSync(f.store, 'local', context).kind).toBe(Kind.Blocked);
    expect(isRemoteDeletionSettled(f.store, 'local', context)).toBe(false);
    expect(f.store.sync('local')).toMatchObject({ source_seq: 117, ack_seq: 117 });
  });
  test('does not repair derived flags when the proof transaction fails', () => {
    const f = fixture(); f.db.exec("CREATE TRIGGER reject_proof BEFORE INSERT ON remote_session_deletion_sync BEGIN SELECT RAISE(ABORT,'disk failure'); END");
    expect(f.result).toThrow('disk failure');
    expect(f.store.sync('local')?.needs_snapshot).toBe(1);
    expect(isRemoteDeletionSettled(f.store, 'local', context)).toBe(false);
  });
  test('read-only classification never writes migration or repair state', () => {
    const f = fixture(), before = f.db.prepare('SELECT total_changes() AS n').get();
    readRemoteDeletionSync(f.store, 'local', context); isRemoteDeletionSettled(f.store, 'local', context);
    expect(f.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });
});
