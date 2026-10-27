import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteDeletion } from '../../shared/remote/deletions';
import { availabilitySourceHealth, recordAvailabilityObjectHealth } from './remoteAvailabilityHealth';
import { initializeAvailabilityProjectionSources } from './remoteAvailabilitySource';
import { ensureDesktopInputJobs, ensureRecentDesktopInputJobs } from './remoteDesktopInputJobs';
import { recentLiveCandidates } from './remoteLiveCandidates';
import { RemoteStore } from './remoteStore';

vi.mock('./remoteLogSink', () => ({ enqueueRemoteLog: vi.fn() }));
const owner = { userId: 'account', scopeKey: 'personal' };
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(dispose => dispose()); });
function fixture(filename = ':memory:') {
  const db = new Database(filename); cleanup.push(() => { if (db.open) db.close(); });
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false });
  cleanup.push(() => store.history.close());
  initializeAvailabilityProjectionSources(db);
  store.setEnabledOwner(owner);
  store.transaction(() => {
    db.exec("INSERT INTO cowork_sessions VALUES('s','Task',1,1,'idle',NULL,NULL)");
    store.assignNew('s', owner, 'local_create');
  });
  const insert = db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,2,?)');
  const add = (id: string, type = 'user', metadata: unknown = { remoteRunId: 'run' }, sequence = 1) =>
    store.transaction(() => insert.run(id, 's', type, '', typeof metadata === 'string' ? metadata : JSON.stringify(metadata), sequence));
  const source = { path: '/fixture/input.txt', fileName: 'input.txt', mimeType: 'text/plain', sizeBytes: '12', intent: 'file' };
  const inputs = (count = 1) => store.transaction(() => {
    store.put('runHistory:s:run', { runId: 'run' });
    store.put('desktopInputRun:run', { owner, localSessionId: 's', text: '', attachments: Array.from({ length: count }, () => ({ ...source })) });
  });
  const state = db.prepare('SELECT value FROM remote_state WHERE key=?');
  const bytes = (key: string) => (state.get(key) as { value: string } | undefined)?.value;
  const changesQuery = db.prepare('SELECT total_changes() AS count');
  const changes = () => (changesQuery.get() as { count: number }).count;
  const observe = () => ({ wake: vi.fn(), transaction: vi.spyOn(store, 'transaction') });
  return { db, store, add, inputs, source, bytes, changes, observe };
}

