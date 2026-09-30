import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteTelemetryEvent } from '../../shared/remote/telemetry';
import { type InboxEntry, RemoteBridge } from './remoteBridge';
import { RemoteStore } from './remoteStore';
import { REMOTE_SYNC_REQUEST_ID_HEADER } from './remoteSyncLog';
import { configureRemoteTelemetry, shutdownRemoteTelemetry } from './remoteTelemetry';

vi.mock('./remoteLogSink', () => ({ enqueueRemoteLog: vi.fn() }));
const owner = { userId: '10001', scopeKey: 'personal' };
const fixtures: Array<{ bridge: RemoteBridge; db: Database.Database }> = [];
afterEach(async () => { await shutdownRemoteTelemetry(); for (const f of fixtures.splice(0)) { f.bridge.stop(); f.db.close(); } vi.restoreAllMocks(); });
function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db), execute = vi.fn();
  const request = vi.fn(async (_owner, _pathname, _init): Promise<Response> => new Response(JSON.stringify({ code: 0, data: {} })));
  const bridge: any = new RemoteBridge({ store, identity: { installationId: 'instance', deviceKey: 'private-key', databaseId: 'db' },
    runSessionTransaction: <T>(operation: () => T) => store.transaction(operation), getOwner: () => owner,
    getEnvironment: () => RemoteEnvironment.Test, getApiBaseUrl: () => 'https://example.com', request,
    metadata: { name: 'Desktop', hostName: 'host', platform: 'macos', appVersion: '1', instanceLabel: 'default' },
    prepare: vi.fn(), execute, onAccountChange: vi.fn() });
  bridge.owner = owner; bridge.registration = { deviceId: 'desktop', ...owner, metadataVersion: '1' };
  bridge.generation = '1'; bridge.sameAccountAccess = true;
  store.put('settings:10001:personal', { enabled: true, name: 'Desktop', settingsVersion: '1', workspaces: [] });
  const target = bridge.targets.activateLegacy({ owner, deviceId: 'desktop', allowPartialLegacy: true });
  bridge.targetId = target.targetId; store.setProjectionIdentity(target.targetId, owner, 'desktop');
  store.setFileEnvironment(target.targetId); store.setWake(() => {}); store.setEnabledOwner(owner);
  store.transaction(() => { db.exec("INSERT INTO cowork_sessions VALUES('local','private-session-content',1,1,'idle')"); store.assignNew('local', owner, 'local_create'); });
  const snapshot = store.snapshot('local'), row = store.sync('local')!;
  store.bindRemote('local', row.session_id, 'desktop');
  store.acknowledge('local', 'desktop', row.session_id, snapshot.baseSourceSeq, '1', true, snapshot.snapshotEpoch);
  fixtures.push({ bridge, db });
  let now = 100000;
  const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  const telemetry = configureRemoteTelemetry({ context: { epoch: 'epoch', enabled: true, installationId: 'instance', appVersion: '1',
    environment: 'test', remoteEnvironment: 'test', userId: owner.userId, remoteOwnerId: owner.userId, ownerScopeId: 'personal',
    identityNamespace: 'server_user_id', scopeKind: 'personal', deviceId: 'desktop' }, fetch, now: () => now, monotonicNow: () => now, autoStart: false })!;
  return { db, store, bridge, request, execute, telemetry, snapshot, fetch,
    drain: async () => { now += 60000; telemetry.flushWindows(); for (let i = 0; i < 35; i++) { await telemetry.pump(); now += 10000; }
      return fetch.mock.calls.map(call => new URL(call[0]).searchParams); } };
}
const response = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
function dirty(f: ReturnType<typeof fixture>): void {
  f.store.transaction(() => f.db.exec("INSERT INTO cowork_messages VALUES('message','local','assistant','private-message-content','{}',2,1)"));
}
function entry(f: ReturnType<typeof fixture>): InboxEntry {
  const sessionId = f.store.sync('local')!.session_id;
  return { targetId: f.bridge.targetId, owner, command: { commandId: 'command-1', type: 'send_message', sessionId,
    status: 'received', statusVersion: '3', expiresAt: new Date(Date.now() + 60000).toISOString(), claimId: 'claim', claimToken: 'private-claim-token',
    claimUntil: new Date(Date.now() + 15000).toISOString(), request: { payload: { text: 'private-command-text' } }, requestHash: 'hash' },
    localSessionId: 'local', remoteSessionId: sessionId, runId: null, state: 'applied', result: null };
}

