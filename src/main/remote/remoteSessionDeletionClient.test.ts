import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type DeletionClaim, type DeletionReceipt,RemoteDeletion } from '../../shared/remote/deletions';
import { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteSyncTarget } from '../../shared/remote/syncTarget';
import type { CoworkStore } from '../coworkStore';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { payloadHash } from './canonical';
import { migrateRemoteEnvironment } from './remoteEnvironmentMigration';
import { recordRemoteSessionDeletion, RemoteLocalGc } from './remoteLocalGc';
import { RemoteSessionDeletionClient } from './remoteSessionDeletionClient';
import { RemoteStore } from './remoteStore';
import { RemoteSyncTargetStore } from './remoteSyncTargetStore';
import { SessionDeletionService } from './sessionDeletionService';

const databases: Database.Database[] = [];
const owner = { userId: '7', scopeKey: 'personal' };
const environment = 'https://test.example.com';
const customEnvironment = 'https://custom-gateway.example.com';
afterEach(() => { vi.useRealTimers(); for (const db of databases.splice(0)) db.close(); });
function fixture(localEnvironment = environment, serviceScope = localEnvironment) {
  const db = new Database(':memory:'); databases.push(db);
  db.exec('CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT); CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER)');
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false });
  store.transaction(() => { db.prepare("INSERT INTO cowork_sessions VALUES ('local','title',1,1,'idle')").run(); store.assignNew('local', owner, 'local_create'); });
  db.prepare('UPDATE remote_sync SET session_id=?,device_id=?,stream_epoch=?,sync_environment=?,source_seq=90,ack_seq=84,needs_snapshot=0 WHERE local_id=?')
    .run('session', 'device', 'epoch', localEnvironment, 'local');
  store.put('run:local', { runId: 'run', status: 'succeeded', statusVersion: '1' });
  const guard = store.deletionGuard('local');
  const claim: DeletionClaim = { operation: { operationId: 'op', sessionId: 'session', deviceId: 'device', deletionVersion: '1', stateVersion: '2', state: 'processing', action: RemoteDeletion.StopAndDelete, approvedGuard: guard },
    target: { ...owner, serviceScope, deviceId: 'device', sessionId: 'session', localSessionId: 'local', streamEpoch: 'epoch' },
    claim: { claimId: 'claim', claimToken: 'token', deletionVersion: '1', leaseUntil: new Date(Date.now() + 30000).toISOString() } };
  let active = false, enabled = true, claimed = false, loseReport = false;
  let operation: any = claim.operation;
  const runtime = { isSessionActive: () => active, stopSession: vi.fn(), cancelSessionConfirmed: vi.fn(async () => { active = false; return true; }) } as unknown as CoworkRuntime;
  const cleanup = vi.fn();
  const core = { remote: store, runSessionTransaction: <T>(fn: () => T) => store.transaction(fn), deleteSession: (id: string) => {
    recordRemoteSessionDeletion(store, id); db.prepare('DELETE FROM cowork_sessions WHERE id=?').run(id);
  } } as unknown as CoworkStore;
  const service = new SessionDeletionService(core, runtime, cleanup, () => owner);
  const completion = (receipt: DeletionReceipt) => ({ operationId: 'op', deletionVersion: '1', proofKind: 'remote_execution', owner, serviceScope,
    ...Object.fromEntries(['localReceiptId', 'receiptDigest', 'deviceId', 'sessionId', 'localSessionId', 'streamEpoch', 'guard', 'localDeletionRevision', 'closedSourceHighWatermark'].map(key => [key, (receipt as any)[key]])),
    committedDeletionSeq: '83', completedAt: new Date().toISOString() });
  const request = vi.fn(async (path: string, method?: string, body?: any): Promise<any> => {
    if (path.endsWith('/claim')) { if (claimed) return { items: [] }; claimed = true; return { items: [claim] }; }
    if (path.endsWith('/permit')) return { permitId: 'permit', permitToken: 'permit-token', permitUntil: new Date(Date.now() + 30000).toISOString(), serverTime: new Date().toISOString(), stateVersion: '3', executionAllowed: true, connectionGeneration: '1' };
    if (path.endsWith('/reports')) {
      if (body.result.kind === RemoteDeletion.Deleted) {
        const { receiptDigest, permitToken: _permitToken, ...fact } = body.result;
        expect(receiptDigest).toBe(payloadHash(fact));
        operation = { ...operation, state: RemoteDeletion.Completed, completionReceipt: completion(body.result) };
        if (loseReport) { loseReport = false; throw new Error('Response lost'); }
      } else operation = { ...operation, stateVersion: '4', state: body.result.kind === 'needs_confirmation' ? 'needs_confirmation' : RemoteDeletion.Reconciling };
      return operation;
    }
    if (method === undefined) return operation;
    throw new Error('Unexpected request');
  });
  const deps = { store, service, runtime, context: () => ({ owner, environment: localEnvironment, deviceId: 'device', generation: '1', enabled }), request, reconcileStop: vi.fn(async () => false) };
  const client = new RemoteSessionDeletionClient(deps);
  return { db, store, claim, service, runtime, cleanup, request, client, deps, exists: () => !!db.prepare("SELECT 1 FROM cowork_sessions WHERE id='local'").get(),
    active: () => { active = true; store.put('run:local', { runId: 'run', status: 'running', statusVersion: '1' }); }, disable: () => { enabled = false; }, requeue: () => { claimed = false; claim.claim.claimToken = 'rotated-token'; }, lose: () => { loseReport = true; } };
}