describe('desktop input preparation is read-only until a missing job is confirmed', () => {
  it('rejects non-user and empty candidates before ownership checks, transaction or wake', () => {
    const f = fixture(); f.add('assistant', 'assistant', '{'); f.add('tool', 'tool_result', '{}'); f.add('empty', 'user', {});
    for (const id of ['assistant', 'tool', 'empty']) expect(ensureDesktopInputJobs(f.store, 's', id)).toBeNull();
    const before = f.changes(), prepare = vi.spyOn(f.db, 'prepare'), auth = vi.spyOn(f.store, 'owner');
    const { wake, transaction } = f.observe(); f.store.setWake(wake);
    for (let repeat = 0; repeat < 1000; repeat++) {
      for (const id of ['assistant', 'tool', 'empty']) expect(ensureDesktopInputJobs(f.store, 's', id)).toBeNull();
      ensureRecentDesktopInputJobs(f.store, 's');
    }
    expect(prepare).not.toHaveBeenCalled(); expect(auth).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled(); expect(wake).not.toHaveBeenCalled(); expect(f.changes()).toBe(before);
  });

  it('creates missing jobs once and preserves the original bytes and upload identity on later polls', () => {
    const f = fixture(); f.add('m'); f.inputs();
    const { wake, transaction } = f.observe(); f.store.setWake(wake);
    expect(ensureDesktopInputJobs(f.store, 's', 'm')).toBe(2);
    expect(transaction).toHaveBeenCalledTimes(1); expect(wake).toHaveBeenCalledTimes(1);
    const original = f.bytes('desktopAsset:m:0')!;
    expect(JSON.parse(original)).toMatchObject({ ...f.source, owner, messageId: 'm', localSessionId: 's', uploadRequestId: expect.any(String) });
    transaction.mockClear(); wake.mockClear(); const before = f.changes();
    for (let repeat = 0; repeat < 100; repeat++) expect(ensureDesktopInputJobs(f.store, 's', 'm')).toBeNull();
    expect(f.bytes('desktopAsset:m:0')).toBe(original); expect(f.changes()).toBe(before);
    expect(transaction).not.toHaveBeenCalled(); expect(wake).not.toHaveBeenCalled();
  });

  it.each(['null', '{"unknown":"existing identity"}', '{invalid'])('never replaces an existing receipt (%s) or partially inserts siblings after corruption', raw => {
    const f = fixture(); f.add('m'); f.inputs(raw === '{invalid' ? 2 : 1);
    f.store.transaction(() => f.db.prepare('INSERT INTO remote_state VALUES(?,?)').run('desktopAsset:m:0', raw));
    const { wake, transaction } = f.observe(); f.store.setWake(wake); const before = f.changes();
    if (raw === '{invalid') expect(() => ensureDesktopInputJobs(f.store, 's', 'm')).toThrow();
    else expect(ensureDesktopInputJobs(f.store, 's', 'm')).toBeNull();
    expect(f.bytes('desktopAsset:m:0')).toBe(raw); expect(f.bytes('desktopAsset:m:1')).toBeUndefined();
    expect(f.changes()).toBe(before); expect(transaction).not.toHaveBeenCalled(); expect(wake).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admission', 'frozen', 'unpublished', 'foreign-run', 'input-owner', 'deleted'])('rechecks %s inside the trusted transaction', reason => {
    const f = fixture(); f.add('m'); f.inputs();
    const original = f.store.transaction.bind(f.store);
    vi.spyOn(f.store, 'transaction').mockImplementationOnce(operation => original(() => {
      if (reason === 'owner') f.db.prepare("UPDATE cowork_session_ownership SET ownership_status='quarantined' WHERE session_id='s'").run();
      if (reason === 'admission') f.store.setTaskAdmission(() => false);
      if (reason === 'frozen') f.db.prepare("UPDATE remote_sync SET migration_frozen=1 WHERE local_id='s'").run();
      if (reason === 'unpublished') f.store.put('runPublished:run', false);
      if (reason === 'foreign-run') f.store.put('syncTargetHistory:s', { runIds: ['run'] });
      if (reason === 'input-owner') f.store.put('desktopInputRun:run', { owner: { ...owner, userId: 'other' }, attachments: [f.source] });
      if (reason === 'deleted') f.db.prepare("DELETE FROM cowork_messages WHERE id='m'").run();
      return operation();
    }));
    expect(ensureDesktopInputJobs(f.store, 's', 'm')).toBeNull(); expect(f.bytes('desktopAsset:m:0')).toBeUndefined();
  });

  it('rechecks a deletion effect inside the transaction and propagates its fail-closed error', () => {
    const f = fixture(); f.add('m'); f.inputs();
    const original = f.store.transaction.bind(f.store);
    vi.spyOn(f.store, 'transaction').mockImplementationOnce(operation => original(() => {
      f.store.put(`${RemoteDeletion.Fence}s`, { phase: RemoteDeletion.EffectStarted });
      return operation();
    }));
    expect(() => ensureDesktopInputJobs(f.store, 's', 'm')).toThrow('REMOTE_SESSION_DELETION_IN_PROGRESS');
    expect(f.bytes('desktopAsset:m:0')).toBeUndefined();
  });

  it('rereads attachment material and a newly appeared receipt after preflight', () => {
    const f = fixture(); f.add('m'); f.inputs(2);
    const original = f.store.transaction.bind(f.store);
    vi.spyOn(f.store, 'transaction').mockImplementationOnce(operation => original(() => {
      f.store.put('desktopInputRun:run', { owner, attachments: [f.source, { ...f.source, path: '/fixture/changed.txt' }] });
      f.store.put('desktopAsset:m:0', { uploadRequestId: 'existing' });
      return operation();
    }));
    expect(ensureDesktopInputJobs(f.store, 's', 'm')).toBe(2);
    expect(JSON.parse(f.bytes('desktopAsset:m:0')!)).toEqual({ uploadRequestId: 'existing' });
    expect(JSON.parse(f.bytes('desktopAsset:m:1')!)).toMatchObject({ path: '/fixture/changed.txt' });
  });

  it('fails closed on malformed candidate data and rolls back all jobs when writing fails', () => {
    const f = fixture(); f.add('bad', 'user', '{'); f.add('m'); f.inputs(2);
    const { transaction } = f.observe();
    expect(() => ensureDesktopInputJobs(f.store, 's', 'bad')).toThrow(); expect(transaction).not.toHaveBeenCalled();
    f.db.exec("CREATE TRIGGER fail_input BEFORE INSERT ON remote_state WHEN NEW.key='desktopAsset:m:1' BEGIN SELECT RAISE(ABORT,'fixture write failed'); END");
    expect(() => ensureDesktopInputJobs(f.store, 's', 'm')).toThrow('fixture write failed');
    expect(f.bytes('desktopAsset:m:0')).toBeUndefined(); expect(f.bytes('desktopAsset:m:1')).toBeUndefined();
    f.db.exec('DROP TRIGGER fail_input');
    expect(ensureDesktopInputJobs(f.store, 's', 'm')).toBe(2);
  });
});

