import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import { availabilityControlSnapshot } from './remoteAvailabilitySource';
import { RemoteStore } from './remoteStore';

const databases: Database.Database[] = [];
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false });
  store.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES('task','Task',1,1,'idle',NULL,NULL)").run();
    store.assignNew('task', { userId: 'owner', scopeKey: 'personal' }, 'local_create');
  });
  return { db, store };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('target-scoped control facts', () => {
  test('ignores valid foreign runs and decisions before checking required current evidence', () => {
    const { store } = fixture();
    store.put('syncTargetHistory:task', { targetId: 'target-a', runIds: ['foreign-run'] });
    store.put('approval:task:foreign-approval', { approvalId: 'foreign-approval', runId: 'foreign-run', status: 'expired', approvalVersion: '2' });
    const snapshot = availabilityControlSnapshot(store, 'task', ['foreign-run'], true, { approvalIds: ['foreign-approval'] }, { incremental: true });
    expect(snapshot.records.map(record => record.eventType)).toEqual(['session.upsert']);
    expect(() => availabilityControlSnapshot(store, 'task', ['missing-current-run'], false, {}, { incremental: true }))
      .toThrow('REMOTE_CONTROL_CORE_RUN_MISSING');
    expect(() => availabilityControlSnapshot(store, 'task', [], false, { approvalIds: ['missing-current-approval'] }, { incremental: true }))
      .toThrow('REMOTE_CONTROL_DECISION_EVIDENCE_MISSING');
  });

  test('reconciles a deleted message from durable source after another target consumed pending', () => {
    const { db, store } = fixture();
    db.prepare("INSERT INTO remote_live_revisions VALUES('task','deleted-message',7,1)").run();
    db.prepare("DELETE FROM remote_control_pending WHERE session_id='task'").run();
    const snapshot = availabilityControlSnapshot(store, 'task', [], false, { deletedMessageIds: ['deleted-message'] }, { incremental: true });
    expect(snapshot.records).toContainEqual({ eventType: 'message.deleted', payload: { messageId: 'deleted-message', sourceObjectRevision: '7' } });
  });

  test('includes every required deletion even when sixteen pending IDs sort before it', () => {
    const { db, store } = fixture();
    const pending = Array.from({ length: 16 }, (_, index) => `a-${String(index).padStart(2, '0')}`);
    const required = Array.from({ length: 4 }, (_, index) => `z-${index}`);
    for (const id of [...pending, ...required]) db.prepare("INSERT INTO remote_live_revisions VALUES('task',?,7,1)").run(id);
    for (const id of pending) db.prepare("INSERT INTO remote_control_pending VALUES('task',?,1)").run(`message.deleted:${id}`);
    const snapshot = availabilityControlSnapshot(store, 'task', [], true, { deletedMessageIds: required }, { incremental: true });
    expect(snapshot.records.filter(record => record.eventType === 'message.deleted').map(record => record.payload.messageId)).toEqual([...pending, ...required]);
    expect(() => availabilityControlSnapshot(store, 'task', [], true, { deletedMessageIds: ['missing'] }, { incremental: true }))
      .toThrow('REMOTE_CONTROL_DELETION_EVIDENCE_MISSING');
  });

  test('prioritizes required history deletions within its budget and distinguishes overflow from missing evidence', () => {
    const { db, store } = fixture();
    const pending = Array.from({ length: 24 }, (_, index) => `a-${String(index).padStart(2, '0')}`);
    const required = Array.from({ length: 4 }, (_, index) => `z-${index}`);
    for (const id of [...pending, ...required]) db.prepare("INSERT INTO remote_live_revisions VALUES('task',?,7,1)").run(id);
    for (const id of pending) db.prepare("INSERT INTO remote_control_pending VALUES('task',?,1)").run(`message.deleted:${id}`);
    const snapshot = availabilityControlSnapshot(store, 'task', [], true, { deletedMessageIds: required });
    const ids = snapshot.records.filter(record => record.eventType === 'message.deleted').map(record => record.payload.messageId);
    expect(ids).toHaveLength(24); expect(required.every(id => ids.includes(id))).toBe(true);
    expect(() => availabilityControlSnapshot(store, 'task', [], true, { deletedMessageIds: [...pending, required[0]] }))
      .toThrow('REMOTE_CONTROL_CHECKPOINT_BUDGET');
    expect(() => availabilityControlSnapshot(store, 'task', [], true, { deletedMessageIds: ['missing'] }))
      .toThrow('REMOTE_CONTROL_DELETION_EVIDENCE_MISSING');
  });
});
