import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { payloadHash } from './canonical';
import type { RemoteIdentity } from './installationIdentity';
import { RemoteSecurityCoordinator } from './remoteSecurityCoordinator';
import { RemoteSecurityJournal, type RemoteSecurityJournalIo } from './remoteSecurityJournal';
import { RemoteStore } from './remoteStore';

const owner = { userId: 'A', scopeKey: 'personal' };
const identity: RemoteIdentity = { installationId: 'install', databaseId: 'database', deviceKey: Buffer.alloc(32, 3).toString('base64url') };
class MemoryIo implements RemoteSecurityJournalIo {
  current: string | null = null; previous: string | null = null; writes = 0; failWrite = 0;
  async read() { return { current: this.current, previous: this.previous }; }
  async replace(expected: string | null, content: string): Promise<void> {
    if (expected !== this.current) throw new Error('compare and swap failed');
    this.writes++; if (this.failWrite === this.writes) throw new Error('injected disk failure');
    this.previous = this.current; this.current = content;
  }
  async restart(): Promise<void> {}
  close(): void {}
}
const databases: Database.Database[] = [];
const coordinators: RemoteSecurityCoordinator[] = [];
afterEach(() => { for (const coordinator of coordinators.splice(0)) coordinator.close(); vi.useRealTimers(); for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  let store = new RemoteStore(db, { deferredProjection: true }); const io = new MemoryIo();
  const create = (id: string): void => store.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES (?,'Task',1,1,'idle')").run(id); store.assignNew(id, owner, 'local_create');
  });
  const security = () => { const value = new RemoteSecurityCoordinator(store, new RemoteSecurityJournal(identity, io, true), identity, 0); coordinators.push(value); return value; };
  return { db, io, create, security, store: () => store, reopen: () => { store = new RemoteStore(db, { deferredProjection: true }); } };
}

describe('remote execution durability stays outside ordinary desktop writes', () => {
  it('signs owned tasks and never writes the external journal for ordinary messages', async () => {
    const f = fixture(); f.create('task'); const security = f.security(); await security.available();
    const before = f.io.writes;
    for (let index = 0; index < 50; index++) f.store().transaction(() => f.db.prepare('UPDATE cowork_sessions SET title=? WHERE id=?').run(`Title ${index}`, 'task'));
    expect(f.io.writes).toBe(before); expect(f.store().owner('task')).toEqual(owner);
    expect(f.store().get('ownershipProof:task')).toBeTruthy();
    await security.commit('command', { type: 'execute', owner }, () => f.store().put('inbox:command', { state: 'executing' }));
    expect(f.io.writes).toBe(before + 2); expect(f.store().get('securityJournalHead')).toMatchObject({ operationId: 'command', sequence: 1 });
  });
  it('preserves same-installation tasks created while secure storage is temporarily unavailable', async () => {
    const f = fixture(); await f.security().available(); f.reopen(); f.create('offline-created');
    expect(f.store().get('ownershipProof:offline-created')).toBeNull();
    expect(f.db.prepare('SELECT database_id FROM remote_ownership_pending').get()).toEqual({ database_id: identity.databaseId });
    await f.security().available();
    expect(f.store().owner('offline-created')).toEqual(owner); expect(() => f.store().assertActor('offline-created', owner)).not.toThrow();
    expect(f.store().get('ownershipProof:offline-created')).toBeTruthy(); expect(f.db.prepare('SELECT * FROM remote_ownership_pending').all()).toEqual([]);
  });
  it('does not silently sign a pending task created under a different installation', async () => {
    const f = fixture(); await f.security().available(); f.reopen(); f.create('unverified');
    f.db.prepare("UPDATE remote_ownership_pending SET database_id='other-installation'").run();
    await expect(f.security().available()).rejects.toThrow('unverified installation');
    expect(f.store().owner('unverified')).toEqual(owner); expect(f.store().get('ownershipProof:unverified')).toBeNull();
    expect(f.store().needsSecurityRecovery()).toBe(true);
  });
  it('recovers committed-core / pending-external finalization without re-executing a command', async () => {
    const f = fixture(); f.create('task'); const security = f.security(); await security.available();
    f.io.failWrite = f.io.writes + 2;
    await expect(security.commit('command', { type: 'execute' }, () => f.store().put('inbox:command', { state: 'executing' }))).rejects.toThrow('disk failure');
    expect(f.store().owner('task')).toEqual(owner); expect(f.store().needsSecurityRecovery()).toBe(true);
    f.io.failWrite = 0; f.reopen(); await f.security().available();
    expect(f.store().get('inbox:command')).toEqual({ state: 'executing' });
    expect(f.store().owner('task')).toEqual(owner); expect(f.store().needsSecurityRecovery()).toBe(false);
  });
  it('treats a predecessor core plus pending external record as unknown, preserving local ownership', async () => {
    const f = fixture(); f.create('task'); const security = f.security(); await security.available();
    f.io.failWrite = f.io.writes + 2;
    await expect(security.commit('command', { type: 'execute' }, () => f.store().put('inbox:command', { state: 'executing' }))).rejects.toThrow();
    // Simulate restoration to a pre-commit backup, not evidence that the side effect never happened.
    f.store().remove('securityJournalHead'); f.store().remove('inbox:command'); f.io.failWrite = 0; f.reopen();
    await expect(f.security().available()).rejects.toThrow('explicit recovery');
    expect(f.store().owner('task')).toEqual(owner); expect(f.store().hasCompleteExecutionHistory()).toBe(false);
  });
});