describe('legacy sync and recovered command telemetry through the real reporter', () => {
  for (const failure of ['database', 'receipt'] as const) it(`preserves the legacy batch and distinguishes ${failure} failure from HTTP success`, async () => {
    const f = fixture(); dirty(f);
    const before = f.store.sync('local')!.ack_seq;
    f.request.mockImplementation(async (_owner, _pathname, init) => { const body = JSON.parse(String(init.body));
      return response({ batchId: failure === 'receipt' ? 'other-batch' : body.batchId, deviceId: 'desktop',
        sessionId: body.sessionId, committedSourceSeq: body.events.at(-1).sourceSeq, committedSeq: '2' }); });
    if (failure === 'database') f.db.exec("CREATE TRIGGER fail_ack BEFORE UPDATE OF ack_seq ON remote_sync BEGIN SELECT RAISE(ABORT,'private-disk-error'); END");
    await expect(f.bridge.syncSession(f.store.sync('local'), () => true, f.bridge.taskContext(), false)).rejects.toThrow();
    expect(f.store.sync('local')!.ack_seq).toBe(before); expect(f.store.pending('local').length).toBeGreaterThan(0);
    const sent = await f.drain();
    expect(sent.some(q => q.get('event_name') === RemoteTelemetryEvent.Sealed && q.get('publication_kind') === 'legacy_batch')).toBe(true);
    expect(sent.some(q => q.get('event_name') === RemoteTelemetryEvent.Acknowledged)).toBe(false);
    expect(sent.some(q => q.get('event_name') === RemoteTelemetryEvent.SyncStage && q.get('stage') === (failure === 'database' ? 'local_ack_commit' : 'validate')
      && q.get('reason') === (failure === 'database' ? 'STORAGE_UNAVAILABLE' : 'RECEIPT_INVALID'))).toBe(true);
    expect(f.telemetry.snapshot().stats.invalid_event ?? 0).toBe(0);
    expect(JSON.stringify(f.fetch.mock.calls)).not.toContain('private-');
  });
  it('reconciles the original expired import before allowing local replacement and never reports it committed', async () => {
    const f = fixture(), row = f.store.sync('local')!;
    const saved = { importId: 'original-import', sessionId: row.session_id, owner, deviceId: 'desktop', baseSourceSeq: f.snapshot.baseSourceSeq,
      snapshotEpoch: f.snapshot.snapshotEpoch, beginAttempted: true, beginConfirmed: true, manifest: { manifestHash: 'manifest' }, parts: [] };
    f.store.put('import:local', saved);
    f.request.mockResolvedValue(response({ importId: saved.importId, sessionId: saved.sessionId, manifestHash: 'manifest', state: 'expired' }));
    await f.bridge.abortUnavailableImport(row, saved, () => true);
    expect(f.store.get('import:local')).toBeNull(); expect(f.store.sync('local')!.needs_snapshot).toBe(1);
    const sent = await f.drain();
    expect(sent.some(q => q.get('event_name') === RemoteTelemetryEvent.Reconciled && q.get('operation_id') === saved.importId
      && q.get('business_status') === 'expired')).toBe(true);
    expect(sent.some(q => q.get('summary_kind') === 'sync_stage_window' && q.get('stage') === 'cleanup')).toBe(true);
    expect(sent.some(q => q.get('event_name') === RemoteTelemetryEvent.Acknowledged)).toBe(false);
    expect(f.telemetry.snapshot().stats.invalid_event ?? 0).toBe(0);
  });
  for (const type of ['send_message', 'approval_response', 'question_response']) for (const paused of [false, true]) it(`correlates nested ${type} reconciliation after the local receipt is durable (paused: ${paused})`, async () => {
    const f = fixture(), saved = entry(f); saved.command.type = type; f.store.put(f.bridge.inboxKey(saved), saved); f.bridge.quotaBlocked = paused;
    f.request.mockImplementation(async (_owner, pathname) => response(pathname.includes('/commands?')
      ? { items: [{ command: saved.command }], nextCursor: null }
      : { command: { ...saved.command, status: 'applied', statusVersion: '4' }, executionPermit: null }));
    if (paused) await f.bridge.reconcilePaused(); else await f.bridge.reconcile();
    expect(f.store.get<InboxEntry>(f.bridge.inboxKey(saved))!.command.statusVersion).toBe('4'); expect(f.execute).not.toHaveBeenCalled();
    const sent = await f.drain();
    const receipt = sent.find(q => q.get('event_name') === RemoteTelemetryEvent.CommandReceipt)!;
    expect(receipt).toBeDefined(); expect(receipt.get('business_status')).toBe('applied'); expect(receipt.get('server_status_version')).toBe('4');
    const request = f.request.mock.calls.find(call => call[1].endsWith('/reconcile'))!;
    expect(receipt.get('request_id')).toBe(new Headers(request[2].headers).get(REMOTE_SYNC_REQUEST_ID_HEADER));
    expect(f.telemetry.snapshot().stats.invalid_event ?? 0).toBe(0);
    expect(JSON.stringify(f.fetch.mock.calls)).not.toContain('private-');
  });
  it('reports a received-ACK that already reached applied without dispatching again', async () => {
    const f = fixture(), saved = { ...entry(f), state: 'prepared' as const }; f.store.put(f.bridge.inboxKey(saved), saved);
    f.request.mockResolvedValue(response({ ...saved.command, status: 'applied', statusVersion: '4' }));
    await f.bridge.applyEntry(saved, '1');
    expect(f.execute).not.toHaveBeenCalled(); expect(f.store.get<InboxEntry>(f.bridge.inboxKey(saved))!.state).toBe('applied');
    const sent = await f.drain();
    expect(sent.some(q => q.get('event_name') === RemoteTelemetryEvent.CommandReceipt && q.get('business_status') === 'applied')).toBe(true);
    expect(f.telemetry.snapshot().stats.invalid_event ?? 0).toBe(0);
  });
});
