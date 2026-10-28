import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { afterEach, expect, it, vi } from 'vitest';

import type { RemoteOwner } from '../../shared/remote/constants';
import type { CoworkStore } from '../coworkStore';
import type { CoworkRuntime, CoworkSessionRecoverySnapshot } from '../libs/agentEngine/types';
import type { RemoteModelCatalog } from './remoteModelCatalog';
import { RemoteStore } from './remoteStore';
import { SessionCommandService } from './sessionCommandService';

const owner = { userId: 'A', scopeKey: 'personal' };
const dispose: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); for (const close of dispose.splice(0)) close(); });
function fixture() {
  const db = new Database(':memory:'); dispose.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,agent_id TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const remote = new RemoteStore(db);
  remote.transaction(() => {
    for (const id of ['task', 'other']) {
      db.prepare("INSERT INTO cowork_sessions VALUES(?, 'Task', 1, 1, 'idle', 'main', 'provider/old', 'low')").run(id);
      remote.assignNew(id, owner, 'local_create');
    }
  });
  let actor: RemoteOwner | null = owner;
  let generation = 0;
  const store = { remote, getSession: (id: string) => {
    const row = db.prepare('SELECT * FROM cowork_sessions WHERE id=?').get(id) as Record<string, string> | undefined;
    return row ? { id, agentId: 'main', cwd: '/tmp', modelOverride: row.model_override, thinkingLevel: row.thinking_level, status: row.status } : null;
  }, updateSession: (id: string, patch: Record<string, unknown>) => {
    remote.transaction(() => {
      for (const [key, column] of [['modelOverride', 'model_override'], ['thinkingLevel', 'thinking_level'], ['status', 'status']]) {
        if (patch[key] !== undefined) db.prepare(`UPDATE cowork_sessions SET ${column}=? WHERE id=?`).run(patch[key], id);
      }
    });
  }, getAgent: () => ({ enabled: true, model: 'provider/old' }), assertAgentAccess: vi.fn(),
  agentOwnership: { get: () => ({ version: '1' }), canView: () => true } } as unknown as CoworkStore;
  const runtime = Object.assign(new EventEmitter(), { cancelSessionConfirmed: vi.fn(async () => true), isSessionActive: vi.fn(() => false),
    querySessionRecovery: vi.fn(async (): Promise<CoworkSessionRecoverySnapshot | null> => null),
    restoreSessionObservation: vi.fn(() => true), patchSession: vi.fn(async () => ({ modelOverride: 'provider/new' })),
    getRecoveryGatewayBootId: () => 'boot', getRecoveryGatewayProcessPid: () => 1234 });
  const onRecovered = vi.fn();
  let ready = true;
  let target = 'test';
  const createService = () => {
    const value = new SessionCommandService(store, runtime as unknown as CoworkRuntime, () => actor,
      { getGeneration: () => generation, onRecovered, canRecover: () => ready, recoveryTarget: () => target });
    dispose.push(() => value.recovery.dispose());
    return value;
  };
  const service = createService();
  const snapshot = (patch: Partial<CoworkSessionRecoverySnapshot> = {}): CoworkSessionRecoverySnapshot => ({
    gatewayBootId: 'boot', gatewayProcessPid: 1234, sessionKey: 'agent:main:lobsterai:task', runId: 'gateway-run',
    status: 'unknown', hasActiveRun: false, configuration: { modelOverride: 'provider/new', thinkingLevel: 'high' }, ...patch });
  const pendingRun = () => {
    remote.beginRun('task', 'original-run', 'original-command');
    remote.put('gatewayRun:task', { runId: 'gateway-run', remoteRunId: 'original-run' });
    remote.updateRun('task', 'running');
    // Exercise the actual process-start reconciliation, retaining the same isolated database.
    new RemoteStore(db);
    expect(remote.run('task')?.status).toBe('reconciling');
  };
  return { db, remote, store, runtime, service, createService, snapshot, pendingRun, onRecovered,
    setReady: (next: boolean) => { ready = next; }, setTarget: (next: string) => { target = next; },
    switchAccount: (next: RemoteOwner | null) => { actor = next; generation++; } };
}

