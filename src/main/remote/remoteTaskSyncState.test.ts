import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { RemoteSyncTaskIssueStatus } from '../../shared/remote/constants';
import { RemoteTaskSyncState, type TaskSyncContext, TaskSyncFailureReason, TaskSyncPhase } from './remoteTaskSyncState';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const context: TaskSyncContext = { owner: { userId: 'owner', scopeKey: 'personal' }, target: 'target', deviceId: 'device' };
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT);
    CREATE TABLE cowork_session_ownership(session_id TEXT PRIMARY KEY,owner_user_id TEXT,owner_scope_key TEXT,ownership_status TEXT);
    CREATE TABLE remote_sync(local_id TEXT PRIMARY KEY,needs_snapshot INTEGER,source_seq INTEGER,ack_seq INTEGER);
    CREATE TABLE remote_session_revisions(session_id TEXT PRIMARY KEY,dirty_at INTEGER);
    CREATE TABLE remote_dirty(session_id TEXT PRIMARY KEY);
    CREATE TABLE remote_state(key TEXT PRIMARY KEY,value TEXT);`);
  let now = 0;
  const create = () => new RemoteTaskSyncState(db, () => now, () => 0);
  const state = create();
  const add = (id: string, owner = context.owner) => {
    db.prepare('INSERT INTO cowork_sessions VALUES (?,?)').run(id, `Title ${id}`);
    db.prepare('INSERT INTO cowork_session_ownership VALUES (?,?,?,?)').run(id, owner.userId, owner.scopeKey, 'confirmed');
    db.prepare('INSERT INTO remote_sync VALUES (?,1,0,0)').run(id);
  };
  return { db, state, create, add, now: () => now, at: (value: number) => { now = value; } };
}
const transport = { phase: TaskSyncPhase.Backoff, scope: 'service', reason: 'TRANSPORT' };

describe('task fault isolation persistence', () => {
  it('preserves failure counts through restart and state verification, then resets only on publication progress', () => {
    const f = fixture(); f.add('s');
    let state = f.state;
    for (let count = 1; count <= 5; count++) {
      const result = state.fail(context, 's', transport);
      expect(result.failure_count).toBe(count);
      expect(result.next_retry_at - f.now()).toBe([24000, 48000, 96000, 240000, 900000][count - 1]);
      f.at(result.next_retry_at); state = f.create();
    }
    const before = state.get(context, 's')!;
    expect(before.phase).toBe(TaskSyncPhase.Cooldown);
    expect(state.manualRetry(context, 's')).toBe(true);
    state.resumeAfterVerification(context, 's');
    expect(state.get(context, 's')).toMatchObject({ phase: TaskSyncPhase.Ready, failure_count: 5, last_progress_at: 0 });
    state.progress(context, 's');
    expect(state.get(context, 's')).toMatchObject({ failure_count: 0, last_progress_at: f.now() });
  });
  it('honors the server lower bound across manual retry, defer and restart without clamping large valid waits', () => {
    const f = fixture(); f.add('s');
    const wait = 100 * 24 * 60 * 60 * 1000;
    f.state.fail(context, 's', { ...transport, retryAfterMs: wait });
    f.state.defer(context, 's', 1);
    const state = f.create();
    expect(state.get(context, 's')).toMatchObject({ next_retry_at: wait, server_retry_at: wait });
    expect(state.manualRetry(context, 's')).toBe(false);
    expect(state.candidates(context)).toHaveLength(0);
    f.at(wait - 1); expect(state.eligible(context, 's')).toBe(false);
    f.at(wait); expect(state.manualRetry(context, 's')).toBe(true);
  });
  it('migrates an older task ledger without shortening its existing retry deadline', () => {
    const f = fixture(); f.add('s');
    const value = f.state.fail(context, 's', transport);
    f.db.exec('ALTER TABLE remote_sync_task_state DROP COLUMN server_retry_at');
    f.db.exec('UPDATE remote_sync_task_state SET manual_retry_at=0');
    const migrated = f.create();
    expect(migrated.get(context, 's')).toMatchObject({ server_retry_at: value.next_retry_at, manual_retry_at: -1 });
    expect(migrated.manualRetry(context, 's')).toBe(false);
    f.at(value.next_retry_at); expect(migrated.manualRetry(context, 's')).toBe(true);
    expect(f.create().manualRetry(context, 's')).toBe(false);
  });
  it('enforces the exact manual retry boundary, including a first retry at time zero', () => {
    const f = fixture(); f.add('s');
    expect(f.state.manualRetry(context, 's')).toBe(true);
    expect(f.create().manualRetry(context, 's')).toBe(false);
    f.at(59999); expect(f.state.manualRetry(context, 's')).toBe(false);
    f.at(60000); expect(f.state.manualRetry(context, 's')).toBe(true);
  });
  it('never reopens a closed stream through late progress, failure, repair or manual retry', () => {
    const f = fixture(); f.add('s');
    f.state.fail(context, 's', { phase: TaskSyncPhase.Closed, scope: 'session', reason: 'SESSION_DELETED' });
    f.state.progress(context, 's', true); f.state.fail(context, 's', transport); f.state.resumeAfterVerification(context, 's');
    expect(f.state.get(context, 's')!.phase).toBe(TaskSyncPhase.Closed);
    expect(f.state.reserveRepair(context, 's', 'broken')).toBe(false);
    expect(f.state.manualRetry(context, 's')).toBe(false);
    expect(f.state.health(context).taskIssues).toEqual([]);
  });
  it('keeps unresolved repair keys beyond 24 hours and never evicts them to grant another repair', () => {
    const f = fixture(); f.add('s');
    expect(f.state.reserveRepair(context, 's', 'same-object')).toBe(true);
    expect(f.create().reserveRepair(context, 's', 'same-object')).toBe(false);
    expect(f.state.reserveRepair(context, 's', 'second-object')).toBe(true);
    expect(f.state.reserveRepair(context, 's', 'third-object')).toBe(false);
    f.at(86400001);
    expect(f.state.reserveRepair(context, 's', 'same-object')).toBe(false);
    for (let index = 2; index < 8; index++) {
      f.at(Math.floor(index / 2) * 86400001);
      expect(f.state.reserveRepair(context, 's', `object-${index}`)).toBe(true);
    }
    f.at(10 * 86400001);
    expect(f.state.reserveRepair(context, 's', 'ninth-object')).toBe(false);
    expect(JSON.parse(f.state.get(context, 's')!.repair_json).attempts).toHaveLength(8);
  });
  it('does not clear repair budgets during verification or authorize repair with a damaged ledger', () => {
    const f = fixture(); f.add('s');
    f.state.reserveRepair(context, 's', 'original');
    const original = f.state.get(context, 's')!.repair_json;
    expect(f.state.manualRetry(context, 's')).toBe(true); f.state.resumeAfterVerification(context, 's');
    expect(f.state.get(context, 's')!.repair_json).toBe(original);
    f.db.prepare('UPDATE remote_sync_task_state SET repair_json=?').run('{broken');
    f.at(60000);
    expect(f.state.reserveRepair(context, 's', 'different')).toBe(false);
    expect(f.state.manualRetry(context, 's')).toBe(false);
    f.state.progress(context, 's', true);
    expect(f.state.get(context, 's')!.repair_json).toBe('{broken');
  });
  it('isolates impossible retry waits instead of silently shortening them', () => {
    const f = fixture();
    for (const [index, value] of [NaN, -1, Infinity, Number.MAX_SAFE_INTEGER].entries()) {
      const id = `s${index}`; f.add(id); f.at(1);
      const result = f.state.fail(context, id, { ...transport, retryAfterMs: value });
      expect(result).toMatchObject({ phase: TaskSyncPhase.Isolated, reason: TaskSyncFailureReason.RetryHintInvalid });
      expect(f.state.manualRetry(context, id)).toBe(false);
    }
  });
  it('schedules clean legacy tasks that still need admission or failure migration without touching corrupt operation JSON', () => {
    const f = fixture();
    f.db.exec(`CREATE TABLE remote_sync_session_admissions(target_id TEXT,owner_user_id TEXT,owner_scope_key TEXT,device_id TEXT,local_session_id TEXT,admission TEXT);
      CREATE TABLE remote_sync_admission_evidence(archive_id TEXT,table_name TEXT,row_key TEXT);
      CREATE TABLE remote_sync_targets(target_id TEXT,owner_user_id TEXT,owner_scope_key TEXT);`);
    f.db.prepare('INSERT INTO remote_sync_targets VALUES (?,?,?)').run(context.target, context.owner.userId, context.owner.scopeKey);
    for (const id of ['legacy', 'missing-admission', 'verified', 'failed', 'delayed', 'isolated']) f.add(id);
    f.db.exec('UPDATE remote_sync SET needs_snapshot=0,source_seq=10,ack_seq=10');
    for (const [id, admission] of [['legacy', 'unverified'], ['verified', 'verified'], ['delayed', 'unverified'], ['isolated', 'quarantined']]) {
      f.db.prepare('INSERT INTO remote_sync_session_admissions VALUES (?,?,?,?,?,?)')
        .run(context.target, context.owner.userId, context.owner.scopeKey, context.deviceId, id, admission);
    }
    f.db.prepare('INSERT INTO remote_sync_admission_evidence VALUES (?,?,?)').run(`admission:${context.target}`, 'remote_sync', 'missing-admission');
    f.db.prepare('INSERT INTO remote_state VALUES (?,?)').run('syncFailure:failed', '{broken');
    f.state.fail(context, 'delayed', transport);
    f.state.fail(context, 'isolated', { phase: TaskSyncPhase.Isolated, scope: 'session', reason: 'BAD' });
    expect(f.state.candidates(context).map(row => row.local_id).sort()).toEqual(['failed', 'legacy', 'missing-admission']);
    expect(f.db.prepare('SELECT value FROM remote_state WHERE key=?').get('syncFailure:failed')).toEqual({ value: '{broken' });
    f.db.prepare("UPDATE remote_sync_targets SET owner_user_id='other' WHERE target_id=?").run(context.target);
    expect(f.state.candidates(context).map(row => row.local_id)).toEqual(['failed']);
  });
  it('rounds candidates across large backlogs without letting a blocked first task consume every page', () => {
    const f = fixture();
    for (let i = 0; i < 80; i++) f.add(`task-${String(i).padStart(2, '0')}`);
    f.state.fail(context, 'task-00', { phase: TaskSyncPhase.Isolated, scope: 'session', reason: 'BAD' });
    f.at(1); const first = f.state.candidates(context, 1000);
    expect(first).toHaveLength(50); expect(first.some(row => row.local_id === 'task-00')).toBe(false);
    for (const row of first) f.state.served(context, row.local_id);
    const next = f.state.candidates(context, 30);
    expect(next[0].local_id).toBe('task-51');
  });
  it('bounds issue details and prevents stale ownership, device and target rows from leaking titles', () => {
    const f = fixture();
    for (let i = 0; i < 22; i++) { f.add(`own${i}`); f.state.fail(context, `own${i}`, transport); }
    f.add('isolated'); f.state.fail(context, 'isolated', { phase: TaskSyncPhase.Isolated, scope: 'session', reason: 'DATA' });
    f.add('foreign', { userId: 'another-owner', scopeKey: 'personal' }); f.state.fail(context, 'foreign', transport);
    f.add('other-target'); f.state.fail({ ...context, target: 'other' }, 'other-target', transport);
    f.add('other-device'); f.state.fail({ ...context, deviceId: 'other' }, 'other-device', transport);
    f.add('closed'); f.state.fail(context, 'closed', { phase: TaskSyncPhase.Closed, scope: 'session', reason: 'SESSION_DELETED' });
    const health = f.state.health(context);
    expect(health).toMatchObject({ failedSessions: 23, retryingSessions: 22, isolatedSessions: 1, taskIssuesTruncated: true });
    expect(health.taskIssues).toHaveLength(20);
    expect(health.taskIssues[0]).toMatchObject({ localSessionId: 'isolated', title: 'Title isolated', status: RemoteSyncTaskIssueStatus.Isolated, retryable: true });
    expect(health.taskIssues.some(issue => /foreign|other|closed/u.test(issue.localSessionId))).toBe(false);
    expect(f.state.health(context, () => false).taskIssues.every(issue => !issue.retryable)).toBe(true);
    expect(f.state.health(context, () => { throw new Error('bad admission'); }).taskIssues.every(issue => !issue.retryable)).toBe(true);
    f.state.manualRetry(context, 'isolated');
    expect(f.state.health(context).taskIssues.find(issue => issue.localSessionId === 'isolated')?.retryable).toBe(false);
  });
});