describe('bidirectional session deletion control lane', () => {
  it.each([true, false])('uses an authenticated data identity for a deletion created through a new domain (matching: %s)', async matching => {
    const targetId = 'verified-target';
    const f = fixture(targetId, 'https://new-alias.example.com');
    const identity = { version: RemoteSyncTarget.Version, dataSpaceId: 'original-space', dataGeneration: '1' };
    new RemoteSyncTargetStore(f.store);
    f.db.prepare('INSERT INTO remote_sync_targets VALUES (?,?,?,?,?)').run(targetId, owner.userId, owner.scopeKey, 'device', JSON.stringify(identity));
    f.claim.target.syncTarget = { ...identity, dataSpaceId: matching ? identity.dataSpaceId : 'other-space' };
    const originalScope = f.claim.target.serviceScope;
    await f.client.poll(true, true);
    expect(f.exists()).toBe(!matching);
    expect(f.claim.target.serviceScope).toBe(originalScope);
    if (matching) {
      expect(f.store.get<any>('localGcDeleted:local').ackAt).not.toBeNull();
      expect(f.store.entries<any>(RemoteDeletion.Inbox)[0].value.completionReceipt.serviceScope).toBe(originalScope);
    } else expect(f.request.mock.calls.some(([path]) => path.endsWith('/permit'))).toBe(false);
  });
  it.each([
    [RemoteEnvironment.Test, 'https://lobsterai-server-dev.inner.youdao.com'],
    [RemoteEnvironment.Test, 'https://lobsterai-server.inner.youdao.com'],
    [RemoteEnvironment.Test, 'https://lobsterai-server-test.youdao.com'],
    [RemoteEnvironment.Production, 'https://lobsterai-server.youdao.com'],
    ['https://lobsterai-server.inner.youdao.com', 'https://lobsterai-server-dev.inner.youdao.com'],
  ])('recovers historical deletion proof in %s without rewriting scope %s', async (localEnvironment, serviceScope) => {
    const f = fixture(localEnvironment, serviceScope);
    const target = structuredClone(f.claim.target);
    f.lose();
    await f.client.poll(true, true);
    expect(f.exists()).toBe(false);
    const saved = f.store.entries<any>(RemoteDeletion.Inbox)[0].value;
    const receipt = structuredClone(saved.receipt);
    expect(saved.target).toEqual(target);
    expect(saved.requestHash).toBe(payloadHash(target));
    expect(f.store.get<any>('localGcDeleted:local').ackAt).toBeNull();

    f.disable();
    await new RemoteSessionDeletionClient(f.deps).poll(true, false);
    const completed = f.store.entries<any>(RemoteDeletion.Inbox)[0].value;
    expect(completed.phase).toBe(RemoteDeletion.Completed);
    expect(completed.target).toEqual(target);
    expect(completed.receipt).toEqual(receipt);
    expect(completed.completionReceipt.serviceScope).toBe(serviceScope);
    expect(f.store.get<any>('localGcDeleted:local')).toMatchObject({ environment: localEnvironment, completionReceipt: completed.completionReceipt });
    f.db.prepare('INSERT INTO remote_projection VALUES (?,?,?,?,?)').run('local', 'message:m', 'h', 1, '{}');
    await new RemoteLocalGc({ store: f.store, cacheRoot: '/tmp/no-delete-fixture', owner: () => owner }).sweep(Date.now() + 86400001);
    expect(f.db.prepare('SELECT 1 FROM remote_projection').get()).toBeUndefined();
  });
  it.each([
    [RemoteEnvironment.Test, 'https://lobsterai-server.youdao.com'],
    [RemoteEnvironment.Production, 'https://lobsterai-server.inner.youdao.com'],
    [RemoteEnvironment.Test, 'https://test.example.com'],
    ['https://test.example.com', 'https://other.example.com'],
    ['https://test.example.com', 'https://test.example.com/'],
  ])('rejects deletion claims across distinct environments: %s and %s', async (localEnvironment, serviceScope) => {
    const f = fixture(localEnvironment, serviceScope);
    await f.client.poll(true, true);
    expect(f.exists()).toBe(true);
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.request.mock.calls.some(([path]) => path.endsWith('/permit'))).toBe(false);
  });
  it('recovers custom-domain deletion evidence using its persisted account and device alias', async () => {
    const f = fixture(RemoteEnvironment.Test, customEnvironment);
    migrateRemoteEnvironment(f.store, { owner, deviceId: 'device', environment: RemoteEnvironment.Test, legacyEnvironments: [customEnvironment] });
    const target = structuredClone(f.claim.target);
    f.lose();
    await f.client.poll(true, true);
    expect(f.exists()).toBe(false);
    const receipt = structuredClone(f.store.entries<any>(RemoteDeletion.Inbox)[0].value.receipt);
    f.disable();
    await new RemoteSessionDeletionClient(f.deps).poll(true, false);
    const saved = f.store.entries<any>(RemoteDeletion.Inbox)[0].value;
    expect(saved.phase).toBe(RemoteDeletion.Completed);
    expect(saved.target).toEqual(target);
    expect(saved.requestHash).toBe(payloadHash(target));
    expect(saved.receipt).toEqual(receipt);
    expect(saved.completionReceipt.serviceScope).toBe(customEnvironment);
    expect(f.store.get<any>('localGcDeleted:local').ackAt).toEqual(expect.any(Number));
  });
  it.each([
    [{ ...owner, userId: 'other' }, 'device'],
    [owner, 'other-device'],
  ])('does not borrow a custom-domain alias from another identity: %j %s', async (aliasOwner, deviceId) => {
    const f = fixture(RemoteEnvironment.Test, customEnvironment);
    migrateRemoteEnvironment(f.store, { owner: aliasOwner, deviceId, environment: RemoteEnvironment.Test, legacyEnvironments: [customEnvironment] });
    await f.client.poll(true, true);
    expect(f.exists()).toBe(true);
    expect(f.request.mock.calls.some(([path]) => path.endsWith('/permit'))).toBe(false);
  });
  it.each(['https://lobsterai-server-dev.inner.youdao.com', customEnvironment])('requires completion proof scope to exactly match its immutable target %s', async serviceScope => {
    const f = fixture(RemoteEnvironment.Test, serviceScope);
    migrateRemoteEnvironment(f.store, { owner, deviceId: 'device', environment: RemoteEnvironment.Test, legacyEnvironments: [serviceScope] });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path, method, body) => {
      const response = await original(path, method, body);
      return response.completionReceipt
        ? { ...response, completionReceipt: { ...response.completionReceipt, serviceScope: RemoteEnvironment.Test } }
        : response;
    });
    await f.client.poll(true, true);
    expect(f.exists()).toBe(false);
    expect(f.store.entries<any>(RemoteDeletion.Inbox)[0].value.target.serviceScope).toBe(serviceScope);
    expect(f.store.entries<any>(RemoteDeletion.Inbox)[0].value.phase).not.toBe(RemoteDeletion.Completed);
    expect(f.store.get<any>('localGcDeleted:local').ackAt).toBeNull();
  });
  it('deletes only after permit, retains true source ACK, and requires completion for GC', async () => {
    const f = fixture();
    await f.client.poll(true, true);
    expect(f.exists()).toBe(false); expect(f.cleanup).toHaveBeenCalledOnce();
    expect(f.store.sync('local')).toMatchObject({ source_seq: 90, ack_seq: 84 });
    expect(f.store.entries<any>(RemoteDeletion.Inbox)[0].value.phase).toBe(RemoteDeletion.Completed);
    f.store.project('local'); expect(f.store.pending('local')).toEqual([]);
    f.db.prepare('INSERT INTO remote_projection VALUES (?,?,?,?,?)').run('local', 'message:m', 'h', 1, '{}');
    const gc = new RemoteLocalGc({ store: f.store, cacheRoot: '/tmp/no-delete-fixture', owner: () => owner });
    await gc.sweep(Date.now() + 86400001);
    expect(f.db.prepare('SELECT 1 FROM remote_projection').get()).toBeUndefined();
    expect(f.store.sync('local')?.ack_seq).toBe(84);
  });
  it('new local generation requires confirmation and never obtains a permit', async () => {
    const f = fixture(); f.store.advanceDeletionGuard('local', 'new-run');
    await f.client.poll(true, true);
    expect(f.exists()).toBe(true); expect(f.runtime.cancelSessionConfirmed).not.toHaveBeenCalled();
    expect(f.request.mock.calls.some(([path]) => path.endsWith('/permit'))).toBe(false);
    expect(f.request.mock.calls.find(([path]) => path.endsWith('/reports'))?.[2].result).toMatchObject({ kind: 'needs_confirmation', observedGuard: { runId: 'new-run' } });
  });
  it('observation-only claim cannot execute even when the guard matches', async () => {
    const f = fixture(); f.claim.claim.observationOnly = true;
    await f.client.poll(true, true);
    expect(f.exists()).toBe(true); expect(f.request.mock.calls.some(([path]) => path.endsWith('/permit'))).toBe(false);
  });
  it('unknown stop keeps task and persistent fence; never mistakes request receipt for termination', async () => {
    const f = fixture(); f.active(); vi.mocked(f.runtime.cancelSessionConfirmed!).mockResolvedValue(false);
    await f.client.poll(true, true);
    expect(f.exists()).toBe(true); expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.store.get<any>(`${RemoteDeletion.Fence}local`).phase).toBe(RemoteDeletion.Reconciling);
    expect(() => f.store.beginRun('local', 'later')).toThrow();
  });
  it('confirmed stop precedes commit and remote errors do not block local deletion', async () => {
    const f = fixture(); f.active();
    await f.service.deleteLocal('local');
    expect(f.runtime.cancelSessionConfirmed).toHaveBeenCalledOnce(); expect(f.exists()).toBe(false); expect(f.request).not.toHaveBeenCalled();
  });
  it('batch deletion commits no records when any task has an unconfirmed stop', async () => {
    const f = fixture();
    f.store.transaction(() => { f.db.prepare("INSERT INTO cowork_sessions VALUES ('second','title',1,1,'idle')").run(); f.store.assignNew('second', owner, 'local_create'); });
    f.active(); vi.mocked(f.runtime.cancelSessionConfirmed!).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(f.service.deleteLocalBatch(['local', 'second'])).rejects.toThrow();
    expect(f.exists()).toBe(true); expect(f.db.prepare("SELECT 1 FROM cowork_sessions WHERE id='second'").get()).toBeDefined();
    expect(f.cleanup).not.toHaveBeenCalled();
  });
  it('local stop failure preserves task for recovery', async () => {
    const f = fixture(); f.active(); vi.mocked(f.runtime.cancelSessionConfirmed!).mockResolvedValue(false);
    await expect(f.service.deleteLocal('local')).rejects.toThrow(); expect(f.exists()).toBe(true);
  });
  it('lost completion response recovers original receipt with remote disabled and never stops twice', async () => {
    const f = fixture(); f.active(); f.lose();
    await f.client.poll(true, true); f.disable();
    expect(f.exists()).toBe(false); expect(f.store.entries<any>(RemoteDeletion.Inbox)[0].value.receipt).toBeDefined();
    await new RemoteSessionDeletionClient(f.deps).poll(true, false);
    expect(f.runtime.cancelSessionConfirmed).toHaveBeenCalledOnce();
    expect(f.store.entries<any>(RemoteDeletion.Inbox)[0].value.phase).toBe(RemoteDeletion.Completed);
  });
  it('transport failure or ordinary 410 never authorizes local deletion', async () => {
    const f = fixture(); f.request.mockRejectedValue({ code: 47010, httpStatus: 410 });
    await f.client.poll(true, true); expect(f.exists()).toBe(true); expect(f.cleanup).not.toHaveBeenCalled();
  });
  it('expired or recovered non-executable permit is settled without a stop', async () => {
    const f = fixture(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path, method, body) => {
      const result = await original(path, method, body);
      return path.endsWith('/permit') ? { ...result, executionAllowed: false } : result;
    });
    await f.client.poll(true, true);
    expect(f.exists()).toBe(true); expect(f.runtime.cancelSessionConfirmed).not.toHaveBeenCalled();
    const report = f.request.mock.calls.find(([path]) => path.endsWith('/reports'))?.[2];
    expect(report.result.kind).toBe('not_started'); expect(BigInt(report.result.evidence.journalRevision)).toBeGreaterThan(0n);
  });
  it('lost permit response replays the original body and settles never-started evidence after reconnect', async () => {
    const f = fixture(); const original = f.request.getMockImplementation()!; let failed = false; let permitBody: any;
    f.request.mockImplementation(async (path, method, body) => {
      if (path.endsWith('/permit')) {
        if (!failed) { failed = true; permitBody = body; throw new Error('Response lost'); }
        expect(body).toEqual(permitBody);
      }
      return original(path, method, body);
    });
    await f.client.poll(true, true); f.disable();
    await new RemoteSessionDeletionClient(f.deps).poll(true, false);
    expect(f.exists()).toBe(true); expect(f.runtime.cancelSessionConfirmed).not.toHaveBeenCalled();
    expect(f.request.mock.calls.find(([path]) => path.endsWith('/reports'))?.[2].result.kind).toBe('not_started');
  });
  it('post-commit cleanup survives failure and is retried from persistent state', async () => {
    vi.useFakeTimers(); const f = fixture(); f.cleanup.mockImplementationOnce(() => { throw new Error('Runtime busy'); });
    await f.service.deleteLocal('local');
    expect(f.exists()).toBe(false); expect(f.store.get('deletionCleanup:local')).toEqual({ sessionId: 'local' });
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.store.get('deletionCleanup:local')).toBeNull(); expect(f.cleanup).toHaveBeenCalledTimes(2);
  });
  it('different owner or environment cannot execute a deletion claim', async () => {
    const f = fixture(); f.claim.target.userId = 'other';
    await f.client.poll(true, true); expect(f.exists()).toBe(true); expect(f.cleanup).not.toHaveBeenCalled();
  });
  it('server clock offset is honored without extending the monotonic permit deadline', async () => {
    const f = fixture(); const original = f.request.getMockImplementation()!; const serverNow = Date.now() - 3600000;
    f.request.mockImplementation(async (path, method, body) => {
      const result = await original(path, method, body);
      return path.endsWith('/permit') ? { ...result, serverTime: new Date(serverNow).toISOString(), permitUntil: new Date(serverNow + 30000).toISOString() } : result;
    });
    await f.client.poll(true, true); expect(f.exists()).toBe(false);
    const receipt = f.store.entries<any>(RemoteDeletion.Inbox)[0].value.receipt;
    expect(Date.parse(receipt.deletedAt)).toBeGreaterThanOrEqual(serverNow);
    expect(Date.parse(receipt.deletedAt)).toBeLessThan(serverNow + 30000);
    expect(f.db.prepare('SELECT 1 FROM remote_dirty').get()).toBeUndefined();
  });
  it('explicit never-issued proof safely settles a lost request and fences its late original', async () => {
    const f = fixture(); const original = f.request.getMockImplementation()!; let failed = false;
    f.request.mockImplementation(async (path, method, body) => {
      if (path.endsWith('/permit')) {
        if (!failed) { failed = true; throw new Error('No request reached the server'); }
        return { executionAllowed: false, recoveryProof: { permitIssued: false, claimId: body.claimId, localFenceId: body.localFenceId, deletionVersion: body.deletionVersion } };
      }
      return original(path, method, body);
    });
    await f.client.poll(true, true); f.disable();
    await new RemoteSessionDeletionClient(f.deps).poll(true, false);
    expect(f.exists()).toBe(true); expect(f.store.get(`${RemoteDeletion.Fence}local`)).toBeNull();
    expect(f.runtime.cancelSessionConfirmed).not.toHaveBeenCalled();
    expect(f.store.entries<any>(RemoteDeletion.Inbox)[0].value.permitRequestPending).toBe(false);
  });
  it('only negotiated projection includes the persistent deletion guard', () => {
    const f = fixture(); f.store.project('local');
    const projected = () => JSON.parse((f.db.prepare("SELECT record_json FROM remote_projection WHERE object_key='session'").get() as any).record_json).payload.session;
    expect(projected().deletionGuard).toBeUndefined();
    f.store.setDeletionProjectionSupported(true); f.store.project('local');
    expect(projected().deletionGuard).toEqual({ version: '1', runId: 'run' });
  });
  it('rotated no-permit claim resumes a safely settled local blocker using the new token', async () => {
    const f = fixture(); f.store.put('inputFence:local', { operationId: 'old-input' });
    await f.client.poll(true, true); expect(f.exists()).toBe(true);
    expect(f.request.mock.calls.some(([path]) => path.endsWith('/permit'))).toBe(false);
    f.store.remove('inputFence:local'); f.requeue();
    await new RemoteSessionDeletionClient(f.deps).poll(true, true);
    expect(f.exists()).toBe(false);
    expect(f.request.mock.calls.find(([path]) => path.endsWith('/permit'))?.[2].claimToken).toBe('rotated-token');
  });
  it('guard retains last accepted run across natural completion', () => {
    const f = fixture(); f.store.beginRun('local', 'next'); const current = f.store.deletionGuard('local');
    f.store.updateRun('local', 'succeeded'); expect(f.store.deletionGuard('local')).toEqual(current); expect(current.runId).toBe('next');
  });
});
