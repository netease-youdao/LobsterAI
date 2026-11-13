import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { OwnershipContentSyncReason as Reason, OwnershipContentSyncState as State, OwnershipSyncState } from '../../shared/ownership/constants';
import { RemoteDeletion } from '../../shared/remote/deletions';
import { RemoteSyncRecoveryReason, RemoteSyncRecoveryState } from '../../shared/remote/recovery';
import { payloadHash } from './canonical';
import { AvailabilityRecoveryLane, initializeAvailabilityRecovery, RemoteAvailabilityAutoRecovery } from './remoteAvailabilityAutoRecovery';
import { recordAvailabilityObjectHealth } from './remoteAvailabilityHealth';
import { RemoteAvailabilityStore } from './remoteAvailabilityStore';
import { collectRemoteDisplayHealth, RemoteDisplayHealthStatus } from './remoteDisplayHealth';
import { readRemoteDisplayTaskHealth } from './remoteDisplayHealthTask';
import { RemoteHistoryJob } from './remoteHistoryJob';
import { collectOwnershipContentSync, type OwnershipContentSyncInput, type OwnershipContentSyncSnapshot } from './remoteOwnershipContentSync';
import { RemoteStore } from './remoteStore';
import { finishRecoveryRequest, readRecoveryLedger, RecoveryOutcome, RemoteRecoveryLimiter, reserveRecoveryRequest, reserveRecoveryRound } from './remoteSyncRecoveryLedger';
import { RemoteSyncTargetStore } from './remoteSyncTargetStore';
import { RemoteTaskSyncState } from './remoteTaskSyncState';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(dispose => dispose()); });
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ownership-content-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const core = new Database(path.join(directory, 'core.sqlite'));
  cleanup.push(() => core.close());
  core.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);
    CREATE INDEX messages_task ON cowork_messages(session_id);`);
  const store = new RemoteStore(core, { deferredProjection: true, restoreRuns: false });
  const targets = new RemoteSyncTargetStore(store), tasks = new RemoteTaskSyncState(core);
  const owner = { userId: 'owner', scopeKey: 'personal' };
  const target = targets.activateLegacy({ owner, deviceId: 'device', allowPartialLegacy: true });
  store.setEnabledOwner(owner); store.setProjectionIdentity(target.targetId, owner, 'device');
  store.transaction(() => {
    core.prepare('INSERT INTO cowork_sessions VALUES(?,?,1,1,?)').run('task-99', 'Target', 'completed');
    store.assignNew('task-99', owner, 'local_create');
  });
  const row = store.sync('task-99')!;
  store.bindRemote('task-99', row.session_id, 'device');
  const ledger = new RemoteAvailabilityStore(core); void ledger.db;
  cleanup.push(() => { ledger.close(); store.history.close(); });
  const input: OwnershipContentSyncInput = { database: core.name, owner, target: target.targetId, targetId: target.targetId, deviceId: 'device',
    availabilityScope: `${target.targetId}:owner:personal:device`, historySupported: false, contentTaskId: 'task-99',
    settingsKey: 'settings', controlsKey: 'controls', nameKey: 'name', catalogFailureKey: 'catalog' };
  store.put('settings', { enabled: true });
  const activate = (): void => {
    const revision = (core.prepare('SELECT revision FROM remote_control_revisions WHERE session_id=?').get('task-99') as { revision: number }).revision;
    ledger.saveSession({ scope: input.availabilityScope!, localId: 'task-99', sessionId: row.session_id, writerGeneration: 'writer', controlEpoch: 'epoch',
      phase: 'active', operationId: 'operation', pendingCommandIds: [], pendingRunIds: [], controlRevision: String(revision), factSeq: '0', records: {} });
  };
  const message = (): number => {
    store.transaction(() => core.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,?,?)').run('message', 'task-99', 'assistant', 'text', '{not valid private metadata', 1, 1));
    return (core.prepare('SELECT revision FROM remote_live_revisions WHERE session_id=? AND object_id=?').get('task-99', 'message') as { revision: number }).revision;
  };
  return { core, store, ledger, tasks, input, activate, message, read: () => collectOwnershipContentSync(input) };
}

describe('readonly ownership task content status', () => {
  it('reads the requested fault beyond any global top-20 list and observes the actual manual cooldown', () => {
    const f = fixture(); f.activate();
    for (let index = 0; index < 30; index++) f.ledger.objectFault(f.input.availabilityScope!, `task-${index}`, 'message:other', 'hash');
    f.ledger.objectFault(f.input.availabilityScope!, 'task-99', 'message:message', 'hash');
    const before = f.core.prepare('SELECT total_changes() AS n').get();
    expect(f.read().contentSync).toEqual({ state: State.Failed, reason: Reason.Content, retryable: true });
    const at = Date.now();
    f.ledger.db.prepare('INSERT INTO availability_encoding_probes VALUES(?,?,?,?,?,?)').run(f.input.availabilityScope, 'task-99', 'message:message', 'hash', 2, at);
    expect(f.read().contentSync).toEqual({ state: State.Failed, reason: Reason.Content, retryable: false, nextRetryAt: at + 60000 });
    expect(f.core.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it('separates pending, partial and complete content without parsing message metadata', () => {
    const f = fixture(); f.activate(); const revision = f.message();
    expect(f.read().contentSync.state).toBe(State.Pending);
    recordAvailabilityObjectHealth(f.store, f.input.availabilityScope!, 'task-99', 'message:message', String(revision), 'desktop_only');
    expect(f.read()).toMatchObject({ contentSync: { state: State.Partial, retryable: false }, syncState: OwnershipSyncState.Partial });
    recordAvailabilityObjectHealth(f.store, f.input.availabilityScope!, 'task-99', 'message:message', String(revision), 'complete');
    expect(f.read()).toMatchObject({ contentSync: { state: State.Synced, retryable: false }, syncState: OwnershipSyncState.Synced });
  });

  it('does not call a control fault a content failure, and does not offer live retry for history-only faults', () => {
    const f = fixture(); f.activate();
    f.ledger.objectFault(f.input.availabilityScope!, 'task-99', 'control-bootstrap', 'hash');
    expect(f.read().contentSync).toEqual({ state: State.Waiting, reason: Reason.Connection, retryable: false });
    f.ledger.db.prepare('DELETE FROM availability_faults').run();
    f.ledger.objectFault(f.input.availabilityScope!, 'task-99', 'history-recovery', 'hash');
    expect(f.read().contentSync).toMatchObject({ state: State.Failed, reason: Reason.History, retryable: false });
  });

  it('keeps unavailable initial control and missing history evidence from reporting synced', () => {
    const f = fixture(); f.activate();
    const saved = f.ledger.session(f.input.availabilityScope!, 'task-99')!;
    f.ledger.saveSession({ ...saved, phase: 'bootstrap' });
    expect(f.read().contentSync.state).toBe(State.Waiting);
    f.ledger.saveSession(saved); f.input.historySupported = true;
    expect(f.read().contentSync).toEqual({ state: State.Unknown, reason: Reason.Unavailable, retryable: false });
  });

  it.each(['owner', 'scope', 'environment', 'device', 'frozen', 'closed', 'deleted', 'admission'])('does not expose content faults after %s changes', guard => {
    const f = fixture(); f.activate(); f.ledger.objectFault(f.input.availabilityScope!, 'task-99', 'message:message', 'hash');
    if (guard === 'owner') f.input.owner = { ...f.input.owner, userId: 'other' };
    if (guard === 'scope') f.input.owner = { ...f.input.owner, scopeKey: 'team:other' };
    if (guard === 'environment') f.core.prepare("UPDATE remote_sync SET sync_environment='other' WHERE local_id='task-99'").run();
    if (guard === 'device') f.core.prepare("UPDATE remote_sync SET device_id='other' WHERE local_id='task-99'").run();
    if (guard === 'frozen') f.core.prepare("UPDATE remote_sync SET migration_frozen=1 WHERE local_id='task-99'").run();
    if (guard === 'closed') f.store.put('deletionClosed:task-99', true);
    if (guard === 'deleted') f.store.put('localGcDeleted:task-99', {});
    if (guard === 'admission') f.core.prepare("INSERT INTO remote_run_isolation VALUES('task-99','run','hash','test')").run();
    expect([State.Waiting, State.Unknown]).toContain(f.read().contentSync.state);
    expect(f.read().contentSync.retryable).toBe(false);
  });

  it('returns unknown for unreadable storage and a missing target', () => {
    const f = fixture(); f.input.contentTaskId = 'missing';
    expect(f.read().contentSync.state).toBe(State.Unknown);
    f.input.database = path.join(path.dirname(f.input.database), 'not-present.sqlite');
    expect(f.read().contentSync.state).toBe(State.Unknown);
  });

  it('recognizes legacy message ACKs without a revision index and rejects future or unknown ACK evidence', () => {
    const f = fixture(); f.activate(); const revision = f.message();
    f.core.prepare("DELETE FROM remote_live_revisions WHERE session_id='task-99' AND object_id='message'").run();
    recordAvailabilityObjectHealth(f.store, f.input.availabilityScope!, 'task-99', 'message:message', '1', 'desktop_only');
    expect(f.read().contentSync.state).toBe(State.Partial);
    recordAvailabilityObjectHealth(f.store, f.input.availabilityScope!, 'task-99', 'message:message', String(revision + 10), 'complete');
    expect(f.read().contentSync.state).toBe(State.Unknown);
    f.core.prepare("UPDATE remote_availability_health_acks SET revision=1,representation='unsupported'").run();
    expect(f.read().contentSync.state).toBe(State.Unknown);
    f.core.prepare("UPDATE remote_availability_health_acks SET representation='complete'").run();
    expect(f.read().contentSync.state).toBe(State.Synced);
  });

  it('treats unresolved and uncertain history as pending or unknown using real migration evidence', () => {
    const f = fixture(); f.activate(); f.input.historySupported = true;
    const context = { scope: f.input.availabilityScope!, localId: 'task-99', sessionId: f.store.sync('task-99')!.session_id,
      writerGeneration: 'writer', owner: f.input.owner, deviceId: 'device' };
    f.store.setIndependentControlReady(() => true);
    const prepared = f.store.history.prepare(context); expect(prepared).not.toBeNull();
    const history = new Database(path.join(path.dirname(f.input.database), 'remote-sync.sqlite'));
    cleanup.push(() => history.close());
    const source = f.store.sync('task-99')!.source_seq;
    history.prepare('UPDATE history_sessions SET body=?').run(JSON.stringify({ ...prepared!, resolvedSourceSeq: String(source) }));
    expect(f.read().contentSync.state).toBe(State.Synced);
    f.store.history.sealOperation({ id: 'pending', context, kind: 'batch', request: { private: 'not returned' } });
    expect(f.read().contentSync).toEqual({ state: State.Pending, reason: Reason.History, retryable: false });
    history.prepare("UPDATE history_operations SET state='complete'").run();
    f.core.prepare("UPDATE remote_history_migrations SET manifest_json=?").run(' '.repeat(16385));
    expect(f.read().contentSync.state).toBe(State.Unknown);
  });

  it.each(['PROTOCOL_UNSUPPORTED', 'INVALID_REMOTE_REQUEST', 'IDEMPOTENCY_CONFLICT'])(
    'exposes a verified isolated legacy task as a content failure with a bounded manual retry: %s', reason => {
      const f = fixture(), context = { owner: f.input.owner, target: f.input.target, deviceId: 'device' };
      f.tasks.fail(context, 'task-99', { phase: 'isolated', scope: 'session', reason });
      f.store.put('syncFailure:task-99', { blocked: true, reason });
      const before = f.core.prepare('SELECT total_changes() AS n').get();
      expect(f.read()).toMatchObject({ syncState: OwnershipSyncState.Failed,
        contentSync: { state: State.Failed, reason: Reason.Content, retryable: true } });
      expect(f.core.prepare('SELECT total_changes() AS n').get()).toEqual(before);
      expect(f.tasks.get(context, 'task-99')?.phase).toBe('isolated');
      const at = Date.now();
      f.core.prepare('UPDATE remote_sync_task_state SET manual_retry_at=?').run(at);
      expect(f.read().contentSync).toEqual({ state: State.Failed, reason: Reason.Content, retryable: false, nextRetryAt: at + 60000 });
      f.core.prepare("UPDATE remote_sync_task_state SET manual_retry_at=-1,repair_json='invalid'").run();
      expect(f.read().contentSync).toEqual({ state: State.Failed, reason: Reason.Content, retryable: false });
    });

  it('treats an ordinary deletion guard as a version, while an actual deletion fence prevents retry', () => {
    const f = fixture(), context = { owner: f.input.owner, target: f.input.target, deviceId: 'device' };
    f.tasks.fail(context, 'task-99', { phase: 'isolated', scope: 'session', reason: 'INVALID_REMOTE_REQUEST' });
    f.store.deletionGuard('task-99');
    expect(f.read().contentSync).toEqual({ state: State.Failed, reason: Reason.Content, retryable: true });
    f.store.put(`${RemoteDeletion.Fence}task-99`, { phase: RemoteDeletion.EffectStarted });
    expect(f.read().contentSync).toEqual({ state: State.Waiting, reason: Reason.Connection, retryable: false });
  });

  it.each(['device', 'service', 'owner_scope'])('does not offer a task retry for an isolated %s failure', scope => {
    const f = fixture(), context = { owner: f.input.owner, target: f.input.target, deviceId: 'device' };
    f.tasks.fail(context, 'task-99', { phase: 'isolated', scope, reason: 'PROTOCOL_UNSUPPORTED' });
    expect(f.read().contentSync.retryable).toBe(false);
    expect([State.Unknown, State.Waiting]).toContain(f.read().contentSync.state);
  });

  it('bounds legacy retry evidence and never offers retry for an invalid repair ledger', () => {
    const f = fixture();
    const context = { owner: f.input.owner, target: f.input.target, deviceId: 'device' };
    f.tasks.fail(context, 'task-99', { phase: 'isolated', scope: 'session', reason: 'REMOTE_PROJECTION_BUDGET' });
    f.core.prepare('INSERT INTO remote_projection_failures VALUES(?,?,?,?)').run('task-99', 'REMOTE_PROJECTION_BUDGET', 0, 1);
    f.core.prepare('UPDATE remote_sync_task_state SET repair_json=?').run(' '.repeat(4097));
    expect(f.read().contentSync).toEqual({ state: State.Failed, reason: Reason.Content, retryable: false });
  });

  it('requires exact tool ACK evidence and never upgrades a future or unsupported tool receipt to synced', () => {
    const f = fixture(); f.activate();
    f.core.prepare("INSERT INTO remote_live_tools VALUES('task-99','tool',2)").run();
    expect(f.read().contentSync.state).toBe(State.Pending);
    recordAvailabilityObjectHealth(f.store, f.input.availabilityScope!, 'task-99', 'tool:tool', '2', 'desktop_only');
    expect(f.read().contentSync.state).toBe(State.Partial);
    recordAvailabilityObjectHealth(f.store, f.input.availabilityScope!, 'task-99', 'tool:tool', '3', 'complete');
    expect(f.read().contentSync.state).toBe(State.Unknown);
    f.core.prepare("UPDATE remote_availability_health_acks SET revision=2,representation='unsupported'").run();
    expect(f.read().contentSync.state).toBe(State.Unknown);
    f.core.prepare("UPDATE remote_availability_health_acks SET representation='complete'").run();
    expect(f.read().contentSync.state).toBe(State.Synced);
  });

  it('keeps closed legacy tasks and a busy database from claiming available content or retry', () => {
    const f = fixture();
    const context = { owner: f.input.owner, target: f.input.target, deviceId: 'device' };
    f.tasks.fail(context, 'task-99', { phase: 'isolated', scope: 'session', reason: 'REMOTE_PROJECTION_BUDGET' });
    f.core.prepare("UPDATE remote_sync_task_state SET phase='closed'").run();
    f.core.prepare('INSERT INTO remote_projection_failures VALUES(?,?,?,?)').run('task-99', 'REMOTE_PROJECTION_BUDGET', 0, 1);
    expect(f.read().contentSync).toEqual({ state: State.Waiting, reason: Reason.Connection, retryable: false });
    f.core.exec('BEGIN EXCLUSIVE');
    try { expect(f.read().contentSync).toEqual({ state: State.Unknown, reason: Reason.Unavailable, retryable: false }); }
    finally { f.core.exec('ROLLBACK'); }
  });

  it('runs the optional task branch in the real supervised worker and leaves the source files unchanged', async () => {
    const f = fixture(); f.activate(); const revision = f.message();
    recordAvailabilityObjectHealth(f.store, f.input.availabilityScope!, 'task-99', 'message:message', String(revision), 'desktop_only');
    const directory = path.dirname(f.input.database);
    symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    await build({ entryPoints: [path.join(__dirname, 'remoteDisplayHealthWorker.ts')],
      outdir: directory, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'], logLevel: 'silent' });
    const job = new RemoteHistoryJob(path.join(__dirname, 'remoteHistoryGuardWorker.cjs'));
    const before = [f.input.database, f.ledger.db.name].map(file => readFileSync(file));
    const result = await job.run<OwnershipContentSyncSnapshot>(path.join(directory, 'remoteDisplayHealthWorker.cjs'), f.input,
      { timeoutMs: 5000, memoryMb: 96, resultLimitBytes: 4096, prefix: 'REMOTE_DISPLAY_HEALTH', current: () => true });
    expect(result.contentSync).toEqual({ state: State.Partial, retryable: false });
    expect((job as any).child).toBeNull();
    expect([f.input.database, f.ledger.db.name].map(file => readFileSync(file))).toEqual(before);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('uses the legacy retry gate for a real projection failure without creating a task scheduler row', () => {
    const f = fixture();
    f.core.prepare('INSERT INTO remote_projection_failures VALUES(?,?,?,?)').run('task-99', 'REMOTE_PROJECTION_BUDGET', 0, 1);
    expect(f.read().contentSync).toEqual({ state: State.Failed, reason: Reason.Content, retryable: true });
    const context = { owner: f.input.owner, target: f.input.target, deviceId: 'device' };
    expect(f.tasks.get(context, 'task-99')).toBeNull();
    expect(f.tasks.manualRetry(context, 'task-99')).toBe(true);
    expect(f.read().contentSync).toMatchObject({ state: State.Failed, retryable: false });
  });
});

describe('persisted recovery display', () => {
  it('shares waiting/checking/recovering status across both legacy views until the original ACK completes', () => {
    const f = fixture(), now = Date.now(), context = { owner: f.input.owner, target: f.input.target, deviceId: 'device' };
    f.tasks.fail(context, 'task-99', { phase: 'isolated', scope: 'session', reason: 'PROTOCOL_UNSUPPORTED' });
    f.tasks.scheduleRecovery(context, 'task-99');
    expect(f.read().contentSync.recovery).toMatchObject({ state: RemoteSyncRecoveryState.Waiting });
    const reserved = reserveRecoveryRound(readRecoveryLedger('{}')!, { failureKey: 'a'.repeat(64), evidenceKey: 'b'.repeat(64),
      contextKey: 'c'.repeat(64), operationKey: 'd'.repeat(64), now })!;
    const show = (raw: unknown, expected: RemoteSyncRecoveryState) => {
      f.core.prepare('UPDATE remote_sync_task_state SET auto_probe_json=?').run(JSON.stringify(raw));
      const before = f.core.prepare('SELECT total_changes() AS n').get();
      const detail = f.read().contentSync;
      const overview = readRemoteDisplayTaskHealth(f.core, context, () => true, () => true, now);
      expect(detail.state).toBe(State.Failed);
      expect(detail.recovery).toEqual(overview.taskIssues[0].recovery);
      expect(detail.recovery).toMatchObject({ state: expected, reason: RemoteSyncRecoveryReason.Protocol });
      if (expected !== RemoteSyncRecoveryState.Waiting) expect(detail.retryable).toBe(false);
      expect(f.core.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    };
    show(reserved.ledger, RemoteSyncRecoveryState.Waiting);
    const requested = reserveRecoveryRequest(reserved.ledger, reserved.round.attemptId, now)!;
    show(requested.ledger, RemoteSyncRecoveryState.Checking);
    const verified = finishRecoveryRequest(requested.ledger, requested.token, { success: true, now, outcome: RecoveryOutcome.Verified })!;
    f.core.prepare("UPDATE remote_sync_task_state SET phase='ready'").run();
    show(verified, RemoteSyncRecoveryState.Recovering);
    f.tasks.progress(context, 'task-99', true);
    expect(readRemoteDisplayTaskHealth(f.core, context).taskIssues).toEqual([]);
    expect(f.read().contentSync.recovery).toBeUndefined();
    expect(readRecoveryLedger(f.tasks.get(context, 'task-99')!.auto_probe_json)!.times).toHaveLength(1);
  });

  it('keeps v3 recovery visible even when no encoding fault exists, without writing the sidecar', () => {
    const f = fixture(); f.activate();
    const recovery = new RemoteAvailabilityAutoRecovery(action => action(f.ledger.db));
    recovery.record({ scope: f.input.availabilityScope!, localId: 'task-99', lane: AvailabilityRecoveryLane.Live, objectKey: 'message:message',
      contextKey: payloadHash('context'), operationKey: payloadHash('operation') },
    { code: 47009, httpStatus: 426, data: { reason: 'PROTOCOL_UNSUPPORTED' } });
    const before = f.ledger.db.prepare('SELECT total_changes() AS n').get();
    expect(f.read().contentSync).toMatchObject({ state: State.Failed, retryable: false,
      recovery: { state: RemoteSyncRecoveryState.Waiting, reason: RemoteSyncRecoveryReason.Protocol } });
    const health = collectRemoteDisplayHealth(f.input);
    expect(health, JSON.stringify(health)).toMatchObject({ status: RemoteDisplayHealthStatus.Known });
    if (health.status === RemoteDisplayHealthStatus.Known) expect(health.taskHealth?.taskIssues[0].recovery).toEqual(f.read().contentSync.recovery);
    expect(f.ledger.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });
});

it('aggregates a blocked history recovery with a waiting control recovery consistently across views', async () => {
  const f = fixture(); f.activate(); f.input.historySupported = true;
  const context = { scope: f.input.availabilityScope!, localId: 'task-99', sessionId: f.store.sync('task-99')!.session_id,
    writerGeneration: 'writer', owner: f.input.owner, deviceId: 'device' };
  f.store.setIndependentControlReady(() => true);
  expect(f.store.history.prepare(context)).not.toBeNull();
  const history = new Database(path.join(path.dirname(f.input.database), 'remote-sync.sqlite'));
  cleanup.push(() => history.close());
  const controlRecovery = new RemoteAvailabilityAutoRecovery(action => action(f.ledger.db));
  const historyRecovery = new RemoteAvailabilityAutoRecovery(action => action(history));
  const identity = { scope: context.scope, localId: context.localId, contextKey: payloadHash(context), operationKey: payloadHash('operation'), objectKey: 'history' };
  const error = { code: 47009, httpStatus: 426, data: { reason: 'PROTOCOL_UNSUPPORTED' } };
  controlRecovery.record({ ...identity, lane: AvailabilityRecoveryLane.Control }, error);
  historyRecovery.record({ ...identity, lane: AvailabilityRecoveryLane.History }, error, Date.now() - 31000);
  await expect(historyRecovery.probe({ ...identity, lane: AvailabilityRecoveryLane.History }, {}, new RemoteRecoveryLimiter(), () => true,
    async () => { throw { httpStatus: 404 }; }, () => {})).rejects.toMatchObject({ httpStatus: 404 });
  const health = collectRemoteDisplayHealth(f.input);
  expect(health.status).toBe(RemoteDisplayHealthStatus.Known);
  expect(f.read().contentSync).toMatchObject({ state: State.Failed, reason: Reason.History, retryable: false,
    recovery: { state: RemoteSyncRecoveryState.Blocked } });
  if (health.status === RemoteDisplayHealthStatus.Known) expect(health.taskHealth?.taskIssues[0].recovery).toEqual(f.read().contentSync.recovery);
});

it('disables manual recovery in both views when the automatic budget is damaged', () => {
  const f = fixture(), context = { owner: f.input.owner, target: f.input.target, deviceId: 'device' };
  f.tasks.fail(context, 'task-99', { phase: 'isolated', scope: 'session', reason: 'PROTOCOL_UNSUPPORTED' });
  f.core.prepare("UPDATE remote_sync_task_state SET auto_probe_json='invalid'").run();
  const before = f.core.prepare('SELECT total_changes() AS n').get();
  expect(f.read().contentSync).toMatchObject({ state: State.Failed, retryable: false, recovery: { state: RemoteSyncRecoveryState.Blocked } });
  expect(readRemoteDisplayTaskHealth(f.core, context).taskIssues[0]).toMatchObject({ retryable: false, recovery: { state: RemoteSyncRecoveryState.Blocked } });
  expect(f.core.prepare('SELECT total_changes() AS n').get()).toEqual(before);
});

it('preserves retry eligibility for projection-only failures without a task recovery row', () => {
  const f = fixture(), context = { owner: f.input.owner, target: f.input.target, deviceId: 'device' };
  f.core.prepare('INSERT INTO remote_projection_failures VALUES(?,?,?,?)').run('task-99', 'REMOTE_PROJECTION_BUDGET', 0, 1);
  expect(f.tasks.get(context, 'task-99')).toBeNull();
  const overview = readRemoteDisplayTaskHealth(f.core, context).taskIssues[0];
  expect(overview.retryable).toBe(true);
  expect(overview.recovery).toBeUndefined();
  expect(f.read().contentSync).toEqual({ state: State.Failed, reason: Reason.Content, retryable: overview.retryable });
});

it('does not offer a v3 manual retry when its lane recovery budget is damaged', () => {
  const f = fixture(); f.activate();
  f.ledger.objectFault(f.input.availabilityScope!, 'task-99', 'message:message', 'hash');
  initializeAvailabilityRecovery(f.ledger.db);
  f.ledger.db.prepare('INSERT INTO availability_auto_recovery(scope,local_id,lane,object_key,body) VALUES(?,?,?,?,?)')
    .run(f.input.availabilityScope, 'task-99', AvailabilityRecoveryLane.Live, '@lane-budget', 'invalid');
  const before = f.ledger.db.prepare('SELECT total_changes() AS n').get();
  expect(f.read().contentSync).toMatchObject({ state: State.Failed, retryable: false, recovery: { state: RemoteSyncRecoveryState.Blocked } });
  const health = collectRemoteDisplayHealth(f.input);
  expect(health.status).toBe(RemoteDisplayHealthStatus.Known);
  if (health.status === RemoteDisplayHealthStatus.Known) expect(health.taskHealth?.taskIssues[0]).toMatchObject({ retryable: false, recovery: { state: RemoteSyncRecoveryState.Blocked } });
  expect(f.ledger.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
});


describe('unverified linked task source', () => {
  it('reports a persisted admission failure before the empty-device connection fallback without changing data', () => {
    const f = fixture();
    const context = { owner: f.input.owner, target: f.input.target, deviceId: 'device' };
    f.tasks.fail(context, 'task-99', { phase: 'isolated', scope: 'session', reason: 'REMOTE_SYNC_STATE_CONFLICT' });
    f.store.publicationOrigins.setRouteProvider(() => 'https://original.example');
    f.core.prepare("INSERT OR REPLACE INTO remote_publication_origins VALUES('session','task-99',NULL,NULL,?,?)").run(context.owner.userId, context.owner.scopeKey);
    f.core.prepare("UPDATE remote_sync SET device_id='',sync_environment=NULL WHERE local_id='task-99'").run();
    const before = f.core.prepare("SELECT * FROM remote_sync WHERE local_id='task-99'").get();
    expect(f.read()).toMatchObject({ syncState: OwnershipSyncState.Failed, contentSync: { state: State.Failed, reason: Reason.Source, retryable: false } });
    expect(f.core.prepare("SELECT * FROM remote_sync WHERE local_id='task-99'").get()).toEqual(before);
    f.store.put(`${RemoteDeletion.Fence}task-99`, { blocked: true });
    expect(f.read().contentSync.state).toBe(State.Waiting);
  });

  it.each(['other-target', 'other-device', 'other-owner'])('does not reuse another %s failure as current publication evidence', mismatch => {
    const f = fixture();
    const context = { owner: mismatch === 'other-owner' ? { userId: 'other', scopeKey: 'personal' } : f.input.owner,
      target: mismatch === 'other-target' ? 'other-target' : f.input.target, deviceId: mismatch === 'other-device' ? 'other-device' : 'device' };
    f.tasks.fail(context, 'task-99', { phase: 'isolated', scope: 'session', reason: 'REMOTE_SYNC_STATE_CONFLICT' });
    f.core.prepare("UPDATE remote_sync SET device_id='',sync_environment=NULL WHERE local_id='task-99'").run();
    expect(f.read().contentSync).toEqual({ state: State.Waiting, reason: Reason.Connection, retryable: false });
  });
});
