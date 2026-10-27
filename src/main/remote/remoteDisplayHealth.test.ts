import Database from 'better-sqlite3';
import { fork } from 'child_process';
import { randomUUID } from 'crypto';
import { build } from 'esbuild';
import { once } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { RemoteSyncLaneStatus, RemoteSyncTaskIssueSource, RemoteSyncTaskIssueStatus } from '../../shared/remote/constants';
import { payloadHash } from './canonical';
import { RemoteAvailabilityStore } from './remoteAvailabilityStore';
import { collectRemoteDisplayHealth, type RemoteDisplayHealthInput, type RemoteDisplayHealthResult, RemoteDisplayHealthStatus as Status } from './remoteDisplayHealth';
import { readRemoteDisplayAdmission } from './remoteDisplayHealthAdmission';
import { RemoteStore } from './remoteStore';
import { RemoteSyncTargetStore } from './remoteSyncTargetStore';
import { RemoteTaskSyncState, TaskSyncPhase } from './remoteTaskSyncState';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const compiled = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-display-health-code-'));
const worker = path.join(compiled, 'worker.cjs');
beforeAll(async () => { await build({ entryPoints: [path.join(__dirname, 'remoteDisplayHealthWorker.ts')], outfile: worker,
  bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'], logLevel: 'silent' }); });
afterAll(() => fs.rmSync(compiled, { recursive: true, force: true }));
const owner = { userId: 'owner', scopeKey: 'personal' };
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-display-health-'));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const core = new Database(path.join(directory, 'core.sqlite'));
  const control = new Database(path.join(directory, 'remote-control.sqlite'));
  const history = new Database(path.join(directory, 'remote-sync.sqlite'));
  cleanup.push(() => { for (const db of [core, control, history]) if (db.open) db.close(); });
  core.exec(`CREATE TABLE remote_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL);
    CREATE TABLE cowork_session_ownership(session_id TEXT PRIMARY KEY,owner_user_id TEXT,owner_scope_key TEXT,ownership_status TEXT);
    CREATE TABLE remote_sync(local_id TEXT PRIMARY KEY,session_id TEXT,device_id TEXT,sync_environment TEXT,migration_frozen INTEGER DEFAULT 0,
      needs_snapshot INTEGER DEFAULT 0,source_seq INTEGER DEFAULT 0,ack_seq INTEGER DEFAULT 0,server_seq TEXT DEFAULT '0',sync_protocol_version INTEGER DEFAULT 1,stream_epoch TEXT);
    CREATE TABLE remote_session_revisions(session_id TEXT PRIMARY KEY,dirty_at INTEGER);
    CREATE TABLE remote_dirty(session_id TEXT PRIMARY KEY);
    CREATE TABLE remote_control_revisions(session_id TEXT PRIMARY KEY,revision INTEGER);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,created_at INTEGER);
    CREATE INDEX messages_session ON cowork_messages(session_id);
    CREATE TABLE remote_live_revisions(session_id TEXT,object_id TEXT,revision INTEGER,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(session_id,object_id));
    CREATE TABLE remote_live_tools(session_id TEXT,tool_id TEXT,revision INTEGER,PRIMARY KEY(session_id,tool_id));
    CREATE TABLE remote_availability_health_acks(scope TEXT,session_id TEXT,object_key TEXT,revision INTEGER,representation TEXT,PRIMARY KEY(scope,session_id,object_key));
    CREATE TABLE remote_control_ledger_locator(id INTEGER PRIMARY KEY,ledger_id TEXT,phase TEXT);
    INSERT INTO remote_control_ledger_locator VALUES(1,'control-identity','ready');
    CREATE TABLE remote_history_profile(id INTEGER PRIMARY KEY,sidecar_id TEXT);
    INSERT INTO remote_history_profile VALUES(1,'history-identity');
    CREATE TABLE remote_history_migrations(scope TEXT,local_id TEXT,writer_generation TEXT,phase TEXT,manifest_json TEXT,migration_id TEXT,manifest_hash TEXT,PRIMARY KEY(scope,local_id,writer_generation));
    CREATE TABLE remote_run_isolation(session_id TEXT PRIMARY KEY);`);
  const tasks = new RemoteTaskSyncState(core), targets = new RemoteSyncTargetStore({ db: core });
  core.prepare('INSERT INTO remote_sync_targets VALUES(?,?,?,?,NULL)').run('target', owner.userId, owner.scopeKey, 'device');
  core.prepare('INSERT INTO remote_sync_target_active VALUES(?,?,?,1)').run(owner.userId, owner.scopeKey, 'target');
  control.exec(`CREATE TABLE availability_identity(id INTEGER PRIMARY KEY,ledger_id TEXT);
    INSERT INTO availability_identity VALUES(1,'control-identity');
    CREATE TABLE availability_migration(id INTEGER PRIMARY KEY,phase TEXT);
    INSERT INTO availability_migration VALUES(1,'ready');
    CREATE TABLE availability_sessions(scope TEXT,local_id TEXT,body TEXT,PRIMARY KEY(scope,local_id));
    CREATE TABLE availability_requests(key TEXT PRIMARY KEY,lane TEXT,scope TEXT,local_id TEXT,body TEXT,resolution_receipt TEXT);
    CREATE INDEX requests_scope ON availability_requests(scope,local_id,lane);
    CREATE TABLE availability_faults(scope TEXT,local_id TEXT,object_key TEXT,fingerprint TEXT,attempts INTEGER,window_start INTEGER,next_retry INTEGER);
    CREATE TABLE availability_progress(scope TEXT,local_id TEXT,lane TEXT,ack_at INTEGER);`);
  history.exec(`CREATE TABLE history_identity(id INTEGER PRIMARY KEY,sidecar_id TEXT);
    INSERT INTO history_identity VALUES(1,'history-identity');
    CREATE TABLE history_migration_copies(migration_id TEXT PRIMARY KEY,manifest_json TEXT,manifest_hash TEXT);
    CREATE TABLE history_sessions(scope TEXT,local_id TEXT,writer_generation TEXT,body TEXT,PRIMARY KEY(scope,local_id,writer_generation));
    CREATE TABLE history_operations(id TEXT PRIMARY KEY,scope TEXT,local_id TEXT,writer_generation TEXT,state TEXT,body TEXT);`);
  const input: RemoteDisplayHealthInput = { database: core.name, owner, target: 'target', targetId: 'target', deviceId: 'device',
    availabilityScope: 'target:owner:personal:device', historySupported: false, settingsKey: 'settings:target:owner:personal',
    controlsKey: 'controlQueue:target:owner:personal', nameKey: 'namePending:target:owner:personal', catalogFailureKey: 'catalogFailure:target:owner:personal' };
  const state = (key: string, value: unknown): void => { core.prepare('INSERT OR REPLACE INTO remote_state VALUES(?,?)').run(key, JSON.stringify(value)); };
  const session = (id: string, scopeOwner = owner, target = input.target): void => {
    core.prepare('INSERT INTO cowork_sessions VALUES(?,?)').run(id, `Title ${id}`);
    core.prepare('INSERT INTO cowork_session_ownership VALUES(?,?,?,?)').run(id, scopeOwner.userId, scopeOwner.scopeKey, 'confirmed');
    core.prepare('INSERT INTO remote_sync(local_id,session_id,device_id,sync_environment,needs_snapshot) VALUES(?,?,?,?,1)').run(id, `remote-${id}`, input.deviceId, target);
    core.prepare('INSERT INTO remote_session_revisions VALUES(?,1000)').run(id);
    core.prepare('INSERT INTO remote_control_revisions VALUES(?,1)').run(id);
  };
  const available = (id: string): void => {
    control.prepare('INSERT INTO availability_sessions VALUES(?,?,?)').run(input.availabilityScope, id, JSON.stringify({ scope: input.availabilityScope, localId: id,
      sessionId: `remote-${id}`, writerGeneration: 'writer', controlRevision: '1', phase: 'active' }));
  };
  const historyReady = (id: string): void => {
    const context = { scope: input.availabilityScope, localId: id, writerGeneration: 'writer', sessionId: `remote-${id}`, deviceId: input.deviceId, owner };
    const manifest = { context, legacy: { source_seq: 7, ack_seq: 3 } }, hash = payloadHash(manifest);
    core.prepare('INSERT INTO remote_history_migrations VALUES(?,?,?,?,?,?,?)').run(input.availabilityScope, id, 'writer', 'ready', JSON.stringify(manifest), 'migration', hash);
    history.prepare('INSERT INTO history_migration_copies VALUES(?,?,?)').run('migration', JSON.stringify(manifest), hash);
    history.prepare('INSERT INTO history_sessions VALUES(?,?,?,?)').run(input.availabilityScope, id, 'writer', JSON.stringify({ ...context,
      migrationId: 'migration', legacyMetadataHash: hash, resolvedSourceSeq: '7' }));
  };
  return { directory, core, control, history, tasks, targets, input, state, session, available, historyReady };
}
function runWorker(input: RemoteDisplayHealthInput): Promise<RemoteDisplayHealthResult> {
  return new Promise((resolve, reject) => {
    const child = fork(worker, [], { execArgv: [], env: { ...process.env, NODE_PATH: path.join(process.cwd(), 'node_modules') }, stdio: ['ignore','ignore','ignore','ipc'] });
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; } });
    let result: RemoteDisplayHealthResult | undefined;
    child.on('message', (message: { result?: RemoteDisplayHealthResult }) => { result = message.result; });
    child.once('error', reject);
    child.once('exit', () => { if (result) resolve(result); else reject(new Error('Display worker did not return a result')); });
    child.send({ type: 'remote.history.job', jobId: randomUUID(), input });
  });
}