it('recovers a persisted exact run terminal without replaying the original command', async () => {
  const f = fixture(); f.pendingRun();
  f.runtime.querySessionRecovery.mockResolvedValue(f.snapshot({ status: 'succeeded' }));
  const nextSend = vi.fn(async () => ({ success: true }));
  await expect(f.service.submit({ sessionId: 'task' }, false, nextSend)).resolves.toEqual({ success: true });
  expect(f.remote.run('task')).toMatchObject({ runId: 'original-run', status: 'succeeded' });
  expect(f.store.getSession('task')?.status).toBe('completed');
  expect(f.onRecovered).toHaveBeenCalledWith('task');
  expect(nextSend).toHaveBeenCalledTimes(1); expect(f.runtime.patchSession).not.toHaveBeenCalled();
  expect(f.runtime.restoreSessionObservation).not.toHaveBeenCalled();
});

it('restores observation of the exact running task, without dispatching it again', async () => {
  const f = fixture(); f.pendingRun();
  f.runtime.querySessionRecovery.mockResolvedValue(f.snapshot({ status: 'running', hasActiveRun: true }));
  await expect(f.service.reconcileSession('task')).resolves.toBe(false);
  expect(f.runtime.restoreSessionObservation).toHaveBeenCalledTimes(1);
  expect(f.remote.run('task')?.status).toBe('running');
  f.runtime.emit('complete', 'task');
  expect(f.remote.run('task')?.status).toBe('succeeded');
});

it('requires the original writer to exit even when a lost model ACK reads back the intended value', async () => {
  const f = fixture(); f.runtime.patchSession.mockImplementationOnce(async () => {
    f.remote.put('inputFence:task', { ...f.remote.get<Record<string, unknown>>('inputFence:task'), gatewayProcessPid: 1234 });
    throw new Error('lost ACK');
  });
  await expect(f.service.patchConfiguration('task', { model: 'provider/new', thinkingLevel: 'high' })).rejects.toThrow('lost ACK');
  expect(f.remote.get('inputFence:task')).toMatchObject({ target: { model: 'provider/new', thinkingLevel: 'high' }, gatewayProcessPid: 1234 });
  f.runtime.querySessionRecovery.mockResolvedValue(f.snapshot());
  await expect(f.createService().reconcileSession('task')).resolves.toBe(false);
  expect(f.remote.get('inputFence:task')).not.toBeNull();
  f.runtime.querySessionRecovery.mockResolvedValue(f.snapshot({ gatewayProcessPid: 5678, previousWriterStopped: true }));
  await expect(f.service.reconcileSession('task')).resolves.toBe(true);
  expect(f.store.getSession('task')).toMatchObject({ modelOverride: 'provider/new', thinkingLevel: 'high' });
  expect(f.remote.inputVersion('task')).toBe('1'); expect(f.remote.get('inputFence:task')).toBeNull();
  expect(f.runtime.patchSession).toHaveBeenCalledTimes(1);
});

it('does not treat an older actual value or a new server boot in the same process as a failed patch', async () => {
  const f = fixture(); f.remote.put('inputFence:task', { operationId: 'old', target: { model: 'provider/new' }, gatewayBootId: 'old', gatewayProcessPid: 1234 });
  f.runtime.querySessionRecovery.mockResolvedValue(f.snapshot({ gatewayBootId: 'new', configuration: { modelOverride: 'provider/old', thinkingLevel: 'low' } }));
  await expect(f.service.reconcileSession('task')).resolves.toBe(false);
  expect(f.remote.get('inputFence:task')).not.toBeNull();
});

it('does not attribute a historical targetless fence to a later process', async () => {
  const f = fixture(); f.remote.put('inputFence:task', { operationId: 'legacy', phase: 'model_applying' });
  f.runtime.querySessionRecovery.mockResolvedValue(f.snapshot({ gatewayProcessPid: 5678, previousWriterStopped: true }));
  await expect(f.service.reconcileSession('task')).resolves.toBe(false);
  expect(f.remote.get('inputFence:task')).toEqual({ operationId: 'legacy', phase: 'model_applying' });
});

it('adopts actual configuration only after the recorded original writer has exited', async () => {
  const f = fixture(); f.remote.put('inputFence:task', { operationId: 'old', phase: 'model_applying', gatewayProcessPid: 1234,
    target: { model: 'provider/attempted' } });
  f.runtime.querySessionRecovery.mockResolvedValue(f.snapshot({ gatewayProcessPid: 5678, previousWriterStopped: true }));
  await expect(f.service.reconcileSession('task')).resolves.toBe(true);
  expect(f.runtime.querySessionRecovery).toHaveBeenLastCalledWith('task', undefined, 1234);
  expect(f.remote.get('inputFence:task')).toBeNull();
  expect(f.store.getSession('task')?.modelOverride).toBe('provider/new');
});

