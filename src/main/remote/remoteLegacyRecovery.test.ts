import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { payloadHash } from './canonical';
import { RemoteLegacyRecovery } from './remoteLegacyRecovery';
import type { RemoteStore, SyncRow } from './remoteStore';
import { readRecoveryLedger, RemoteRecoveryLimiter } from './remoteSyncRecoveryLedger';
import { recoveryFailure } from './remoteSyncRecoveryPolicy';
import { RemoteTaskSyncState, TaskSyncPhase } from './remoteTaskSyncState';
const context = { owner: { userId: 'owner', scopeKey: 'personal' }, target: 'target', deviceId: 'device' };
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture(code = 47019, status = 400, reason = 'INVALID_REMOTE_REQUEST') {
  const db = new Database(':memory:'); databases.push(db);
  db.exec('CREATE TABLE remote_state(key TEXT PRIMARY KEY,value TEXT)');
  let now = 100000, active = true, admitted = true;
  let dependency: number | null = 0;
  const row = { local_id: 'local', session_id: 'remote', device_id: 'device', sync_environment: 'target', sync_protocol_version: 2,
    stream_epoch: 'epoch', ack_seq: 1, source_seq: 2, server_seq: '1', needs_snapshot: 1, migration_frozen: 0 } as SyncRow;
  const get = <T>(key: string): T | null => { const saved = db.prepare('SELECT value FROM remote_state WHERE key=?').get(key) as any; return saved ? JSON.parse(saved.value) : null; };
  const put = (key: string, value: unknown) => db.prepare('INSERT OR REPLACE INTO remote_state VALUES(?,?)').run(key, JSON.stringify(value));
  const store = { db, get, put, sync: () => row, owner: () => context.owner, isSyncClosed: () => false,
    transaction: <T>(operation: () => T) => db.transaction(operation)() } as unknown as RemoteStore;
  const tasks = new RemoteTaskSyncState(db, () => now, () => 0.5);
  tasks.fail(context, 'local', { phase: TaskSyncPhase.Isolated, scope: 'session', reason });
  put('syncFailure:local', { code, httpStatus: status, reason });
  const saved = { importId: 'original', sessionId: 'remote', manifest: { manifestHash: payloadHash('original') }, baseSourceSeq: '2',
    expectedSourceSeq: '1', expectedServerSeq: '1', syncProtocolVersion: 2, expectedStreamEpoch: 'epoch', targetStreamEpoch: 'epoch', parts: [] };
  put('import:local', saved);
  const receipt = { ...saved, manifestHash: saved.manifest.manifestHash, state: 'expired', stateVersion: '2' };
  const readImport = vi.fn(async () => receipt), readState = vi.fn(async () => ({ deviceId: 'device', sessionId: 'remote', localSessionId: 'local',
    syncProtocolVersion: 2, streamEpoch: 'epoch', lastSourceSeq: '1', lastSeq: '1', sourcePurgeSeq: '0', eventPurgeSeq: '0', activeImport: null }));
  const partsAvailable = vi.fn(async () => true), validateImport = vi.fn();
  const capabilities = { capabilities: ['sync_retention_v2'], syncRetention: { version: 2 }, projectionVersions: [1] };
  const deps = { store, tasks, dependencyEpoch: () => dependency, limiter: new RemoteRecoveryLimiter(() => now), capabilities: () => capabilities, admitted: () => admitted,
    readImport, readState, validateImport, partsAvailable, now: () => now };
  let coordinator = new RemoteLegacyRecovery(deps);
  const tick = () => coordinator.tick(context, () => active);
  return { db, row, store, tasks, saved, receipt, readImport, readState, partsAvailable, capabilities, put, tick,
    state: () => tasks.get(context, 'local')!, advance: (ms = 30000) => { now += ms; }, stop: () => { active = false; }, deny: () => { admitted = false; },
    dependency: (epoch: number | null) => { dependency = epoch; },
    restart: () => { coordinator = new RemoteLegacyRecovery(deps); } };
}
describe('legacy automatic recovery queries', () => {
  it.each([[47019, 400, 'INVALID_REMOTE_REQUEST'], [47006, 409, 'IDEMPOTENCY_CONFLICT'], [47009, 426, 'PROTOCOL_UNSUPPORTED']])('automatically verifies old %s without posting or clearing errors', async (code, status, reason) => {
    const f = fixture(code as number, status as number, reason as string);
    if (code === 47006) f.receipt.state = 'committed';
    await f.tick(); expect(f.readImport).not.toHaveBeenCalled(); f.advance();
    await f.tick(); expect(f.readImport).toHaveBeenCalledOnce(); expect(f.readState).not.toHaveBeenCalled();
    expect(f.state().phase).toBe(TaskSyncPhase.Isolated); await f.tick();
    expect(f.state().phase).toBe(TaskSyncPhase.Reconciling); expect(f.row.ack_seq).toBe(1);
    expect(f.store.get('syncFailure:local')).not.toBeNull(); expect(f.store.get('import:local')).toEqual(f.saved);
    expect(readRecoveryLedger(f.state().auto_probe_json)!.rounds[0].outcome).toBe('verified');
  });
  it('retains original identity across restart and completes evidence collection', async () => {
    const f = fixture(); await f.tick(); f.advance(); await f.tick();
    const before = readRecoveryLedger(f.state().auto_probe_json)!; f.restart(); await f.tick(); await f.tick();
    expect(readRecoveryLedger(f.state().auto_probe_json)!.times).toEqual(before.times); expect(f.state().phase).toBe(TaskSyncPhase.Reconciling);
  });
  it('does not treat import 404 or an unrelated state success as permission to rebuild', async () => {
    const f = fixture(); f.readImport.mockRejectedValue(Object.assign(new Error('missing'), { httpStatus: 404 }));
    await f.tick(); f.advance(); await f.tick(); await f.tick();
    expect(f.state().phase).toBe(TaskSyncPhase.Isolated); expect(f.readState).not.toHaveBeenCalled(); expect(f.store.get('import:local')).toEqual(f.saved);
  });
  it('blocks mismatched receipts and missing local parts', async () => {
    const f = fixture(); f.receipt.state = 'uploading'; f.partsAvailable.mockResolvedValue(false);
    await f.tick(); f.advance(); await f.tick(); await f.tick(); expect(f.state().phase).toBe(TaskSyncPhase.Isolated);
    expect(readRecoveryLedger(f.state().auto_probe_json)!.rounds[0].outcome).toBe('blocked');
  });
  it('keeps unknown no-import failures isolated after state verification', async () => {
    const f = fixture(); f.db.prepare('DELETE FROM remote_state WHERE key=?').run('import:local');
    await f.tick(); f.advance(); await f.tick(); expect(f.readState).toHaveBeenCalledOnce(); expect(f.state().phase).toBe(TaskSyncPhase.Isolated);
  });
  it('rejects late results after a deletion fence or changed admission', async () => {
    const f = fixture(); let resolve!: (receipt: any) => void;
    f.readImport.mockImplementation(() => new Promise(done => { resolve = done; }));
    await f.tick(); f.advance(); const ongoing = f.tick(); f.put('deletionFence:local', { state: 'effect_started' }); resolve(f.receipt); await ongoing;
    expect(f.state().phase).toBe(TaskSyncPhase.Isolated); expect(f.readState).not.toHaveBeenCalled();
  });
  it.each(['Immutable part cannot change', 'Import manifest cannot change', 'Part payload hash mismatch', null])('does not rebuild an expired ambiguous or immutable conflict (%s)', async validation => {
    const f = fixture(47006, 409, 'IDEMPOTENCY_CONFLICT');
    f.put('syncFailure:local', { code: 47006, httpStatus: 409, reason: 'IDEMPOTENCY_CONFLICT', validation });
    await f.tick(); f.advance(); await f.tick(); await f.tick();
    expect(f.state().phase).toBe(TaskSyncPhase.Isolated); expect(f.store.get('import:local')).toEqual(f.saved);
  });
  it('does not downgrade v2 when its capability disappears', async () => {
    const f = fixture(); f.capabilities.capabilities = [];
    await f.tick(); f.advance(); await f.tick(); await f.tick();
    expect(f.state().phase).toBe(TaskSyncPhase.Isolated); expect(f.row.sync_protocol_version).toBe(2);
  });
  it('rechecks only a relevant capability improvement and does not reset the round window', async () => {
    const f = fixture(47017, 409, 'CAPABILITY_UNSUPPORTED'); f.capabilities.capabilities = [];
    f.put('syncFailure:local', { code: 47017, httpStatus: 409, reason: 'CAPABILITY_UNSUPPORTED', syncDiagnostic: { version: 1, requiredCapability: 'sync_retention_v2' } });
    await f.tick(); f.advance(); await f.tick(); await f.tick(); expect(f.state().phase).toBe(TaskSyncPhase.Isolated);
    f.capabilities.capabilities.push('unrelated_feature'); f.tasks.wakeRecovery(context); await f.tick(); expect(f.readImport).toHaveBeenCalledTimes(1);
    f.capabilities.capabilities.push('sync_retention_v2'); f.tasks.wakeRecovery(context); await f.tick(); await f.tick();
    expect(f.state().phase).toBe(TaskSyncPhase.Reconciling); expect(readRecoveryLedger(f.state().auto_probe_json)!.times).toHaveLength(2);
  });
  it('honors task CAS after a concurrent manual recovery', async () => {
    const f = fixture(); let resolve!: (receipt: any) => void;
    f.readImport.mockImplementation(() => new Promise(done => { resolve = done; }));
    await f.tick(); f.advance(); const ongoing = f.tick();
    f.db.prepare("UPDATE remote_sync_task_state SET phase='reconciling',failure_count=failure_count+1").run(); resolve(f.receipt); await ongoing;
    expect(f.state().failure_count).toBe(2); expect(readRecoveryLedger(f.state().auto_probe_json)!.rounds[0].inflight).not.toBeNull();
  });
  it('does not confuse a normal deletionGuard with a fence', async () => {
    const f = fixture(); f.put('deletionGuard:local', { version: '3', runId: 'run' });
    await f.tick(); f.advance(); await f.tick(); await f.tick(); expect(f.state().phase).toBe(TaskSyncPhase.Reconciling);
  });
  it('does not query v3-owned or unadmitted tasks', async () => {
    const f = fixture(); f.deny(); await f.tick(); f.advance(); await f.tick(); expect(f.readImport).not.toHaveBeenCalled();
  });
  it('stops corrupt metadata and does not lose it during a later failure', async () => {
    const f = fixture(); f.db.prepare("UPDATE remote_sync_task_state SET auto_probe_json='broken'").run();
    await f.tick(); expect(f.readImport).not.toHaveBeenCalled(); expect(f.state().auto_probe_json).toBe('broken'); expect(f.tasks.manualRetry(context, 'local')).toBe(false);
  });
  it('opens the second bounded round after three network failures and an actual dependency transition', async () => {
    const f = fixture(); f.readImport.mockRejectedValue(new TypeError('fetch failed'));
    await f.tick(); f.advance(); await f.tick(); f.advance(); await f.tick(); f.advance(60000); await f.tick();
    expect(readRecoveryLedger(f.state().auto_probe_json)!.rounds[0].waitingDependency).toBe(true);
    f.restart(); f.tasks.wakeRecovery(context); await f.tick(); expect(f.readImport).toHaveBeenCalledTimes(3);
    f.dependency(1); f.tasks.wakeRecovery(context); f.readImport.mockResolvedValue(f.receipt); await f.tick(); await f.tick();
    expect(f.state().phase).toBe(TaskSyncPhase.Reconciling); expect(readRecoveryLedger(f.state().auto_probe_json)!.times).toHaveLength(2);
  });
  it('does not revive a definitive third rejection with a later dependency transition', async () => {
    const f = fixture(); f.readImport.mockRejectedValue(new TypeError('fetch failed'));
    await f.tick(); f.advance(); await f.tick(); f.advance(); await f.tick(); f.advance(60000);
    f.readImport.mockRejectedValue(Object.assign(new Error('missing receipt'), { httpStatus: 404 })); await f.tick();
    expect(readRecoveryLedger(f.state().auto_probe_json)!.rounds[0].waitingDependency).toBe(false);
    f.dependency(1); f.tasks.wakeRecovery(context); await f.tick(); expect(f.readImport).toHaveBeenCalledTimes(3);
    expect(readRecoveryLedger(f.state().auto_probe_json)!.times).toHaveLength(1);
  });
  it('does not replace a corrupt dependency proof with epoch zero', async () => {
    const f = fixture(); f.dependency(null); await f.tick(); f.advance(); await f.tick(); expect(f.readImport).not.toHaveBeenCalled();
    expect(readRecoveryLedger(f.state().auto_probe_json)!.times).toHaveLength(0);
  });
  it('keeps ready recovery metadata until a real ACK and preserves rolling budget afterwards', async () => {
    const f = fixture(); await f.tick(); f.advance(); await f.tick(); await f.tick(); f.tasks.resumeAfterVerification(context, 'local');
    expect(readRecoveryLedger(f.state().auto_probe_json)!.rounds).toHaveLength(1); f.tasks.progress(context, 'local', true);
    expect(readRecoveryLedger(f.state().auto_probe_json)!.rounds).toHaveLength(0); expect(readRecoveryLedger(f.state().auto_probe_json)!.times).toHaveLength(1);
  });
  it('rejects security errors and unknown diagnostic claims without interpreting free text', () => {
    expect(recoveryFailure({ code: 47002, httpStatus: 403, data: { reason: 'ACCESS_DENIED' } })).toBeNull();
    expect(recoveryFailure({ code: 47019, httpStatus: 400, data: { reason: 'INVALID_REMOTE_REQUEST', syncDiagnostic: { version: 9, requiredCapability: 'anything' } } }))
      .toEqual({ code: 47019, httpStatus: 400, reason: 'INVALID_REMOTE_REQUEST' });
  });
});
