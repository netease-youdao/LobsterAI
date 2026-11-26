import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteSyncRecoveryReason, RemoteSyncRecoveryState } from '../../shared/remote/recovery';
import { payloadHash } from './canonical';
import { AvailabilityRecoveryDeferred, type AvailabilityRecoveryIdentity, AvailabilityRecoveryLane, completeAvailabilityRecovery, readAvailabilityRecoveryDisplay, RemoteAvailabilityAutoRecovery } from './remoteAvailabilityAutoRecovery';
import { RemoteRecoveryLimiter } from './remoteSyncRecoveryLedger';

const databases: Database.Database[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.useRealTimers(); vi.restoreAllMocks(); });
const invalidRequest = () => Object.assign(new Error('Invalid request'), { httpStatus: 400, code: 47019, data: { reason: 'INVALID_REMOTE_REQUEST' } });
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const db = new Database(':memory:'); databases.push(db);
  const recovery = new RemoteAvailabilityAutoRecovery(action => action(db));
  const identity: AvailabilityRecoveryIdentity = { scope: 'target:owner:device', localId: 'local', lane: AvailabilityRecoveryLane.Live,
    objectKey: 'publication', contextKey: payloadHash('context'), operationKey: payloadHash('original immutable request') };
  const limiter = new RemoteRecoveryLimiter();
  const query = vi.fn(async () => ({ state: 'accepted' }));
  const probe = (item = identity, evidence = 'capability') => recovery.probe(item, evidence, limiter, () => true, query, () => {});
  const advance = (delay = 30_000) => vi.setSystemTime(Date.now() + delay);
  return { db, recovery, identity, limiter, query, probe, advance };
}
describe('v3 persistent automatic recovery', () => {
  it('does not alter the positional fault schema and keeps display reads strictly read-only', () => {
    const f = fixture();
    f.db.exec('CREATE TABLE availability_faults(scope TEXT,local_id TEXT,object_key TEXT,fingerprint TEXT,attempts INTEGER,window_start INTEGER,next_retry INTEGER)');
    expect(readAvailabilityRecoveryDisplay(f.db, f.identity.scope, f.identity.localId)).toBeUndefined();
    expect(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='availability_auto_recovery'").get()).toBeUndefined();
    f.recovery.record(f.identity, invalidRequest());
    f.db.prepare('INSERT INTO availability_faults VALUES(?,?,?,?,?,?,?)').run('scope', 'local', 'key', 'hash', 1, 1, 1);
    const changes = f.db.prepare('SELECT total_changes() AS count').get();
    expect(readAvailabilityRecoveryDisplay(f.db, f.identity.scope, f.identity.localId)?.state).toBe(RemoteSyncRecoveryState.Waiting);
    expect(f.db.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
  });
  it('gives an opaque failure one default query, never interprets GET success as proof', async () => {
    const f = fixture(); f.recovery.record(f.identity, invalidRequest()); f.advance();
    await expect(f.recovery.probe(f.identity, 'capability', f.limiter, () => true, f.query,
      () => { throw new Error('REMOTE_AUTO_RECOVERY_EVIDENCE_INVALID'); })).rejects.toThrow('EVIDENCE_INVALID');
    f.advance(86400000);
    await expect(f.probe()).rejects.toBeInstanceOf(AvailabilityRecoveryDeferred);
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(readAvailabilityRecoveryDisplay(f.db, f.identity.scope, f.identity.localId)?.state).toBe(RemoteSyncRecoveryState.Blocked);
  });
  it('consumes confirmed evidence once and releases it only after the original ACK, retaining rate timestamps', async () => {
    const f = fixture(); f.recovery.record(f.identity, invalidRequest()); f.advance();
    await expect(f.probe()).resolves.toEqual({ state: 'accepted' });
    expect(readAvailabilityRecoveryDisplay(f.db, f.identity.scope, f.identity.localId)?.state).toBe(RemoteSyncRecoveryState.Recovering);
    f.recovery.record(f.identity, invalidRequest());
    await expect(f.probe()).rejects.toBeInstanceOf(AvailabilityRecoveryDeferred);
    completeAvailabilityRecovery(f.db, f.identity.scope, f.identity.localId, f.identity.lane, f.identity.objectKey);
    expect(f.recovery.has(f.identity)).toBe(false);
    const row = f.db.prepare("SELECT body FROM availability_auto_recovery WHERE object_key='@lane-budget'").get() as { body: string };
    expect(JSON.parse(row.body)).toMatchObject({ rounds: [], times: [130_000] });
  });
  it('retains consumed evidence and rate timestamps when the original operation terminates without a commit', async () => {
    const f = fixture(); f.recovery.record(f.identity, invalidRequest()); f.advance(); await f.probe();
    completeAvailabilityRecovery(f.db, f.identity.scope, f.identity.localId, f.identity.lane, f.identity.objectKey, false);
    const row = f.db.prepare("SELECT body FROM availability_auto_recovery WHERE object_key='@lane-budget'").get() as { body: string };
    expect(JSON.parse(row.body).rounds).toHaveLength(1);
    expect(JSON.parse(row.body).times).toEqual([130_000]);
    expect(readAvailabilityRecoveryDisplay(f.db, f.identity.scope, f.identity.localId)).toBeUndefined();
    f.recovery.record(f.identity, invalidRequest()); f.advance(86400000);
    await expect(f.probe()).rejects.toBeInstanceOf(AvailabilityRecoveryDeferred);
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it('shares two rounds across objects of one task/lane and preserves consumed capability history', async () => {
    const f = fixture();
    const objects = ['one', 'two', 'three'].map(objectKey => ({ ...f.identity, objectKey, operationKey: payloadHash(objectKey) }));
    objects.forEach(item => f.recovery.record(item, invalidRequest())); f.advance();
    await f.probe(objects[0]); f.recovery.record(objects[0], invalidRequest());
    await f.probe(objects[1]); f.recovery.record(objects[1], invalidRequest());
    await expect(f.probe(objects[2])).rejects.toBeInstanceOf(AvailabilityRecoveryDeferred);
    expect(f.query).toHaveBeenCalledTimes(2);
    f.advance(86400000);
    await expect(f.probe(objects[0])).rejects.toBeInstanceOf(AvailabilityRecoveryDeferred);
    await f.probe(objects[0], 'actually changed capability'); f.recovery.record(objects[0], invalidRequest());
    await expect(f.probe(objects[0], 'capability')).rejects.toBeInstanceOf(AvailabilityRecoveryDeferred);
    expect(f.query).toHaveBeenCalledTimes(3);
  });
  it('counts unknown requests across restarts without allocating another round', async () => {
    const f = fixture(); f.recovery.record(f.identity, invalidRequest()); f.advance();
    for (let index = 0; index < 3; index++) {
      const restarted = new RemoteAvailabilityAutoRecovery(action => action(f.db));
      let current = true;
      await expect(restarted.probe(f.identity, 'capability', f.limiter, () => current, async () => {
        current = false; throw new Error('process stopped before outcome persisted');
      }, () => {})).rejects.toThrow('process stopped');
      f.advance(31_000);
    }
    await expect(f.probe()).rejects.toBeInstanceOf(AvailabilityRecoveryDeferred);
    expect(f.query).not.toHaveBeenCalled();
    const row = f.db.prepare("SELECT body FROM availability_auto_recovery WHERE object_key='@lane-budget'").get() as { body: string };
    expect(JSON.parse(row.body).times).toHaveLength(1);
    expect(JSON.parse(row.body).rounds[0].failures).toBe(3);
  });
  it('rejects an altered original operation or context before any query', async () => {
    const f = fixture(); f.recovery.record(f.identity, invalidRequest()); f.advance();
    await expect(f.probe({ ...f.identity, operationKey: payloadHash('changed content') })).rejects.toThrow('RECORD_INVALID');
    await expect(f.probe({ ...f.identity, contextKey: payloadHash('another writer') })).rejects.toThrow('RECORD_INVALID');
    expect(f.query).not.toHaveBeenCalled();
  });
  it.each(['broken', 'x'.repeat(9000)])('fails closed on a damaged or oversized budget without resetting it', async body => {
    const f = fixture(); f.recovery.record(f.identity, invalidRequest()); f.advance(); await f.probe();
    f.db.prepare("UPDATE availability_auto_recovery SET body=? WHERE object_key='@lane-budget'").run(body);
    await expect(f.probe(f.identity, 'changed capability')).rejects.toThrow('RECORD_INVALID');
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it('resumes a verified but unacknowledged original operation after restart using the same round', async () => {
    const f = fixture(); f.recovery.record(f.identity, invalidRequest()); f.advance();
    await f.probe();
    const restarted = new RemoteAvailabilityAutoRecovery(action => action(f.db));
    await expect(restarted.probe(f.identity, 'capability', f.limiter, () => true, f.query, () => {})).resolves.toEqual({ state: 'accepted' });
    const row = f.db.prepare("SELECT body FROM availability_auto_recovery WHERE object_key='@lane-budget'").get() as { body: string };
    expect(JSON.parse(row.body).times).toEqual([130_000]);
    expect(JSON.parse(row.body).rounds).toHaveLength(1);
    expect(f.query).toHaveBeenCalledTimes(2);
    restarted.record(f.identity, invalidRequest());
    await expect(f.probe()).rejects.toBeInstanceOf(AvailabilityRecoveryDeferred);
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it('does not replace a missing lane budget after a request was already reserved', async () => {
    const f = fixture(); f.recovery.record(f.identity, invalidRequest()); f.advance(); await f.probe();
    f.db.prepare("DELETE FROM availability_auto_recovery WHERE object_key='@lane-budget'").run();
    expect(readAvailabilityRecoveryDisplay(f.db, f.identity.scope, f.identity.localId)?.state).toBe(RemoteSyncRecoveryState.Blocked);
    await expect(f.probe()).rejects.toThrow('RECORD_INVALID');
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.db.prepare("SELECT 1 FROM availability_auto_recovery WHERE object_key='@lane-budget'").get()).toBeUndefined();
  });
  it('allows one new bounded round only after an exhausted network failure receives newer dependency evidence', async () => {
    const f = fixture(); f.recovery.record(f.identity, invalidRequest()); f.advance();
    let epoch = 0;
    const query = vi.fn(async () => { throw new Error('network unavailable'); });
    const probe = () => f.recovery.probe(f.identity, 'capability', f.limiter, () => true, query, () => {}, () => epoch);
    for (let index = 0; index < 3; index++) { await expect(probe()).rejects.toThrow('network unavailable'); f.advance(120_000); }
    await expect(probe()).rejects.toBeInstanceOf(AvailabilityRecoveryDeferred);
    expect(query).toHaveBeenCalledTimes(3);
    epoch = 1;
    await expect(probe()).rejects.toThrow('network unavailable');
    const row = f.db.prepare("SELECT body FROM availability_auto_recovery WHERE object_key='@lane-budget'").get() as { body: string };
    expect(JSON.parse(row.body).rounds.map((round: { dependencyEpoch: number }) => round.dependencyEpoch)).toEqual([0, 1]);
    expect(JSON.parse(row.body).times).toHaveLength(2);
    for (let index = 0; index < 2; index++) { f.advance(120_000); await expect(probe()).rejects.toThrow('network unavailable'); }
    epoch = 2; f.advance(120_000);
    await expect(probe()).rejects.toBeInstanceOf(AvailabilityRecoveryDeferred);
    expect(query).toHaveBeenCalledTimes(6);
  });
  it('does not turn a conclusive invalid receipt into new evidence when connectivity recovers', async () => {
    const f = fixture(); f.recovery.record(f.identity, invalidRequest()); f.advance();
    let epoch = 0;
    const probe = () => f.recovery.probe(f.identity, 'capability', f.limiter, () => true, f.query,
      () => { throw new Error('REMOTE_HISTORY_RECEIPT_INVALID'); }, () => epoch);
    await expect(probe()).rejects.toThrow('RECEIPT_INVALID'); epoch = 1; f.advance(120_000);
    await expect(probe()).rejects.toBeInstanceOf(AvailabilityRecoveryDeferred);
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it('does not query or confirm a result when dependency proof is damaged', async () => {
    const f = fixture(); f.recovery.record(f.identity, invalidRequest()); f.advance();
    let epoch: number | null = null;
    const probe = () => f.recovery.probe(f.identity, 'capability', f.limiter, () => true, f.query, () => {}, () => epoch);
    await expect(probe()).rejects.toBeInstanceOf(AvailabilityRecoveryDeferred);
    expect(f.query).not.toHaveBeenCalled(); epoch = 0;
    f.query.mockImplementationOnce(async () => { epoch = null; return { state: 'accepted' }; });
    await expect(probe()).rejects.toBeInstanceOf(AvailabilityRecoveryDeferred);
    const row = f.db.prepare("SELECT body FROM availability_auto_recovery WHERE object_key='@lane-budget'").get() as { body: string };
    expect(JSON.parse(row.body).rounds[0]).toMatchObject({ outcome: 'pending', failures: 1 });
  });
  it.each([
    { code: 47017, reason: 'CAPABILITY_UNSUPPORTED' },
    { code: 47019, reason: 'INVALID_REMOTE_REQUEST', syncDiagnostic: { version: 1, cause: 'capability_unavailable' } },
    { code: 47019, reason: 'INVALID_REMOTE_REQUEST', syncDiagnostic: { version: 1, cause: 'protocol_requirement' } },
  ])('shows protocol requirements consistently when the server uses HTTP 409: %j', value => {
    const f = fixture(); f.recovery.record(f.identity, { code: value.code, httpStatus: 409, data: value });
    expect(readAvailabilityRecoveryDisplay(f.db, f.identity.scope, f.identity.localId)?.reason).toBe(RemoteSyncRecoveryReason.Protocol);
  });
  it('shares the device permit across recovery lanes without allocating a second in-flight query', async () => {
    const f = fixture(), history = { ...f.identity, lane: AvailabilityRecoveryLane.History, objectKey: 'history' };
    f.recovery.record(f.identity, invalidRequest()); f.recovery.record(history, invalidRequest()); f.advance();
    let finish!: () => void;
    const first = f.recovery.probe(f.identity, 'capability', f.limiter, () => true,
      () => new Promise<void>(resolve => { finish = resolve; }), () => {});
    await expect(f.probe(history)).rejects.toBeInstanceOf(AvailabilityRecoveryDeferred);
    finish(); await first;
    await f.probe(history);
    expect(f.query).toHaveBeenCalledTimes(1);
  });
});