it('does not terminate a task still active in this process even when an old terminal is returned', async () => {
  const f = fixture(); f.pendingRun(); f.runtime.isSessionActive.mockReturnValue(true);
  f.runtime.querySessionRecovery.mockResolvedValue(f.snapshot({ status: 'succeeded' }));
  await expect(f.service.reconcileSession('task')).resolves.toBe(false);
  expect(f.remote.run('task')?.status).toBe('reconciling');
});

it('rejects a late recovery response after account switch and preserves the original state', async () => {
  const f = fixture(); f.pendingRun(); let resolve!: (s: CoworkSessionRecoverySnapshot) => void;
  f.runtime.querySessionRecovery.mockImplementation(() => new Promise(r => { resolve = r; }));
  const pending = f.service.reconcileSession('task');
  f.switchAccount({ userId: 'B', scopeKey: 'personal' }); resolve(f.snapshot({ status: 'succeeded' }));
  await expect(pending).resolves.toBe(false); expect(f.remote.run('task')?.status).toBe('reconciling');
});

it('rejects an old recovery receipt after a new run replaced the captured run', async () => {
  const f = fixture(); f.pendingRun(); let resolve!: (s: CoworkSessionRecoverySnapshot) => void;
  f.runtime.querySessionRecovery.mockImplementation(() => new Promise(r => { resolve = r; }));
  const pending = f.service.reconcileSession('task');
  f.remote.updateRun('task', 'cancelled'); f.remote.beginRun('task', 'new-run'); resolve(f.snapshot({ status: 'succeeded' }));
  await expect(pending).resolves.toBe(false); expect(f.remote.run('task')).toMatchObject({ runId: 'new-run', status: 'starting' });
});

it('bounds and deduplicates unknown recovery while new tasks and unrelated sessions remain usable', async () => {
  vi.useFakeTimers(); const f = fixture(); f.pendingRun(); let resolve!: (s: CoworkSessionRecoverySnapshot) => void;
  f.runtime.querySessionRecovery.mockImplementation(() => new Promise(r => { resolve = r; }));
  const first = f.service.reconcileSession('task'); expect(f.service.reconcileSession('task')).toBe(first);
  const send = vi.fn(async () => ({ success: true }));
  await expect(f.service.submit({ agentId: 'main' }, true, send)).resolves.toEqual({ success: true });
  await expect(f.service.submit({ sessionId: 'other' }, false, send)).resolves.toEqual({ success: true });
  await vi.advanceTimersByTimeAsync(4500); await expect(first).resolves.toBe(false);
  resolve(f.snapshot({ status: 'succeeded' })); await Promise.resolve();
  expect(f.remote.run('task')?.status).toBe('reconciling'); expect(send).toHaveBeenCalledTimes(2);
});

it('local create, continue, model update and completion need neither a registered device nor remote transport', async () => {
  const f = fixture();
  const unreachableCatalog = { resolveRuntime: vi.fn(() => { throw new Error('HTTP 503 / WS disconnected'); }) } as unknown as RemoteModelCatalog;
  f.service.configureInput({ models: unreachableCatalog, preparations: {} as never, getDeviceId: () => undefined });
  const send = vi.fn(async () => ({ success: true }));
  await expect(f.service.submit({ agentId: 'main' }, true, send)).resolves.toEqual({ success: true });
  await expect(f.service.submit({ sessionId: 'task' }, false, send)).resolves.toEqual({ success: true });
  await expect(f.service.patchConfiguration('task', { model: 'provider/new' })).resolves.toMatchObject({ modelOverride: 'provider/new' });
  f.remote.beginRun('task', 'local'); f.runtime.emit('complete', 'task');
  expect(f.remote.run('task')?.status).toBe('succeeded');
  expect(unreachableCatalog.resolveRuntime).not.toHaveBeenCalled(); expect(f.runtime.querySessionRecovery).not.toHaveBeenCalled();
});

