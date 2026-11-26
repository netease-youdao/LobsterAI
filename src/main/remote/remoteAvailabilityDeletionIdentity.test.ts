import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteCapability } from '../../shared/remote/constants';
import { type DeletionClaim, type DeletionReceipt, RemoteDeletion } from '../../shared/remote/deletions';
import { RemoteEnvironment } from '../../shared/remote/environment';
import type { CoworkStore } from '../coworkStore';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { payloadHash } from './canonical';
import { availabilityDeletion, mirrorAvailabilityDeletionIdentity } from './remoteAvailabilityDeletion';
import { type AvailabilityContext, RemoteAvailabilityPublisher } from './remoteAvailabilityPublisher';
import { RemoteBridge } from './remoteBridge';
import { recordRemoteSessionDeletion } from './remoteLocalGc';
import { RemoteSessionDeletionClient } from './remoteSessionDeletionClient';
import { RemoteStore } from './remoteStore';
import { SessionDeletionService } from './sessionDeletionService';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(dispose => dispose()); vi.restoreAllMocks(); });
function fixture() {
  const db = new Database(':memory:'); cleanup.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false }); store.setWake(() => {});
  const owner = { userId: '1', scopeKey: 'personal' };
  const context: AvailabilityContext = { environment: RemoteEnvironment.Test, targetId: RemoteEnvironment.Test,
    scope: `${RemoteEnvironment.Test}:1:personal:desktop`, owner, deviceId: 'desktop', generation: '1', routeEpoch: 1,
    supported: true, controlDeletionSupported: true };
  let current = context;
  store.setProjectionIdentity(RemoteEnvironment.Test, owner, 'desktop');
  store.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES('local','Task',1,1,'idle',NULL,NULL)").run();
    store.assignNew('local', owner, 'local_create');
  });
  const sessionId = store.sync('local')!.session_id;
  store.bindRemote('local', sessionId, 'desktop');
  const bootstraps = new Map<string, any>();
  const request = vi.fn(async (path: string, _method: string, body: any): Promise<any> => {
    if (path === '/sync/mode-activations') return { sessionId, writerGeneration: body.writerGeneration,
      state: 'fenced', streamEpoch: 'server-stream', pendingCommandIds: [], pendingCommands: [] };
    if (path === '/control/bootstrap') {
      bootstraps.set(body.operationId, body);
      return { state: 'uploading', operationId: body.operationId, sessionId, writerGeneration: body.writerGeneration };
    }
    if (/\/parts\/\d+$/u.test(path)) return { state: 'accepted' };
    if (path.endsWith('/commit')) {
      const operationId = path.split('/')[3], begin = bootstraps.get(operationId);
      return { state: 'committed', controlReady: true, operationId, sessionId, writerGeneration: body.writerGeneration,
        controlEpoch: body.controlEpoch, manifestHash: begin.manifestHash, coreCheckpointId: begin.coreCheckpointId, throughFactSeq: begin.throughFactSeq };
    }
    if (path === '/control/facts/batches') return { state: 'committed', lastFactSeq: body.lastFactSeq };
    if (path.startsWith('/sync/state?')) {
      const query = new URLSearchParams(path.split('?')[1]);
      return { sessionId, writerGeneration: query.get('writerGeneration'), state: 'active', controlReady: true,
        controlEpoch: publisher.ledger.session(context.scope, 'local')!.controlEpoch, streamEpoch: 'server-stream' };
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const publisher = new RemoteAvailabilityPublisher({ store, context: () => current, admitted: () => true, request });
  store.setIndependentControlReady(id => publisher.controlReady(id));
  cleanup.push(() => store.history.close()); cleanup.push(() => publisher.dispose());
  const controls = (): Promise<void> => (publisher as any).controls(current);
  const state = () => publisher.ledger.session(context.scope, 'local')!;
  return { db, store, owner, context, sessionId, publisher, request, controls, state,
    setContext: (next: AvailabilityContext) => { current = next; } };
}

function legacyState(f: ReturnType<typeof fixture>) {
  const row = f.store.sync('local')!;
  return { protocol: row.sync_protocol_version, source: row.source_seq, ack: row.ack_seq,
    server: row.server_seq, sourcePurge: row.source_purge_seq, eventPurge: row.event_purge_seq, snapshot: row.needs_snapshot };
}

describe('availability deletion identity', () => {
  it('activates a new control writer and completes the existing deletion permit and receipt path', async () => {
    const f = fixture(), original = legacyState(f);
    expect(f.store.sync('local')!.stream_epoch).toBeNull();
    await f.controls();
    expect(f.publisher.controlReady('local')).toBe(true);
    expect(f.store.sync('local')!.stream_epoch).toBe('server-stream');
    expect(legacyState(f)).toEqual(original);
    expect(f.publisher.legacyHistoryAllowed('local')).toBe(false);
    const guard = f.store.deletionGuard('local');
    const claim: DeletionClaim = { operation: { operationId: 'delete-op', sessionId: f.sessionId, deviceId: 'desktop',
      deletionVersion: '1', stateVersion: '1', state: 'processing', action: RemoteDeletion.Delete, approvedGuard: guard },
    target: { ...f.owner, serviceScope: RemoteEnvironment.Test, deviceId: 'desktop', sessionId: f.sessionId,
      localSessionId: 'local', streamEpoch: 'server-stream' },
    claim: { claimId: 'claim', claimToken: 'claim-token', deletionVersion: '1', leaseUntil: new Date(Date.now() + 30000).toISOString() } };
    const runtime = { isSessionActive: () => false } as unknown as CoworkRuntime;
    const core = { remote: f.store, runSessionTransaction: <T>(operation: () => T) => f.store.transaction(operation), deleteSession: (id: string) => {
      recordRemoteSessionDeletion(f.store, id); f.db.prepare('DELETE FROM cowork_sessions WHERE id=?').run(id);
    } } as unknown as CoworkStore;
    const service = new SessionDeletionService(core, runtime, vi.fn(), () => f.owner);
    let receipt: DeletionReceipt | undefined;
    const request = vi.fn(async (path: string, _method?: string, body?: any): Promise<any> => {
      if (path.endsWith('/claim')) return { items: [claim] };
      if (path.endsWith('/permit')) return { permitId: 'permit', permitToken: 'permit-token', stateVersion: '2',
        permitUntil: new Date(Date.now() + 30000).toISOString(), serverTime: new Date().toISOString(), executionAllowed: true, connectionGeneration: '1' };
      if (path.endsWith('/reports')) {
        receipt = body.result;
        expect(receipt!.kind).toBe(RemoteDeletion.Deleted);
        const { receiptDigest, permitToken: _permitToken, ...fact } = receipt!;
        expect(receiptDigest).toBe(payloadHash(fact));
        return { ...claim.operation, state: RemoteDeletion.Completed, completionReceipt: {
          operationId: 'delete-op', deletionVersion: '1', proofKind: 'remote_execution', owner: f.owner, serviceScope: RemoteEnvironment.Test,
          ...Object.fromEntries(['localReceiptId', 'receiptDigest', 'deviceId', 'sessionId', 'localSessionId', 'streamEpoch', 'guard', 'localDeletionRevision', 'closedSourceHighWatermark']
            .map(key => [key, (receipt as any)[key]])), committedDeletionSeq: '1', completedAt: new Date().toISOString(),
        } };
      }
      throw new Error(`Unexpected deletion request: ${path}`);
    });
    const client = new RemoteSessionDeletionClient({ store: f.store, service, runtime,
      context: () => ({ owner: f.owner, environment: RemoteEnvironment.Test, deviceId: 'desktop', generation: '1', enabled: true, routeEpoch: 1 }),
      request, reconcileStop: async () => false });
    await client.poll(true, true);
    expect(receipt?.streamEpoch).toBe('server-stream');
    expect(f.db.prepare("SELECT 1 FROM cowork_sessions WHERE id='local'").get()).toBeUndefined();
    expect(legacyState(f)).toEqual(original);
  });

  it('retries a failed core mirror from the saved activation without repeating activation', async () => {
    const f = fixture(), original = legacyState(f);
    f.db.exec("CREATE TRIGGER fail_identity BEFORE UPDATE OF stream_epoch ON remote_sync BEGIN SELECT RAISE(FAIL,'mirror unavailable'); END");
    await f.controls();
    expect(f.state().phase).toBe('bootstrap');
    expect(f.state().streamEpoch).toBe('server-stream');
    expect(f.store.sync('local')!.stream_epoch).toBeNull();
    f.db.exec('DROP TRIGGER fail_identity');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    await f.controls();
    expect(f.publisher.controlReady('local')).toBe(true);
    expect(f.store.sync('local')!.stream_epoch).toBe('server-stream');
    expect(f.request.mock.calls.filter(call => call[0] === '/sync/mode-activations')).toHaveLength(1);
    expect(legacyState(f)).toEqual(original);
  });

  it('rolls back the epoch when its control binding cannot be persisted and retries the same activation', async () => {
    const f = fixture();
    f.db.exec("CREATE TRIGGER fail_binding BEFORE INSERT ON remote_state WHEN NEW.key='availabilityDeletionBinding:local' BEGIN SELECT RAISE(FAIL,'binding unavailable'); END");
    await f.controls();
    expect(f.store.sync('local')!.stream_epoch).toBeNull();
    expect(f.store.get('availabilityDeletionBinding:local')).toBeNull();
    expect(f.state().streamEpoch).toBe('server-stream');
    f.db.exec('DROP TRIGGER fail_binding');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    await f.controls();
    expect(f.store.sync('local')!.stream_epoch).toBe('server-stream');
    expect(f.store.get('availabilityDeletionBinding:local')).toMatchObject({ sessionId: f.sessionId,
      writerGeneration: f.state().writerGeneration, controlEpoch: f.state().controlEpoch });
    expect(f.request.mock.calls.filter(call => call[0] === '/sync/mode-activations')).toHaveLength(1);
    f.store.transaction(() => {
      recordRemoteSessionDeletion(f.store, 'local'); f.db.prepare("DELETE FROM cowork_sessions WHERE id='local'").run();
    });
    expect(() => availabilityDeletion(f.store, f.context, f.state())).not.toThrow();
  });

  it('repairs an existing active writer from a matching authenticated state without a history backlog', async () => {
    const f = fixture(); await f.controls();
    const state = f.state(); delete state.streamEpoch; f.publisher.ledger.saveSession(state);
    f.db.prepare('UPDATE remote_sync SET stream_epoch=NULL,source_seq=ack_seq WHERE local_id=?').run('local');
    const historyContext = { scope: f.context.scope, localId: 'local', sessionId: f.sessionId,
      writerGeneration: f.state().writerGeneration, owner: f.owner, deviceId: 'desktop' };
    f.store.history.prepareResult(historyContext);
    const archive = f.db.prepare('SELECT manifest_json,manifest_hash FROM remote_history_migrations').all();
    expect(archive).toHaveLength(1);
    const original = legacyState(f);
    await f.controls();
    expect(f.request.mock.calls.filter(call => call[0].startsWith('/sync/state?'))).toHaveLength(1);
    expect(f.db.prepare('SELECT manifest_json,manifest_hash FROM remote_history_migrations').all()).toEqual(archive);
    expect(f.store.sync('local')!.stream_epoch).toBe('server-stream');
    expect(legacyState(f)).toEqual(original);
    f.store.transaction(() => {
      recordRemoteSessionDeletion(f.store, 'local'); f.db.prepare("DELETE FROM cowork_sessions WHERE id='local'").run();
    });
    expect(() => availabilityDeletion(f.store, f.context, f.state())).not.toThrow();
  });

  it.each(['streamEpoch', 'writerGeneration', 'controlEpoch', 'sessionId', 'controlReady', 'state'])('rejects incomplete or mismatched current-writer proof: %s', async field => {
    const f = fixture(); await f.controls();
    const state = f.state(); delete state.streamEpoch; f.publisher.ledger.saveSession(state);
    f.db.prepare('UPDATE remote_sync SET stream_epoch=NULL WHERE local_id=?').run('local');
    const ordinary = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => args[0].startsWith('/sync/state?')
      ? { ...await ordinary(...args), [field]: field === 'controlReady' ? false : field === 'streamEpoch' ? null : 'other' } : ordinary(...args));
    await f.controls();
    expect(f.store.sync('local')!.stream_epoch).toBeNull();
    expect(f.state().streamEpoch).toBeUndefined();
  });

  it('retries missing identity separately while later control facts continue to publish', async () => {
    const f = fixture(); await f.controls();
    const state = f.state(); delete state.streamEpoch; f.publisher.ledger.saveSession(state);
    f.db.prepare('UPDATE remote_sync SET stream_epoch=NULL WHERE local_id=?').run('local');
    const ordinary = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      if (args[0].startsWith('/sync/state?')) throw new Error('state unavailable');
      return ordinary(...args);
    });
    await f.controls();
    f.store.transaction(() => f.db.prepare("UPDATE cowork_sessions SET title='Changed after failed identity read' WHERE id='local'").run());
    await f.controls();
    expect(f.request.mock.calls.filter(call => call[0] === '/control/facts/batches')).toHaveLength(1);
    expect(f.request.mock.calls.filter(call => call[0].startsWith('/sync/state?'))).toHaveLength(1);
    expect(f.store.sync('local')!.stream_epoch).toBeNull();
    expect(f.publisher.legacyHistoryAllowed('local')).toBe(false);
  });

  it('isolates a failed active core mirror while control facts continue and retries the saved epoch', async () => {
    const f = fixture(); await f.controls();
    f.db.prepare('UPDATE remote_sync SET stream_epoch=NULL WHERE local_id=?').run('local');
    f.db.exec("CREATE TRIGGER fail_active_identity BEFORE UPDATE OF stream_epoch ON remote_sync BEGIN SELECT RAISE(FAIL,'core unavailable'); END");
    await f.controls();
    f.store.transaction(() => f.db.prepare("UPDATE cowork_sessions SET title='Changed while identity write failed' WHERE id='local'").run());
    await f.controls();
    expect(f.request.mock.calls.filter(call => call[0] === '/control/facts/batches')).toHaveLength(1);
    expect(f.store.sync('local')!.stream_epoch).toBeNull();
    expect((f.publisher as any).failures.get(`${f.context.scope}:deletion-identity:local`).count).toBe(1);
    expect(f.publisher.legacyHistoryAllowed('local')).toBe(false);
    f.db.exec('DROP TRIGGER fail_active_identity');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    await f.controls();
    expect(f.store.sync('local')!.stream_epoch).toBe('server-stream');
    expect(f.request.mock.calls.some(call => call[0].startsWith('/sync/state?'))).toBe(false);
    expect((f.publisher as any).failures.has(`${f.context.scope}:deletion-identity:local`)).toBe(false);
  });

  it('does not apply a state response after a target switch and return', async () => {
    const f = fixture(); await f.controls();
    const state = f.state(); delete state.streamEpoch; f.publisher.ledger.saveSession(state);
    f.db.prepare('UPDATE remote_sync SET stream_epoch=NULL WHERE local_id=?').run('local');
    const ordinary = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      const result = await ordinary(...args);
      if (args[0].startsWith('/sync/state?')) f.setContext({ ...f.context, routeEpoch: 3 });
      return result;
    });
    await f.controls();
    expect(f.store.sync('local')!.stream_epoch).toBeNull();
  });

  it.each(['owner', 'target', 'device', 'session', 'frozen', 'deleted', 'security', 'conflict', 'controlBinding'])('fails closed for a changed core binding: %s', async change => {
    const f = fixture(); await f.controls();
    f.db.prepare('UPDATE remote_sync SET stream_epoch=NULL WHERE local_id=?').run('local');
    if (change === 'owner') f.db.prepare("UPDATE cowork_session_ownership SET owner_user_id='other' WHERE session_id='local'").run();
    if (change === 'target') f.db.prepare("UPDATE remote_sync SET sync_environment='other' WHERE local_id='local'").run();
    if (change === 'device') f.db.prepare("UPDATE remote_sync SET device_id='other' WHERE local_id='local'").run();
    if (change === 'session') f.db.prepare("UPDATE remote_sync SET session_id='other' WHERE local_id='local'").run();
    if (change === 'frozen') f.store.freezeMigration('local');
    if (change === 'deleted') f.store.put('localGcDeleted:local', { deletedAt: 1 });
    if (change === 'security') f.store.setSecurityRecoveryRequired(true);
    if (change === 'conflict') f.db.prepare("UPDATE remote_sync SET stream_epoch='other' WHERE local_id='local'").run();
    if (change === 'controlBinding') f.store.put('availabilityDeletionBinding:local', { writerGeneration: 'other' });
    expect(() => mirrorAvailabilityDeletionIdentity(f.store, f.context, f.state())).toThrow(/REMOTE_DELETION_IDENTITY/u);
    expect(f.store.sync('local')!.stream_epoch).toBe(change === 'conflict' ? 'other' : null);
  });

  it('leaves an old server on the original control behavior without identity reads or mutations', async () => {
    const f = fixture(); f.setContext({ ...f.context, controlDeletionSupported: false });
    const ordinary = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      const result = await ordinary(...args);
      if (args[0] === '/sync/mode-activations') delete result.streamEpoch;
      return result;
    });
    await f.controls();
    expect(f.publisher.controlReady('local')).toBe(true);
    expect(f.store.sync('local')!.stream_epoch).toBeNull();
    expect(f.request.mock.calls.some(call => call[0].startsWith('/sync/state?'))).toBe(false);
    expect(f.publisher.legacyHistoryAllowed('local')).toBe(false);
  });

  it('keeps an already matched identity readable while a deletion fence closes new mutation admission', async () => {
    const f = fixture(); await f.controls();
    const before = f.store.sync('local');
    f.store.put(`${RemoteDeletion.Fence}local`, { phase: RemoteDeletion.Stopped });
    f.store.setControlAdmission(() => false); f.store.setTaskAdmission(() => false);
    expect(() => mirrorAvailabilityDeletionIdentity(f.store, f.context, f.state())).not.toThrow();
    expect(f.store.sync('local')).toEqual(before);
    f.db.prepare('UPDATE remote_sync SET stream_epoch=NULL WHERE local_id=?').run('local');
    expect(() => mirrorAvailabilityDeletionIdentity(f.store, f.context, f.state())).toThrow('REMOTE_DELETION_IDENTITY_UNRESOLVED');
  });

  it('preserves an existing v2 stream and does not advertise the extension to an old server', async () => {
    const f = fixture();
    f.db.prepare("UPDATE remote_sync SET sync_protocol_version=2,stream_epoch='server-stream' WHERE local_id='local'").run();
    const original = legacyState(f); await f.controls();
    expect(legacyState(f)).toEqual(original);
    const bridge: any = new RemoteBridge({ store: f.store, identity: { installationId: 'instance', deviceKey: 'key', databaseId: 'db' },
      runSessionTransaction: operation => f.store.transaction(operation), getOwner: () => f.owner,
      getEnvironment: () => RemoteEnvironment.Test, getApiBaseUrl: () => 'https://example.com', request: async () => new Response(),
      metadata: { name: 'Desktop', hostName: 'host', platform: 'macos', appVersion: '1', instanceLabel: 'default' },
      prepare: () => { throw new Error('unused'); }, execute: async () => ({}), onAccountChange: () => {},
    });
    cleanup.push(() => bridge.stop()); bridge.owner = f.owner; bridge.deletions = {};
    const capabilities = [RemoteCapability.SameAccountAccess, RemoteDeletion.Capability];
    const support = { enabled: true, protocolVersions: [1], capabilities, sessionDeletion: { available: true } };
    await bridge.refreshCapabilities(support);
    expect(bridge.advertisedCapabilities()).toContain(RemoteDeletion.Capability);
    expect(bridge.advertisedCapabilities()).not.toContain(RemoteDeletion.ControlCapability);
    await bridge.refreshCapabilities({ ...support, capabilities: [...capabilities, RemoteDeletion.ControlCapability] });
    expect(bridge.advertisedCapabilities()).toContain(RemoteDeletion.ControlCapability);
    await bridge.refreshCapabilities(support);
    expect(bridge.advertisedCapabilities()).not.toContain(RemoteDeletion.ControlCapability);
  });
});
