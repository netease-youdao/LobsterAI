import Database from 'better-sqlite3';
import { dialog } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { showQuarantineRecovery, stopOwnedSessionWithRecovery } from './remoteQuarantineRecovery';
import { RemoteStore } from './remoteStore';

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() } }));
const databases: Database.Database[] = [];
const owner = { userId: 'owner', scopeKey: 'personal' };
const other = { userId: 'other', scopeKey: 'personal' };
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const options = { deferredProjection: true, deferSynchronization: true, restoreRuns: false };
  const store = new RemoteStore(db, options);
  store.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES('private-session','secret title',1,1,'running')").run();
    store.assignNew('private-session', owner, 'local_create');
  });
  store.beginRun('private-session', 'trusted-run'); store.markRunDispatched('private-session');
  db.prepare("UPDATE cowork_session_ownership SET ownership_status='quarantined'").run();
  const runtime = { isSessionActive: vi.fn(() => true), stopSession: vi.fn() };
  const deps = { store, runtime, getOwner: () => owner, getGeneration: () => '1', showLogs: vi.fn() };
  return { db, store, runtime, deps, options };
}
afterEach(() => { vi.clearAllMocks(); for (const db of databases.splice(0)) if (db.open) db.close(); });

describe('quarantine stop-only recovery', () => {
  it('stops only a witnessed run without restoring ownership or allowing ordinary access', () => {
    const f = fixture();
    expect(f.store.quarantinedStopCandidates(owner)).toEqual([{ sessionId: 'private-session', runId: 'trusted-run' }]);
    stopOwnedSessionWithRecovery(f.store, f.runtime, owner, 'private-session');
    expect(f.runtime.stopSession).toHaveBeenCalledExactlyOnceWith('private-session');
    expect(f.store.ownershipRecord('private-session')?.ownership_status).toBe('quarantined');
    expect(() => f.store.assertActor('private-session', owner)).toThrow();
    expect(f.store.run('private-session')?.status).toBe('starting'); // A request is not an engine terminal receipt.
  });
  it('rejects another account, unknown activity, and a process without the witnessed binding', () => {
    const f = fixture();
    expect(() => stopOwnedSessionWithRecovery(f.store, f.runtime, other, 'private-session')).toThrow('REMOTE_QUARANTINE_STOP_UNVERIFIED');
    expect(f.store.quarantinedStopCandidates(null)).toEqual([]);
    f.runtime.isSessionActive.mockReturnValue(false);
    expect(() => stopOwnedSessionWithRecovery(f.store, f.runtime, owner, 'private-session')).toThrow();
    const reopened = new RemoteStore(f.db, f.options);
    expect(reopened.quarantinedStopCandidates(owner)).toEqual([]);
    expect(f.runtime.stopSession).not.toHaveBeenCalled();
  });
  it('rejects run replacement and mismatched quarantine ownership', () => {
    const f = fixture();
    f.db.prepare("UPDATE cowork_session_ownership SET owner_user_id='other'").run();
    expect(f.store.quarantinedStopCandidates(owner)).toEqual([]);
    f.db.prepare("UPDATE cowork_session_ownership SET owner_user_id='owner'").run();
    f.store.put('run:private-session', { ...f.store.run('private-session'), runId: 'replacement' });
    expect(() => f.store.assertQuarantinedStop('private-session', 'trusted-run', owner)).toThrow();
    expect(f.store.quarantinedStopCandidates(owner)).toEqual([]);
  });
  it.each(['account', 'generation', 'run'] as const)('rechecks %s after the user opens recovery', async changed => {
    const f = fixture(); let actor = owner, generation = '1';
    f.deps.getOwner = () => actor; f.deps.getGeneration = () => generation;
    vi.mocked(dialog.showMessageBox).mockImplementationOnce(async () => {
      if (changed === 'account') actor = other;
      if (changed === 'generation') generation = '2';
      if (changed === 'run') f.store.put('run:private-session', { ...f.store.run('private-session'), runId: 'replacement' });
      return { response: 2, checkboxChecked: false };
    }).mockResolvedValue({ response: 0, checkboxChecked: false });
    await showQuarantineRecovery(f.deps);
    expect(f.runtime.stopSession).not.toHaveBeenCalled();
  });
  it('shows counts only and retains quarantine after a user-requested stop', async () => {
    const f = fixture();
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 2, checkboxChecked: false })
      .mockResolvedValue({ response: 0, checkboxChecked: false });
    await showQuarantineRecovery(f.deps);
    const content = JSON.stringify(vi.mocked(dialog.showMessageBox).mock.calls);
    expect(content).not.toContain('private-session'); expect(content).not.toContain('secret title'); expect(content).not.toContain('trusted-run');
    expect(f.runtime.stopSession).toHaveBeenCalledOnce();
    expect(f.store.ownershipRecord('private-session')?.ownership_status).toBe('quarantined');
  });
});