it('recovers a failed finalize in the same coordinator without replaying apply', async () => {
  const f = fixture(); f.create('task'); const security = f.security(); await security.available();
  let calls = 0;
  f.io.failWrite = f.io.writes + 2;
  await expect(security.commit('command', { type: 'execute' }, () => { calls++; f.store().put('inbox:command', { state: 'executing' }); })).rejects.toThrow();
  f.io.failWrite = 0;
  await security.recover(); await security.available();
  expect(calls).toBe(1);
  expect(f.store().get('inbox:command')).toEqual({ state: 'executing' });
  expect(f.store().needsSecurityRecovery()).toBe(false);
});

it('same-instance recovery does not cancel pending with a predecessor core', async () => {
  const f = fixture(); f.create('task'); const security = f.security(); await security.available();
  f.io.failWrite = f.io.writes + 2;
  await expect(security.commit('command', {}, () => f.store().put('inbox:command', { state: 'executing' }))).rejects.toThrow();
  f.store().remove('securityJournalHead'); f.io.failWrite = 0;
  await security.recover();
  await expect(security.available()).rejects.toThrow('explicit recovery');
  expect(f.store().get('inbox:command')).toEqual({ state: 'executing' });
  expect(f.store().needsSecurityRecovery()).toBe(true);
});


it('scopes a damaged positively local run only after signed ownership and journal verification', async () => {
  const f = fixture(); f.create('bad'); f.create('good'); await f.security().available();
  f.store().beginRun('bad', 'run'); f.store().prepareLocalDispatch('bad', { prompt: 'test' });
  f.db.prepare("UPDATE remote_state SET value='{' WHERE key='run:bad'").run();
  f.reopen(); await f.security().available();
  expect(f.store().isRunIsolated('bad')).toBe(true);
  expect(f.store().needsSecurityRecovery()).toBe(false);
  expect(f.store().hasCompleteExecutionHistory()).toBe(false);
  expect(() => f.store().beginRun('bad')).toThrow();
  expect(() => f.store().beginRun('good')).not.toThrow();
  expect(f.db.prepare("SELECT value FROM remote_state WHERE key='run:bad'").get()).toEqual({ value: '{' });
});

it.each(['im:test:default', 'cron:job'])('uses bound source and observed engine identity to scope %s runs', async source => {
  const f = fixture(); f.create('bad'); f.create('good'); await f.security().available();
  f.store().bindSource(source, owner); f.store().bindExecutionSource('bad', source);
  f.store().beginRun('bad', 'run');
  f.store().put('gatewayRun:bad', { remoteRunId: 'run', runId: 'gateway-run' });
  f.store().recordExternalExecution('bad', 'gateway-run');
  f.db.prepare("UPDATE remote_state SET value='{' WHERE key='run:bad'").run();
  f.reopen(); await f.security().available();
  expect(f.store().isRunIsolated('bad')).toBe(true);
  expect(f.store().hasCompleteExecutionHistory()).toBe(false);
  expect(() => f.store().beginRun('good')).not.toThrow();
});

it('does not reclassify a mobile or unknown run as local because command evidence is absent', async () => {
  const f = fixture(); f.create('bad'); await f.security().available();
  f.store().beginRun('bad', 'run', 'command');
  f.store().remove('runCommand:bad');
  f.db.prepare("UPDATE remote_state SET value='{' WHERE key='run:bad'").run();
  f.reopen(); await expect(f.security().available()).rejects.toThrow('recovery');
  expect(f.store().isRunIsolated('bad')).toBe(false);
  expect(f.store().needsSecurityRecovery()).toBe(true);
});