describe('live candidate statement lifetime', () => {
  it('uses a fixed set of statements for repeated windows and observes source changes', () => {
    const f = fixture();
    for (let i = 1; i <= 70; i++) f.add(`m${i}`, i % 2 ? 'assistant' : 'tool_result', { toolUseId: `tool${i}` }, i);
    const prepare = vi.spyOn(f.db, 'prepare');
    const first = recentLiveCandidates(f.db, 's'); expect(prepare).toHaveBeenCalledTimes(6);
    expect(first).toHaveLength(64); expect(first[0].position).toBe(70);
    expect(first.some(row => row.object_id === 'm1')).toBe(false);
    prepare.mockClear(); const before = f.changes();
    for (let i = 0; i < 100; i++) expect(recentLiveCandidates(f.db, 's')).toEqual(first);
    expect(prepare).not.toHaveBeenCalled(); expect(f.changes()).toBe(before);
    f.store.transaction(() => f.db.prepare("UPDATE cowork_messages SET metadata=? WHERE id='m70'").run('{"toolUseId":"replacement"}'));
    const changed = recentLiveCandidates(f.db, 's');
    expect(changed).toContainEqual(expect.objectContaining({ object_id: 'replacement', kind: 'tool' }));
    expect(changed).toContainEqual(expect.objectContaining({ object_id: 'm70', revision: 2 }));
    expect(changed.some(row => row.object_id === 'tool70')).toBe(false);
    expect(recentLiveCandidates(f.db, 'other')).toEqual([]);
  });

  it('automatically recompiles after derived schema recreation and never shares a closed connection', () => {
    const f = fixture(); f.add('m', 'tool_result', { toolUseId: 'tool' });
    const expected = recentLiveCandidates(f.db, 's');
    f.db.exec('DROP TABLE remote_live_tool_sources'); initializeAvailabilityProjectionSources(f.db);
    expect(recentLiveCandidates(f.db, 's')).toEqual(expected);
    f.db.close(); expect(() => recentLiveCandidates(f.db, 's')).toThrow();
    const next = fixture(); next.add('m', 'assistant');
    expect(recentLiveCandidates(next.db, 's')).toEqual([{ object_id: 'm', revision: 1, kind: 'message', position: 1 }]);
  });
});

describe('availability health uses current persisted evidence without no-op writes', () => {
  it('does not prepare, create tables or write again for unchanged evidence and preserves revision order', () => {
    const f = fixture(); f.add('m', 'assistant');
    const record = (revision = '1', representation = 'complete') => recordAvailabilityObjectHealth(f.store, 'scope', 's', 'message:m', revision, representation);
    record(); expect(availabilitySourceHealth(f.store, 'scope', 's')).toEqual({ pending: 0, oldest: null, unavailable: false, desktopOnly: false });
    const prepare = vi.spyOn(f.db, 'prepare'), exec = vi.spyOn(f.db, 'exec'), before = f.changes();
    for (let i = 0; i < 1000; i++) { record(); availabilitySourceHealth(f.store, 'scope', 's'); }
    expect(prepare).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled(); expect(f.changes()).toBe(before);
    record('2', 'unknown'); expect(f.changes()).toBe(before + 1);
    expect(availabilitySourceHealth(f.store, 'scope', 's').unavailable).toBe(true);
    record('1'); expect(f.changes()).toBe(before + 1);
    record('2'); expect(f.changes()).toBe(before + 2);
    expect(availabilitySourceHealth(f.store, 'scope', 's').unavailable).toBe(false);
    expect(availabilitySourceHealth(f.store, 'other', 's')).toEqual({ pending: 1, oldest: 2, unavailable: false, desktopOnly: false });
  });

  it('sees external updates and dropped evidence instead of reporting cached success', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'remote-health-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'core.sqlite'), f = fixture(filename);
    f.add('m', 'assistant'); recordAvailabilityObjectHealth(f.store, 'scope', 's', 'message:m', '1', 'complete');
    const external = new Database(filename); cleanup.push(() => external.close());
    external.exec("UPDATE remote_availability_health_acks SET representation='unknown'");
    expect(availabilitySourceHealth(f.store, 'scope', 's').unavailable).toBe(true);
    recordAvailabilityObjectHealth(f.store, 'scope', 's', 'message:m', '1', 'complete');
    expect(availabilitySourceHealth(f.store, 'scope', 's').unavailable).toBe(false);
    external.exec('DROP TABLE remote_availability_health_acks');
    expect(availabilitySourceHealth(f.store, 'scope', 's')).toEqual({ pending: 1, oldest: 2, unavailable: false, desktopOnly: false });
    external.exec('DROP TABLE remote_availability_health_acks; CREATE TABLE remote_availability_health_acks(wrong TEXT)');
    expect(() => availabilitySourceHealth(f.store, 'scope', 's')).toThrow();
  });

  it('recreates rolled-back optional evidence even when an unrelated DDL reuses its schema version', () => {
    const f = fixture(); f.add('m', 'assistant');
    expect(() => f.db.transaction(() => {
      recordAvailabilityObjectHealth(f.store, 'scope', 's', 'message:m', '1', 'complete');
      throw new Error('rollback');
    })()).toThrow('rollback');
    f.db.exec('CREATE TABLE unrelated_fixture(id INTEGER)');
    expect(availabilitySourceHealth(f.store, 'scope', 's')).toEqual({ pending: 1, oldest: 2, unavailable: false, desktopOnly: false });
  });
});
