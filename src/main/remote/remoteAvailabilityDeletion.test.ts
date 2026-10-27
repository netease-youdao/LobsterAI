import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';

import { payloadHash } from './canonical';
import { acknowledgeAvailabilityDeletion, availabilityDeletion, deletionRequestHash } from './remoteAvailabilityDeletion';
import type { AvailabilityContext } from './remoteAvailabilityPublisher';
import type { AvailabilityRequest, AvailabilitySession } from './remoteAvailabilityStore';
import { RemoteDeletionProtocol, RemoteDeletionSyncKind } from './remoteDeletionSyncPolicy';
import { readRemoteDeletionSync, reconcileRemoteDeletionSync } from './remoteDeletionSyncState';
import { recordRemoteSessionDeletion, type Tombstone } from './remoteLocalGc';
import { RemoteStore } from './remoteStore';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
test('a control target deletes at its own frozen watermark without replacing the other target legacy ACK', () => {
  const db = new Database(':memory:'); databases.push(db);
  db.exec('CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT); CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER)');
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false }), owner = { userId: 'owner', scopeKey: 'personal' };
  store.transaction(() => { db.prepare("INSERT INTO cowork_sessions VALUES ('local','title',1,1,'idle')").run(); store.assignNew('local', owner, 'local_create'); });
  db.prepare("UPDATE remote_sync SET device_id='device-b',session_id='remote-b',sync_environment='target-b',stream_epoch='stream-b',source_seq=116,ack_seq=116 WHERE local_id='local'").run();
  store.transaction(() => { recordRemoteSessionDeletion(store, 'local', 1000); db.prepare("DELETE FROM cowork_sessions WHERE id='local'").run(); });
  const original = { ...store.get<Tombstone>('localGcDeleted:local')!, ackAt: 2000, ackSourceSeq: 117 };
  store.put('localGcDeleted:local', original);
  db.prepare("UPDATE remote_sync SET device_id='device-a',session_id='remote-a',sync_environment='target-a',stream_epoch='stream-a',source_seq=10,ack_seq=8 WHERE local_id='local'").run();
  const context: AvailabilityContext = { environment: 'target-a', scope: 'target-a:owner:personal:device-a', owner, deviceId: 'device-a', generation: '1', supported: true };
  const state: AvailabilitySession = { scope: context.scope, localId: 'local', sessionId: 'remote-a', writerGeneration: 'writer-a', controlEpoch: 'control-a',
    operationId: 'operation-a', phase: 'active', pendingCommandIds: [], pendingRunIds: [], controlRevision: '1', factSeq: '3', records: {} };
  const deletion = availabilityDeletion(store, context, state)!;
  expect(deletion).toMatchObject({ sessionId: 'remote-a', sourceHighWatermark: 10, ackAt: null, ackSourceSeq: null });
  const request = { body: { batchId: 'batch-a', sessionId: state.sessionId, writerGeneration: state.writerGeneration, controlEpoch: state.controlEpoch,
    facts: [{ eventType: 'session.deleted', eventId: deletion.deleteEventId, factSeq: '4', payload: { deletedAt: new Date(1000).toISOString() } }] } } as AvailabilityRequest;
  const receipt = { state: 'committed', operationId: 'batch-a', batchId: 'batch-a', sessionId: state.sessionId,
    writerGeneration: state.writerGeneration, controlEpoch: state.controlEpoch, requestHash: deletionRequestHash(request), firstFactSeq: '4', lastFactSeq: '4', committedSeq: '42',
    deletionReceipts: [{ eventId: deletion.deleteEventId, factSeq: '4', deletedAt: new Date(1000).toISOString(), serverSeq: '42' }] };
  acknowledgeAvailabilityDeletion(store, context, state, request, receipt);
  expect(readRemoteDeletionSync(store, 'local', { ...context, targetId: 'target-a' })).toMatchObject({ kind: RemoteDeletionSyncKind.Settled, protocol: RemoteDeletionProtocol.Control });
  expect(store.get('localGcDeleted:local')).toEqual(original);
  expect(store.sync('local')).toMatchObject({ source_seq: 10, ack_seq: 8 });
  const proof = db.prepare('SELECT evidence_digest,evidence_json FROM remote_session_deletion_sync').get() as { evidence_digest: string; evidence_json: string };
  expect(proof.evidence_digest).toBe(payloadHash(JSON.parse(proof.evidence_json)));
  reconcileRemoteDeletionSync(store, 'local', { ...context, targetId: 'target-a' });
  expect(availabilityDeletion(store, context, state)?.availabilityAck?.batchId).toBe('batch-a');
});