it('pages state keys without changing the single-argument entries contract', () => {
  const f = fixture(); for (const id of ['c', 'a', 'b']) f.remote.put(`page:${id}`, id);
  expect(f.remote.entries('page:')).toHaveLength(3);
  expect(f.remote.entries('page:', '', 2).map(x => x.key)).toEqual(['page:a', 'page:b']);
  expect(f.remote.entries('page:', 'page:b', 2).map(x => x.key)).toEqual(['page:c']);
});

it('clears a new prepared configuration only when the current process proves dispatch never occurred', async () => {
  const f = fixture();
  f.runtime.patchSession.mockRejectedValueOnce(new Error('gateway unavailable before dispatch'));
  await expect(f.service.patchConfiguration('task', { model: 'provider/new' })).rejects.toThrow('gateway unavailable');
  expect(f.remote.get('inputFence:task')).toBeNull();
  expect(f.remote.entries<{ phase: string }>('inputOperation:').at(-1)?.value.phase).toBe('known_not_applied');
  const send = vi.fn(async () => ({ success: true }));
  await expect(f.service.submit({ sessionId: 'task' }, false, send)).resolves.toEqual({ success: true });
  expect(send).toHaveBeenCalledOnce();
});

it('does not reinterpret a restored prepared record as proof of non-dispatch', async () => {
  const f = fixture();
  f.remote.put('inputFence:task', { schemaVersion: 2, phase: 'prepared', operationId: 'restored', preparedProcessId: 'previous-process' });
  f.runtime.querySessionRecovery.mockResolvedValue(f.snapshot({ previousWriterStopped: true }));
  await expect(f.service.reconcileSession('task')).resolves.toBe(false);
  expect(f.remote.get('inputFence:task')).not.toBeNull();
});


it('automatically recovers after slow Gateway readiness, without opening history or sending again', async () => {
  vi.useFakeTimers(); const f = fixture(); f.pendingRun(); f.setReady(false);
  f.service.recovery.gatewayReady(); await vi.advanceTimersByTimeAsync(10000);
  expect(f.runtime.querySessionRecovery).not.toHaveBeenCalled();
  f.runtime.querySessionRecovery.mockResolvedValue(f.snapshot({ status: 'succeeded' }));
  f.setReady(true); f.service.recovery.gatewayReady(); await vi.advanceTimersByTimeAsync(0);
  expect(f.remote.run('task')?.status).toBe('succeeded');
  expect(f.runtime.cancelSessionConfirmed).not.toHaveBeenCalled();
});

it('restarts an unfinished explicit stop automatically and retries a transient confirmation failure', async () => {
  vi.useFakeTimers(); const f = fixture(); f.pendingRun();
  f.service.recovery.rememberStop('task'); f.service.recovery.dispose();
  const restarted = f.createService();
  f.runtime.querySessionRecovery.mockResolvedValue(f.snapshot());
  f.runtime.cancelSessionConfirmed.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  restarted.recovery.gatewayReady(); await vi.advanceTimersByTimeAsync(0);
  expect(f.remote.run('task')?.status).toBe('reconciling');
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.remote.run('task')?.status).toBe('cancelled');
  expect(f.runtime.cancelSessionConfirmed).toHaveBeenCalledTimes(2);
  expect(f.remote.get('pendingRunStop:task')).toBeNull();
});

it('ordinary reconnection restores a live run without cancelling or replaying it', async () => {
  vi.useFakeTimers(); const f = fixture(); f.pendingRun();
  f.runtime.querySessionRecovery.mockResolvedValue(f.snapshot({ status: 'running', hasActiveRun: true }));
  f.service.recovery.gatewayReady(); f.service.recovery.gatewayReady();
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.remote.run('task')?.status).toBe('running');
  expect(f.runtime.restoreSessionObservation).toHaveBeenCalledTimes(1);
  expect(f.runtime.cancelSessionConfirmed).not.toHaveBeenCalled();
});

it('keeps retry attempts bounded and allows a later readiness event to retry again', async () => {
  vi.useFakeTimers(); const f = fixture(); f.pendingRun();
  f.service.recovery.gatewayReady(); await vi.advanceTimersByTimeAsync(60000);
  expect(f.runtime.querySessionRecovery).toHaveBeenCalledTimes(4);
  expect(f.remote.run('task')?.status).toBe('reconciling');
  f.service.recovery.gatewayReady(); await vi.advanceTimersByTimeAsync(0);
  expect(f.runtime.querySessionRecovery).toHaveBeenCalledTimes(5);
});