describe('read-only display health collection', () => {
  it('reads files initialized by the real stores without changing durable bytes or schema', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-display-health-real-'));
    cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const core = new Database(path.join(directory, 'core.sqlite'));
    cleanup.push(() => { if (core.open) core.close(); });
    core.pragma('journal_mode=WAL');
    core.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
      CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
    const store = new RemoteStore(core, { restoreRuns: false });
    const ledger = new RemoteAvailabilityStore(core);
    cleanup.push(() => { ledger.close(); store.history.close(); });
    new RemoteTaskSyncState(core); new RemoteSyncTargetStore(store);
    core.prepare('INSERT INTO remote_sync_targets VALUES(?,?,?,?,NULL)').run('target', owner.userId, owner.scopeKey, 'device');
    core.prepare('INSERT INTO remote_sync_target_active VALUES(?,?,?,1)').run(owner.userId, owner.scopeKey, 'target');
    const input: RemoteDisplayHealthInput = { database: core.name, owner, target: 'target', targetId: 'target', deviceId: 'device',
      availabilityScope: 'target:owner:personal:device', historySupported: true,
      settingsKey: 'settings', controlsKey: 'controls', nameKey: 'name', catalogFailureKey: 'catalog' };
    // An empty initialized ledger and absent optional settings/history metadata are valid.
    expect(ledger.db.open).toBe(true);
    expect(await runWorker(input)).toMatchObject({ status: Status.Known, settings: null, availability: { sessions: 0, pendingSessions: 0 } });
    store.transaction(() => { core.prepare("INSERT INTO cowork_sessions VALUES('live','Title',1,1,'idle')").run(); store.assignNew('live', owner, 'local_create'); });
    const sessionId = store.controlBinding('live')!.session_id;
    store.bindRemote('live', sessionId, 'device');
    core.prepare("UPDATE remote_sync SET sync_environment='target' WHERE local_id='live'").run();
    store.setIndependentControlReady(() => true);
    const context = { scope: input.availabilityScope!, localId: 'live', sessionId, writerGeneration: 'writer', owner, deviceId: 'device' };
    ledger.saveSession({ ...context, phase: 'active', controlEpoch: 'epoch', operationId: 'operation', pendingCommandIds: [], pendingRunIds: [],
      controlRevision: '1', factSeq: '0', records: {} });
    expect(store.history.prepare(context)).not.toBeNull();
    store.history.sealOperation({ id: 'pending', context, kind: 'batch', request: { immutable: 'private-request-body' } });
    // Flush fixture setup before comparing main database and WAL bytes.
    for (const db of [core, ledger.db]) db.pragma('wal_checkpoint(TRUNCATE)');
    store.history.close(); ledger.close();
    const files = ['core.sqlite','remote-control.sqlite','remote-sync.sqlite'].map(name => path.join(directory, name));
    const schema = () => files.map(filename => { const db = new Database(filename, { readonly: true, fileMustExist: true });
      try { return db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(); } finally { db.close(); } });
    const tables = schema(), before = files.map(filename => fs.readFileSync(filename));
    const result = await runWorker(input);
    expect(result).toMatchObject({ status: Status.Known, settings: null, availability: { sessions: 1, pendingSessions: 1, lanes: { history: 'pending' } } });
    expect(JSON.stringify(result)).not.toContain('private-request-body');
    expect(files.map(filename => fs.readFileSync(filename))).toEqual(before); expect(schema()).toEqual(tables);
  });
  it('preserves legacy/v3 counts, oldest, progress and settings without changing any database bytes or schema', async () => {
    const f = fixture(); f.session('legacy'); f.session('live'); f.available('live');
    f.core.prepare("INSERT INTO cowork_messages VALUES('message','live','assistant',2000)").run();
    f.control.prepare("INSERT INTO availability_progress VALUES(?, 'live','live',3000)").run(f.input.availabilityScope);
    f.state(f.input.settingsKey, { enabled: true, name: 'Desktop', settingsVersion: '2', workspaces: [], secret: 'never-return' });
    f.state(f.input.controlsKey, [{ id: 'pending' }]); f.state(f.input.nameKey, { name: 'new name' }); f.state(f.input.catalogFailureKey, true);
    f.state('lastSuccessfulSync:owner:personal', '2026-10-26T00:00:00.000Z');
    const files = [f.core.name, f.control.name, f.history.name], before = files.map(file => fs.readFileSync(file));
    const tables = [f.core, f.control, f.history].map(db => db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all());
    const result = await runWorker(f.input);
    expect(result).toMatchObject({ status: Status.Known, settings: { enabled: true, name: 'Desktop', settingsVersion: '2', workspaces: [] },
      pendingSettings: true, pendingName: true, catalogFailed: true, legacy: { pendingSessions: 1, oldest: 1000, lastSuccess: '2026-10-26T00:00:00.000Z' },
      availability: { sessions: 1, pendingSessions: 1, oldest: 2000, lastSuccess: 3000, lanes: { live: 'pending' } } });
    expect(JSON.stringify(result)).not.toContain('never-return');
    expect(files.map(file => fs.readFileSync(file))).toEqual(before);
    expect([f.core, f.control, f.history].map(db => db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all())).toEqual(tables);
  });
  it('reports object faults once per visible session, including already acknowledged sources, without writing files', async () => {
    const f = fixture(); f.session('live'); f.available('live'); f.session('legacy');
    f.core.prepare("INSERT INTO cowork_messages VALUES('message','live','assistant',2000)").run();
    f.core.prepare("INSERT INTO remote_availability_health_acks VALUES(?,'live','message:message',1,'complete')").run(f.input.availabilityScope);
    for (const key of ['message:message', 'tool:tool']) f.control.prepare('INSERT INTO availability_faults VALUES(?,?,?,?,1,0,300000)')
      .run(f.input.availabilityScope, 'live', key, 'fingerprint');
    f.control.prepare('INSERT INTO availability_faults VALUES(?,?,?,?,1,0,300000)').run('other-scope', 'private-session', 'private-object', 'private-fingerprint');
    const context = { owner, target: 'target', deviceId: 'device' };
    // The old task row must not count this same v3 session twice.
    for (const id of ['live', 'legacy']) f.tasks.fail(context, id, { phase: TaskSyncPhase.Backoff, scope: 'session', reason: 'NETWORK' });
    const files = [f.core.name, f.control.name, f.history.name], before = files.map(file => fs.readFileSync(file));
    const result = await runWorker(f.input);
    expect(result).toMatchObject({ status: Status.Known,
      availability: { pendingSessions: 1, degraded: true, desktopOnlySessions: 0, lanes: { live: RemoteSyncLaneStatus.Degraded } },
      taskHealth: { failedSessions: 2, isolatedSessions: 1, retryingSessions: 1, taskIssues: [
        { localSessionId: 'live', title: 'Title live', source: RemoteSyncTaskIssueSource.Live, status: RemoteSyncTaskIssueStatus.Isolated, nextRetryAt: 300000, retryable: true },
        { localSessionId: 'legacy', status: RemoteSyncTaskIssueStatus.Retrying },
      ] } });
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(files.map(file => fs.readFileSync(file))).toEqual(before);
    f.core.prepare("INSERT INTO remote_run_isolation VALUES('live')").run();
    expect(collectRemoteDisplayHealth(f.input)).toMatchObject({ taskHealth: { taskIssues: expect.arrayContaining([
      expect.objectContaining({ localSessionId: 'live', retryable: false }),
    ]) } });
  });
  it('keeps history-only fault details visible without offering an unsupported live-object retry', () => {
    const f = fixture(); f.session('history'); f.available('history');
    f.control.prepare('INSERT INTO availability_faults VALUES(?,?,?,?,1,0,300000)').run(f.input.availabilityScope, 'history', 'history-recovery', 'fingerprint');
    const result = collectRemoteDisplayHealth(f.input);
    expect(result).toMatchObject({ status: Status.Known, taskHealth: { failedSessions: 1, taskIssues: [
      { localSessionId: 'history', status: RemoteSyncTaskIssueStatus.Isolated, retryable: false },
    ] } });
    if (result.status === Status.Known) expect(result.taskHealth?.taskIssues[0]).not.toHaveProperty('source');
  });
  it('distinguishes a current desktop-only ACK from queued newer content and complete content', () => {
    const f = fixture(); f.session('live'); f.available('live');
    f.core.prepare("INSERT INTO cowork_messages VALUES('message','live','assistant',2000)").run();
    expect(collectRemoteDisplayHealth(f.input)).toMatchObject({ status: Status.Known,
      availability: { pendingSessions: 1, degraded: false, desktopOnlySessions: 0 }, taskHealth: { failedSessions: 0 } });
    f.core.prepare("INSERT INTO remote_availability_health_acks VALUES(?,'live','message:message',1,'desktop_only')").run(f.input.availabilityScope);
    expect(collectRemoteDisplayHealth(f.input)).toMatchObject({ status: Status.Known,
      availability: { pendingSessions: 0, degraded: false, desktopOnlySessions: 1, lanes: { live: RemoteSyncLaneStatus.Idle } }, taskHealth: { failedSessions: 0, taskIssues: [] } });
    f.core.prepare("INSERT INTO remote_live_revisions(session_id,object_id,revision) VALUES('live','message',2)").run();
    expect(collectRemoteDisplayHealth(f.input)).toMatchObject({ status: Status.Known,
      availability: { pendingSessions: 1, degraded: false, desktopOnlySessions: 0, lanes: { live: RemoteSyncLaneStatus.Pending } } });
    f.core.prepare("UPDATE remote_availability_health_acks SET revision=2,representation='complete'").run();
    expect(collectRemoteDisplayHealth(f.input)).toMatchObject({ status: Status.Known,
      availability: { pendingSessions: 0, degraded: false, desktopOnlySessions: 0 } });
  });
  it('keeps intentional local-only skips neutral and recognizes only current nondeleted desktop-only sources', () => {
    const f = fixture(); f.session('live'); f.available('live');
    f.core.prepare("INSERT INTO cowork_messages VALUES('message','live','assistant',2000)").run();
    f.core.prepare("INSERT INTO remote_availability_health_acks VALUES(?,'live','message:message',1,'local_only')").run(f.input.availabilityScope);
    expect(collectRemoteDisplayHealth(f.input)).toMatchObject({ status: Status.Known,
      availability: { pendingSessions: 0, degraded: false, desktopOnlySessions: 0 } });
    f.core.prepare("INSERT INTO remote_live_revisions VALUES('live','message',1,1)").run();
    f.core.prepare("UPDATE remote_availability_health_acks SET representation='desktop_only'").run();
    expect(collectRemoteDisplayHealth(f.input)).toMatchObject({ status: Status.Known, availability: { desktopOnlySessions: 0 } });
    f.core.prepare("INSERT INTO remote_live_tools VALUES('live','tool',2)").run();
    f.core.prepare("INSERT INTO remote_availability_health_acks VALUES(?,'live','tool:tool',1,'desktop_only')").run(f.input.availabilityScope);
    expect(collectRemoteDisplayHealth(f.input)).toMatchObject({ status: Status.Known, availability: { desktopOnlySessions: 0, pendingSessions: 1 } });
    f.core.prepare("UPDATE remote_availability_health_acks SET revision=2 WHERE object_key='tool:tool'").run();
    expect(collectRemoteDisplayHealth(f.input)).toMatchObject({ status: Status.Known, availability: { desktopOnlySessions: 1, pendingSessions: 0, degraded: false } });
  });
  it.each(['unknown', 'unsupported', null])('does not call an unrecognized ACK representation %s successful desktop-only content', representation => {
    const f = fixture(); f.session('live'); f.available('live');
    f.core.prepare("INSERT INTO cowork_messages VALUES('message','live','assistant',2000)").run();
    f.core.prepare("INSERT INTO remote_availability_health_acks VALUES(?,'live','message:message',1,?)").run(f.input.availabilityScope, representation);
    expect(collectRemoteDisplayHealth(f.input)).toMatchObject({ status: Status.Known,
      availability: { pendingSessions: 1, degraded: true, desktopOnlySessions: 0, lanes: { live: RemoteSyncLaneStatus.Unknown } } });
  });
  it('bounds live issue details while retaining known failed-session counts and marks malformed retry evidence unknown', () => {
    const f = fixture();
    for (let index = 0; index < 21; index++) {
      const id = `live-${index}`; f.session(id); f.available(id);
      f.control.prepare('INSERT INTO availability_faults VALUES(?,?,?,?,1,0,300000)').run(f.input.availabilityScope, id, 'message:one', 'fingerprint');
    }
    const result = collectRemoteDisplayHealth(f.input);
    expect(result).toMatchObject({ status: Status.Known, taskHealth: { failedSessions: 21, isolatedSessions: 21, taskIssuesTruncated: true } });
    if (result.status === Status.Known) expect(result.taskHealth?.taskIssues).toHaveLength(20);
    f.control.prepare('UPDATE availability_faults SET next_retry=NULL').run();
    const unknown = collectRemoteDisplayHealth(f.input);
    expect(unknown.status).toBe(Status.Unknown); expect(unknown).not.toHaveProperty('taskHealth');
  });
  it('keeps owner, target, device and availability visibility filters for task issues and retry admission', () => {
    const f = fixture();
    for (const id of ['mine','other-target','v3']) f.session(id, owner, id === 'other-target' ? 'old-target' : 'target');
    f.session('foreign', { userId: 'different', scopeKey: 'personal' }); f.available('v3');
    const context = { owner, target: 'target', deviceId: 'device' };
    for (const id of ['mine','foreign','other-target','v3']) f.tasks.fail(context, id, { phase: TaskSyncPhase.Backoff, scope: 'session', reason: 'NETWORK' });
    f.tasks.fail({ ...context, target: 'old-target' }, 'mine', { phase: TaskSyncPhase.Isolated, scope: 'session', reason: 'OLD' });
    const result = collectRemoteDisplayHealth(f.input);
    expect(result).toMatchObject({ status: Status.Known, legacy: { pendingSessions: 1 }, taskHealth: { failedSessions: 1, taskIssues: [{ localSessionId: 'mine', retryable: true }] } });
    expect(readRemoteDisplayAdmission(f.core, owner, 'device', 'target', 'mine')).toBe(f.targets.isAdmitted(owner, 'device', 'target', 'mine'));
    f.core.prepare("INSERT INTO remote_run_isolation VALUES('mine')").run();
    expect(collectRemoteDisplayHealth(f.input)).toMatchObject({ taskHealth: { taskIssues: [{ retryable: false }] } });
  });
  it('shares pristine and associated execution-evidence admission semantics', () => {
    const f = fixture(); f.session('new');
    f.core.prepare("UPDATE remote_sync SET device_id=NULL,sync_environment=NULL WHERE local_id='new'").run();
    expect(readRemoteDisplayAdmission(f.core, owner, 'device', 'target', 'new')).toBe(true);
    expect(f.targets.isAdmitted(owner, 'device', 'target', 'new')).toBe(true);
    f.state('run:new', { runId: 'run' }); f.state('syncRunTarget:run', 'another-target');
    expect(readRemoteDisplayAdmission(f.core, owner, 'device', 'target', 'new')).toBe(false);
    expect(f.targets.isAdmitted(owner, 'device', 'target', 'new')).toBe(false);
  });
  it('keeps malformed active target metadata from granting display retry', () => {
    const f = fixture(); f.session('mine');
    f.tasks.fail({ owner, target: 'target', deviceId: 'device' }, 'mine', { phase: TaskSyncPhase.Backoff, scope: 'session', reason: 'NETWORK' });
    f.core.prepare('UPDATE remote_sync_targets SET sync_target_json=?').run('{broken-private-metadata');
    expect(() => f.targets.isAdmitted(owner, 'device', 'target', 'mine')).toThrow();
    expect(collectRemoteDisplayHealth(f.input)).toMatchObject({ status: Status.Unknown });
  });
  it('does not read or parse historical request bodies merely to display pending', () => {
    const f = fixture(); f.session('live'); f.available('live'); f.historyReady('live');
    f.history.prepare("INSERT INTO history_operations VALUES('op',?,'live','writer','pending',?)").run(f.input.availabilityScope, 'invalid-json-secret'.repeat(100000));
    const result = collectRemoteDisplayHealth({ ...f.input, historySupported: true });
    expect(result).toMatchObject({ status: Status.Known, availability: { lanes: { history: 'pending' }, pendingSessions: 1 } });
    expect(JSON.stringify(result)).not.toContain('invalid-json-secret');
  });
  it('preserves no-context visibility without opening or creating absent sidecars', () => {
    const f = fixture(); f.session('legacy'); f.control.close(); fs.unlinkSync(f.control.name); f.history.close(); fs.unlinkSync(f.history.name);
    expect(collectRemoteDisplayHealth({ ...f.input, availabilityScope: null })).toMatchObject({ status: Status.Known, availability: null, legacy: { pendingSessions: 0 } });
    expect(fs.existsSync(f.control.name)).toBe(false); expect(fs.existsSync(f.history.name)).toBe(false);
  });
  it('discards a snapshot if another connection commits while its read transactions are open', () => {
    const f = fixture(); f.core.pragma('journal_mode=WAL');
    const prepare = Database.prototype.prepare;
    let committed = false;
    const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
      if (!committed && this.name === f.control.name && sql.includes('SELECT COUNT(*) AS total')) {
        committed = true;
        prepare.call(f.core, "INSERT INTO remote_state VALUES('concurrent','true')").run();
      }
      return prepare.call(this, sql);
    });
    try { expect(collectRemoteDisplayHealth(f.input)).toMatchObject({ status: Status.Unknown, reason: 'REMOTE_DISPLAY_HEALTH_INCONSISTENT' }); }
    finally { spy.mockRestore(); }
    expect(committed).toBe(true);
  });
  it('reports unknown when read-only admission exceeds its evidence budget', () => {
    const f = fixture(); f.session('new');
    f.core.prepare("UPDATE remote_sync SET device_id=NULL,sync_environment=NULL WHERE local_id='new'").run();
    f.tasks.fail({ owner, target: 'target', deviceId: 'device' }, 'new', { phase: TaskSyncPhase.Backoff, scope: 'session', reason: 'NETWORK' });
    f.state('run:new', { runId: 'run', evidence: 'x'.repeat(1024 * 1024) });
    expect(collectRemoteDisplayHealth(f.input)).toMatchObject({ status: Status.Unknown, reason: 'REMOTE_DISPLAY_HEALTH_BUDGET' });
  });
  it('reports unknown for a missing core, without creating a file', () => {
    const f = fixture(), database = path.join(f.directory, 'missing.sqlite');
    expect(collectRemoteDisplayHealth({ ...f.input, database })).toMatchObject({ status: Status.Unknown });
    expect(fs.existsSync(database)).toBe(false);
  });
  it.each(['missing','schema','identity','corrupt'] as const)('reports unknown for %s control storage and preserves its bytes', kind => {
    const f = fixture();
    if (kind === 'schema') f.control.exec('DROP TABLE availability_progress');
    if (kind === 'identity') f.control.exec("UPDATE availability_identity SET ledger_id='other'");
    f.control.close();
    if (kind === 'missing') fs.unlinkSync(f.control.name);
    if (kind === 'corrupt') fs.writeFileSync(f.control.name, 'credential-secret-invalid-db');
    const before = fs.existsSync(f.control.name) ? fs.readFileSync(f.control.name) : null;
    const result = collectRemoteDisplayHealth(f.input);
    expect(result).toMatchObject({ status: Status.Unknown }); expect(JSON.stringify(result)).not.toContain('credential-secret');
    expect(fs.existsSync(f.control.name) ? fs.readFileSync(f.control.name) : null).toEqual(before);
  });
  it('reports unknown for cross-database owner/binding or history identity conflicts', () => {
    const f = fixture(); f.session('live'); f.available('live'); f.historyReady('live');
    f.history.exec("UPDATE history_identity SET sidecar_id='other'");
    expect(collectRemoteDisplayHealth({ ...f.input, historySupported: true })).toMatchObject({ status: Status.Unknown });
    f.core.exec("UPDATE cowork_session_ownership SET owner_user_id='foreign'");
    expect(collectRemoteDisplayHealth(f.input)).toMatchObject({ status: Status.Unknown });
  });
  it('rejects a history migration copy that no longer agrees with core evidence', () => {
    const f = fixture(); f.session('live'); f.available('live'); f.historyReady('live');
    f.history.prepare('UPDATE history_migration_copies SET manifest_json=?').run('{"changed":true}');
    expect(collectRemoteDisplayHealth({ ...f.input, historySupported: true })).toMatchObject({ status: Status.Unknown, reason: 'REMOTE_DISPLAY_HEALTH_INCONSISTENT' });
  });
  it('rejects oversized or malformed display data instead of emitting zero-count success', () => {
    const f = fixture(); f.session('live'); f.available('live');
    f.control.prepare('UPDATE availability_sessions SET body=?').run('x'.repeat(1024 * 1024 + 1));
    expect(collectRemoteDisplayHealth(f.input)).toMatchObject({ status: Status.Unknown });
    f.control.exec('DELETE FROM availability_sessions');
    f.state(f.input.settingsKey, { enabled: true, name: 'x'.repeat(257) });
    expect(collectRemoteDisplayHealth(f.input)).toMatchObject({ status: Status.Unknown });
  });
  it('marks bounded session counts as truncated, never exact idle', () => {
    const f = fixture();
    f.core.transaction(() => { for (let i = 0; i < 129; i++) f.session(`s${i}`); })();
    f.control.transaction(() => { for (let i = 0; i < 129; i++) f.available(`s${i}`); })();
    expect(collectRemoteDisplayHealth(f.input)).toMatchObject({ status: Status.Known, availability: { sessions: 129, countsTruncated: true, degraded: true, lanes: { recovery: 'unknown' } } });
  });
  it('allows the parent to terminate the real worker during a long native SQL query while its event loop stays responsive', async () => {
    const f = fixture(); f.session('slow');
    f.core.exec(`ALTER TABLE remote_sync RENAME TO backing_sync;
      UPDATE backing_sync SET needs_snapshot=0;
      CREATE VIEW remote_sync AS SELECT local_id,session_id,device_id,sync_environment,migration_frozen,needs_snapshot,
        (WITH RECURSIVE counter(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM counter WHERE n<1000000000) SELECT SUM(n) FROM counter) AS source_seq,
        ack_seq,server_seq,sync_protocol_version,stream_epoch FROM backing_sync;`);
    const child = fork(worker, [], { execArgv: [], env: { ...process.env, NODE_PATH: path.join(process.cwd(), 'node_modules') }, stdio: ['ignore','ignore','ignore','ipc'] });
    let returned = false, ticks = 0;
    child.on('message', () => { returned = true; });
    const ended = once(child, 'exit');
    const timer = setInterval(() => { ticks++; }, 10);
    child.send({ type: 'remote.history.job', jobId: randomUUID(), input: f.input });
    try { await new Promise(resolve => setTimeout(resolve, 300)); }
    finally { clearInterval(timer); child.kill('SIGKILL'); await ended; }
    expect(returned).toBe(false); expect(ticks).toBeGreaterThan(5);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });
});
