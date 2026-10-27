import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { OwnershipContentSyncReason as Reason, OwnershipContentSyncState as State, OwnershipSyncState } from '../../shared/ownership/constants';
import { recordAvailabilityObjectHealth } from './remoteAvailabilityHealth';
import { RemoteAvailabilityStore } from './remoteAvailabilityStore';
import { RemoteHistoryJob } from './remoteHistoryJob';
import { collectOwnershipContentSync, type OwnershipContentSyncInput, type OwnershipContentSyncSnapshot } from './remoteOwnershipContentSync';
import { RemoteStore } from './remoteStore';
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