it('deduplicates concurrent stop requests and preserves natural completion', async () => {
  const f = fixture(); f.pendingRun();
  const response = Promise.withResolvers<boolean>(); f.runtime.cancelSessionConfirmed.mockReturnValue(response.promise);
  const first = f.service.recovery.requestStop('task');
  const second = f.service.recovery.requestStop('task');
  expect(f.runtime.cancelSessionConfirmed).toHaveBeenCalledTimes(1);
  f.runtime.emit('complete', 'task'); response.resolve(true);
  await Promise.all([first, second]);
  expect(f.remote.run('task')?.status).toBe('succeeded');
});

it.each(['account', 'target', 'run'])('rejects a stop result after changing %s', async change => {
  const f = fixture(); f.pendingRun();
  const response = Promise.withResolvers<boolean>(); f.runtime.cancelSessionConfirmed.mockReturnValue(response.promise);
  const stopping = f.service.recovery.requestStop('task');
  if (change === 'account') f.switchAccount({ userId: 'B', scopeKey: 'personal' });
  else if (change === 'target') f.setTarget('other');
  else { f.remote.updateRun('task', 'succeeded'); f.remote.beginRun('task', 'new-run'); }
  response.resolve(true); await expect(stopping).resolves.toBe(false);
  expect(f.remote.run('task')?.status).toBe(change === 'run' ? 'starting' : 'reconciling');
});

it('does not resume a stop intent from another service environment', async () => {
  vi.useFakeTimers(); const f = fixture(); f.pendingRun(); f.service.recovery.rememberStop('task');
  f.setTarget('other'); f.service.recovery.gatewayReady(); await vi.advanceTimersByTimeAsync(0);
  expect(f.runtime.cancelSessionConfirmed).not.toHaveBeenCalled();
});

it('bounds quit confirmation and retains intent for next startup without letting late results mutate state', async () => {
  vi.useFakeTimers(); const f = fixture(); f.pendingRun(); f.service.recovery.rememberStop('task');
  f.service.recovery.dispose(); const response = Promise.withResolvers<boolean>();
  f.runtime.cancelSessionConfirmed.mockReturnValue(response.promise);
  const quit = f.service.recovery.finishShutdown(['task'], 3000);
  await vi.advanceTimersByTimeAsync(3000); await quit;
  expect(f.remote.get('pendingRunStop:task')).toMatchObject({ runId: 'original-run' });
  await vi.advanceTimersByTimeAsync(1); response.resolve(true); await Promise.resolve(); await Promise.resolve();
  expect(f.remote.run('task')?.status).toBe('reconciling');
  expect(vi.getTimerCount()).toBe(0);
});


it.each([{}, { owner: {} }, { owner: null }, { owner, targetId: 123 }])('ignores incomplete persisted stop intent %j', async fields => {
  vi.useFakeTimers(); const f = fixture(); f.pendingRun();
  f.remote.put('pendingRunStop:task', { runId: 'original-run', ...fields });
  f.service.recovery.gatewayReady(); await vi.advanceTimersByTimeAsync(60000);
  expect(f.runtime.cancelSessionConfirmed).not.toHaveBeenCalled();
  expect(f.remote.run('task')?.status).toBe('reconciling');
});

it('yields between history pages and still reaches the pending stop', async () => {
  const f = fixture(); f.pendingRun(); f.service.recovery.rememberStop('task');
  for (let index = 0; index < 70; index++) {
    f.remote.put(`run:history-${index}`, { runId: `old-${index}`, status: 'succeeded' });
  }
  const scan = f.remote.scanEntries.bind(f.remote);
  let yielded = false, pages = 0;
  const subsequentPageYields: boolean[] = [];
  const spy = vi.spyOn(f.remote, 'scanEntries').mockImplementation((...args) => {
    if (args[0] === 'run:') {
      if (++pages === 1) setImmediate(() => { yielded = true; });
      else subsequentPageYields.push(yielded);
    }
    return scan(...args);
  });
  try {
    f.service.recovery.gatewayReady();
    await vi.waitFor(() => expect(f.remote.run('task')?.status).toBe('cancelled'));
    expect(pages).toBeGreaterThan(1);
    expect(subsequentPageYields.every(Boolean)).toBe(true);
    expect(f.runtime.cancelSessionConfirmed).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
});