it('keeps changed corrupt bytes under the shared fence until evidence is rechecked', async () => {
  const f = fixture(); f.create('bad'); await f.security().available();
  f.store().beginRun('bad', 'run'); f.store().prepareLocalDispatch('bad', { prompt: 'test' });
  f.db.prepare("UPDATE remote_state SET value='{' WHERE key='run:bad'").run();
  f.reopen(); await f.security().available();
  f.db.prepare("UPDATE remote_state SET value='changed' WHERE key='run:bad'").run();
  f.reopen(); await expect(f.security().available()).rejects.toThrow('recovery');
  expect(f.store().needsSecurityRecovery()).toBe(true);
});


it.each([false, true])('mobile damaged-run scoping requires original signed command evidence (missing=%s)', async missing => {
  const f = fixture(); f.create('bad'); f.create('good'); const security = f.security(); await security.available();
  f.store().bindRemote('bad', 'remote-session', 'device');
  f.store().beginRun('bad', 'run', 'command');
  const request = { commandId: 'command', type: 'send_message', payload: { prompt: 'continue' } };
  const operation = { owner, commandId: 'command', requestHash: payloadHash(request), sessionId: 'bad', runId: 'run', phase: 'executing', inboxKey: 'inbox:command' };
  await security.commit('command', operation, () => f.store().put('inbox:command', {
    owner, localSessionId: 'bad', remoteSessionId: 'remote-session', runId: 'run', state: 'executing', result: null,
    command: { commandId: 'command', runId: 'run', type: 'send_message', request, requestHash: payloadHash(request),
      claimId: 'claim', claimToken: 'permit', claimUntil: '2026-09-30T12:00:00Z' },
  }));
  expect(f.db.prepare("SELECT origin FROM local_execution_origin WHERE session_id='bad'").get()).toEqual({ origin: 'mobile' });
  if (missing) f.store().remove('inbox:command');
  f.db.prepare("UPDATE remote_state SET value='{' WHERE key='run:bad'").run();
  f.reopen();
  if (missing) {
    await expect(f.security().available()).rejects.toThrow('recovery');
    expect(f.store().isRunIsolated('bad')).toBe(false);
  } else {
    await f.security().available();
    expect(f.store().isRunIsolated('bad')).toBe(true);
    expect(f.store().isTaskAdmitted('bad')).toBe(false);
    expect(f.store().isTaskAdmitted('good')).toBe(true);
    expect(f.store().hasCompleteExecutionHistory()).toBe(false);
    expect(f.store().get('inbox:command')).toMatchObject({ state: 'executing' });
  }
});


it('automatically recovers a store-only request without a failed coordinator operation', async () => {
  const f = fixture(); const security = f.security(); await security.available();
  f.store().setSecurityRecoveryRequired(true);
  await security.available();
  expect(security.recoveryState()).toMatchObject({ required: false, attempts: 0, recovering: false });
  expect(f.store().needsSecurityRecovery()).toBe(false);
});

it('continues background evidence probes after four failures and never replays the apply closure', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const f = fixture(); const security = f.security(); await security.available();
  let applications = 0;
  f.io.failWrite = f.io.writes + 2;
  await expect(security.commit('original', {}, () => { applications++; })).rejects.toThrow();
  f.io.failWrite = 0;
  const restart = vi.spyOn(f.io, 'restart').mockRejectedValue(new Error('temporary storage failure'));
  for (let i = 0; i < 6; i++) { await security.recover(); await vi.advanceTimersByTimeAsync(75000); }
  expect(security.recoveryState().attempts).toBeGreaterThan(4);
  restart.mockResolvedValue();
  await vi.advanceTimersByTimeAsync(75000);
  await vi.waitFor(() => expect(security.recoveryState().required).toBe(false));
  expect(applications).toBe(1);
});

it('does not release evidence or restart again after coordinator close', async () => {
  const f = fixture(); const security = f.security(); await security.available();
  f.store().setSecurityRecoveryRequired(true); security.close();
  await expect(security.available()).rejects.toThrow('closed');
  await expect(security.recover()).rejects.toThrow();
  expect(f.store().needsSecurityRecovery()).toBe(true);
});
