import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

import { type RemoteOwner, RemoteRunStatus } from '../../shared/remote/constants';
import type { CoworkStore } from '../coworkStore';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { recordRemoteSessionDeletion } from './remoteLocalGc';
import { RemoteStore } from './remoteStore';
import { SessionDeletionService } from './sessionDeletionService';

const databases: Database.Database[] = [];
const originalOwner: RemoteOwner = { userId: 'owner-a', scopeKey: 'personal' };
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const db of databases.splice(0)) db.close();
});

function fixture(ids = ['first']) {
  vi.useFakeTimers();
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER)`);
  const remote = new RemoteStore(db, { deferredProjection: true, restoreRuns: false });
  remote.transaction(() => {
    for (const id of ids) {
      db.prepare("INSERT INTO cowork_sessions VALUES (?, 'Task', 1, 1, 'idle')").run(id);
      remote.assignNew(id, originalOwner, 'local_create');
      remote.beginRun(id, `run-${id}`);
      remote.updateRun(id, RemoteRunStatus.Reconciling);
    }
  });
  let actor: RemoteOwner | null = originalOwner;
  let accountEpoch = 1;
  const runtime = {
    isSessionActive: vi.fn(() => false),
    cancelSessionConfirmed: vi.fn(async (_sessionId: string) => true),
  };
  const deletedRuns = new Map<string, ReturnType<RemoteStore['run']>>();
  const deleteSession = vi.fn((id: string) => {
    deletedRuns.set(id, remote.run(id));
    recordRemoteSessionDeletion(remote, id);
    db.prepare('DELETE FROM cowork_sessions WHERE id=?').run(id);
  });
  const core = { remote, runSessionTransaction: <T>(operation: () => T) => remote.transaction(operation), deleteSession } as unknown as CoworkStore;
  const cleanup = vi.fn();
  const service = new SessionDeletionService(core, runtime as unknown as CoworkRuntime, cleanup, () => actor, () => accountEpoch);
  const updateRun = vi.spyOn(remote, 'updateRun');
  return { db, remote, runtime, service, cleanup, updateRun, deleteSession, deletedRuns,
    exists: (id = 'first') => Boolean(db.prepare('SELECT 1 FROM cowork_sessions WHERE id=?').get(id)),
    switchAccount: (owner: RemoteOwner | null) => { actor = owner; accountEpoch++; },
  };
}

function deferStop(f: ReturnType<typeof fixture>) {
  let confirm!: (confirmed: boolean) => void;
  f.runtime.cancelSessionConfirmed.mockImplementationOnce(() => new Promise<boolean>(resolve => { confirm = resolve; }));
  return (confirmed = true) => confirm(confirmed);
}

test('deletes a locally idle task with an old reconciling run only after confirmed stopping', async () => {
  const f = fixture();
  const confirm = deferStop(f);
  const operation = f.service.deleteLocal('first');
  expect(f.exists()).toBe(true);
  expect(f.updateRun).not.toHaveBeenCalled();
  confirm();
  await operation;
  expect(f.exists()).toBe(false);
  expect(f.runtime.cancelSessionConfirmed).toHaveBeenCalledExactlyOnceWith('first');
  expect(f.deletedRuns.get('first')?.status).toBe(RemoteRunStatus.Cancelled);
  expect(f.cleanup).toHaveBeenCalledExactlyOnceWith('first');
});

test.each([false, new Error('Gateway unavailable')])('preserves the run and task when stopping fails: %s', async result => {
  const f = fixture();
  if (result instanceof Error) f.runtime.cancelSessionConfirmed.mockRejectedValueOnce(result);
  else f.runtime.cancelSessionConfirmed.mockResolvedValueOnce(result);
  await expect(f.service.deleteLocal('first')).rejects.toThrow();
  expect(f.exists()).toBe(true);
  expect(f.remote.run('first')?.status).toBe(RemoteRunStatus.Reconciling);
  expect(f.remote.get('localGcDeleted:first')).toBeNull();
  expect(f.updateRun).not.toHaveBeenCalled();
  expect(f.cleanup).not.toHaveBeenCalled();
});

test.each([false, true])('rejects an account change before writing stop state, including ABA=%s', async returnToOriginal => {
  const f = fixture();
  const confirm = deferStop(f);
  const operation = f.service.deleteLocal('first');
  f.switchAccount({ userId: 'owner-b', scopeKey: 'personal' });
  if (returnToOriginal) f.switchAccount(originalOwner);
  confirm();
  await expect(operation).rejects.toThrow();
  expect(f.exists()).toBe(true);
  expect(f.remote.run('first')?.status).toBe(RemoteRunStatus.Reconciling);
  expect(f.updateRun).not.toHaveBeenCalled();
  expect(f.deleteSession).not.toHaveBeenCalled();
});

test.each(['guard', 'run', 'removed run'] as const)('rejects a changed %s before writing stop state', async changed => {
  const f = fixture();
  const confirm = deferStop(f);
  const operation = f.service.deleteLocal('first');
  if (changed === 'guard') f.remote.advanceDeletionGuard('first');
  else if (changed === 'run') f.remote.put('run:first', { ...f.remote.run('first'), runId: 'replacement-run' });
  else f.remote.remove('run:first');
  confirm();
  await expect(operation).rejects.toThrow();
  expect(f.exists()).toBe(true);
  expect(f.updateRun).not.toHaveBeenCalled();
  expect(f.deleteSession).not.toHaveBeenCalled();
});

test.each([RemoteRunStatus.Succeeded, RemoteRunStatus.Failed, RemoteRunStatus.Interrupted])('preserves a natural %s outcome observed while stopping', async status => {
  const f = fixture();
  const confirm = deferStop(f);
  const operation = f.service.deleteLocal('first');
  f.remote.updateRun('first', status);
  f.updateRun.mockClear();
  confirm();
  await operation;
  expect(f.exists()).toBe(false);
  expect(f.updateRun).not.toHaveBeenCalled();
  expect(f.deletedRuns.get('first')?.status).toBe(status);
});

test('checks every batch target after awaiting the first stop', async () => {
  const f = fixture(['first', 'second']);
  const confirm = deferStop(f);
  const operation = f.service.deleteLocalBatch(['first', 'second']);
  f.remote.advanceDeletionGuard('second');
  confirm();
  await expect(operation).rejects.toThrow();
  expect(f.runtime.cancelSessionConfirmed).toHaveBeenCalledExactlyOnceWith('first');
  expect(f.updateRun).not.toHaveBeenCalled();
  expect(f.exists('first')).toBe(true);
  expect(f.exists('second')).toBe(true);
});

test('checks already stopped batch targets while awaiting a later stop', async () => {
  const f = fixture(['first', 'second']);
  let confirmSecond!: (confirmed: boolean) => void;
  f.runtime.cancelSessionConfirmed.mockImplementation(async id => id === 'first'
    ? true : new Promise<boolean>(resolve => { confirmSecond = resolve; }));
  const operation = f.service.deleteLocalBatch(['first', 'second']);
  await Promise.resolve();
  f.remote.advanceDeletionGuard('first');
  f.updateRun.mockClear();
  confirmSecond(true);
  await expect(operation).rejects.toThrow();
  expect(f.updateRun).not.toHaveBeenCalled();
  expect(f.deleteSession).not.toHaveBeenCalled();
  expect(f.exists('first')).toBe(true);
  expect(f.exists('second')).toBe(true);
});

test('keeps every batch task when a later stop remains unconfirmed', async () => {
  const f = fixture(['first', 'second']);
  f.runtime.cancelSessionConfirmed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.service.deleteLocalBatch(['first', 'second'])).rejects.toThrow();
  expect(f.exists('first')).toBe(true);
  expect(f.exists('second')).toBe(true);
  expect(f.remote.run('first')?.status).toBe(RemoteRunStatus.Cancelled);
  expect(f.remote.run('second')?.status).toBe(RemoteRunStatus.Reconciling);
  expect(f.deleteSession).not.toHaveBeenCalled();
  expect(f.cleanup).not.toHaveBeenCalled();
});
