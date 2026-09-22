import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteOwner } from '../../shared/remote/constants';
import { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteApiError, RemoteBridge } from './remoteBridge';
import { type ProjectionRecord, RemoteStore } from './remoteStore';

const owner = { userId: '10001', scopeKey: 'personal' };
const conflictMessage = 'Changing the current run must advance controlVersion';
const conflict = () => new RemoteApiError(47006, conflictMessage, { reason: 'IDEMPOTENCY_CONFLICT' }, 409);
const fixtures: Array<{ store: RemoteStore; bridge: RemoteBridge }> = [];

interface ServerState { control: bigint; runId: string | null; source: number; seq: number; messages: Set<string> }

// Mirrors RemoteSyncService.publishSummary/apply and the batch transaction boundary.
// A rejected batch cannot advance any server watermarks or publish partial messages.
function applyRecord(state: ServerState, record: ProjectionRecord): void {
  if (record.eventType === 'session.upsert') {
    const summary = record.payload.session;
    const control = BigInt(summary.controlVersion);
    const runId = summary.run?.runId ?? null;
    if (control >= state.control) {
      if (control === state.control && runId !== state.runId) throw conflict();
      state.control = control; state.runId = runId;
    }
  } else if (record.eventType === 'run.updated') {
    const control = BigInt(record.payload.controlVersion);
    if (control > state.control) { state.control = control; state.runId = record.payload.run.runId; }
  } else if (record.eventType === 'message.upsert') state.messages.add(record.payload.message.messageId);
}
function clone(state: ServerState): ServerState { return { ...state, messages: new Set(state.messages) }; }
function outbox(store: RemoteStore): Array<{ source_seq: number; event_json: string }> {
  return store.db.prepare('SELECT source_seq,event_json FROM remote_outbox WHERE session_id=? ORDER BY source_seq').all('task') as Array<{ source_seq: number; event_json: string }>;
}
function retry(store: RemoteStore): void {
  store.put('syncFailure:task', { ...store.get<any>('syncFailure:task'), retryAt: 0 });
}
function addMessage(store: RemoteStore, id: string): void {
  store.transaction(() => store.db.prepare("INSERT INTO cowork_messages VALUES (?,'task','assistant',?,NULL,2,2)").run(id, id));
}
function fixture() {
  vi.spyOn(console, 'debug').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db);
  store.setEnabledOwner(owner);
  store.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES ('task','Conversation',1,1,'idle')").run();
    store.assignNew('task', owner, 'local_create');
  });
  store.beginRun('task', 'first-run'); store.updateRun('task', 'running'); store.updateRun('task', 'succeeded');
  const baseline = store.snapshot('task');
  const sessionId = store.sync('task')!.session_id;
  store.bindRemote('task', sessionId, 'desktop');
  store.acknowledge('task', 'desktop', sessionId, baseline.baseSourceSeq, '1', true, baseline.snapshotEpoch);
  const server: ServerState = { control: 3n, runId: 'first-run', source: Number(baseline.baseSourceSeq), seq: 1, messages: new Set() };
  let loggedIn: RemoteOwner = owner;
  let importRequest: any;
  const options: { requestError?: Error; commitError?: Error; onRequest?: () => void; onCommit?: () => void } = {};
  const imports: any[] = [];
  const request = vi.fn(async (_actor: RemoteOwner, pathname: string, init: RequestInit) => {
    options.onRequest?.();
    if (options.requestError) throw options.requestError;
    const body = init.body ? JSON.parse(String(init.body)) : null;
    let data: any;
    if (pathname.endsWith('/sync/batches')) {
      const draft = clone(server);
      for (const event of body.events) {
        expect(Number(event.sourceSeq)).toBe(draft.source + 1);
        applyRecord(draft, event); draft.source++; draft.seq++;
      }
      Object.assign(server, draft);
      data = { batchId: body.batchId, sessionId, deviceId: 'desktop', committedSourceSeq: String(server.source), committedSeq: String(server.seq) };
    } else if (pathname.endsWith('/sync/imports')) {
      expect(body.expectedSourceSeq).toBe(String(server.source));
      expect(body.expectedServerSeq).toBe(String(server.seq));
      importRequest = body; imports.push(body);
      data = { sessionId, state: 'uploading', stateVersion: '1' };
    } else if (pathname.includes('/parts/')) data = {};
    else if (pathname.endsWith('/commit')) {
      if (options.commitError) throw options.commitError;
      const saved = store.get<any>('import:task')!;
      const records: ProjectionRecord[] = saved.parts.flatMap((part: any) => part.payload.records);
      const summary = records.find(record => record.eventType === 'session.upsert')!;
      expect(BigInt(summary.payload.session.controlVersion)).toBeGreaterThanOrEqual(server.control);
      const draft = clone(server); applyRecord(draft, summary);
      for (const record of records) if (record.eventType === 'message.upsert') applyRecord(draft, record);
      options.onCommit?.();
      draft.source = Number(importRequest.baseSourceSeq); draft.seq++;
      Object.assign(server, draft);
      data = { sessionId, state: 'committed', stateVersion: '2', committedSourceSeq: String(server.source), committedSeq: String(server.seq) };
    } else throw new Error(`Unexpected request ${pathname}`);
    return new Response(JSON.stringify({ code: 0, message: 'success', data }));
  });
  const bridge: any = new RemoteBridge({ store, identity: { installationId: 'instance', deviceKey: 'key', databaseId: 'db' },
    runSessionTransaction: <T>(operation: () => T) => store.transaction(operation),
    getOwner: () => loggedIn, getEnvironment: () => RemoteEnvironment.Test, getApiBaseUrl: () => 'https://example.com', request,
    metadata: { name: 'Desktop', hostName: 'host', platform: 'macos', appVersion: '1', instanceLabel: 'default' },
    prepare: vi.fn(), execute: vi.fn(), onAccountChange: vi.fn() });
  bridge.owner = owner; bridge.registration = { deviceId: 'desktop', ...owner, metadataVersion: '1' }; bridge.generation = '1'; bridge.sameAccountAccess = true;
  store.setWake(() => {});
  fixtures.push({ store, bridge });
  return { store, bridge, server, request, options, imports, changeOwner: () => { loggedIn = { ...owner, userId: 'other' }; } };
}
function reserve(store: RemoteStore): void { store.beginRun('task', 'second-run', 'phone-command'); }
function legacyPublish(store: RemoteStore): void {
  // Reproduce the old dispatch write exactly without calling the fixed production method.
  store.transaction(() => {
    store.put('runPublished:second-run', true);
    store.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run('task');
  });
}
afterEach(() => {
  for (const { bridge, store } of fixtures.splice(0)) { bridge.stop(); store.db.close(); }
  vi.restoreAllMocks();
});

describe('remote run publication and durable recovery', () => {
  it('advances control only on the first publication of a privately reserved phone run', async () => {
    const { store, bridge, server } = fixture(); reserve(store);
    const hidden = store.pending('task').find(event => event.eventType === 'session.upsert')!;
    expect(hidden.payload.session.run).toBeNull(); expect(hidden.payload.session.controlVersion).toBe('4');
    store.markRunDispatched('task');
    expect(BigInt(store.controlVersion('task'))).toBeGreaterThan(4n);
    const publishedControl = store.controlVersion('task');
    store.markRunDispatched('task'); expect(store.controlVersion('task')).toBe(publishedControl);
    store.remove('runPublished:second-run');
    store.markRunDispatched('task'); expect(store.controlVersion('task')).toBe(publishedControl);
    await bridge.syncSessions();
    expect(server.runId).toBe('second-run'); expect(store.pending('task')).toEqual([]);
  });

  for (const partialAck of [false, true]) it(`recovers immutable legacy events through a snapshot (${partialAck ? 'reserved prefix already acknowledged' : 'entire batch rolled back'})`, async () => {
    const { store, bridge, server, imports } = fixture(); reserve(store);
    if (partialAck) { await bridge.syncSessions(); expect(server.control).toBe(4n); expect(server.runId).toBeNull(); }
    legacyPublish(store); addMessage(store, 'second-answer');
    const before = outbox(store), acknowledged = store.sync('task')!.ack_seq;
    await bridge.syncSessions();
    expect(store.get<any>('syncFailure:task')?.code).toBe(47006);
    expect(store.sync('task')!.needs_snapshot).toBe(1);
    expect(store.sync('task')!.ack_seq).toBe(acknowledged);
    expect(outbox(store).filter(event => event.source_seq <= before.at(-1)!.source_seq)).toEqual(before);
    expect(server.source).toBe(acknowledged); expect(server.messages.has('second-answer')).toBe(false);
    expect(BigInt(store.controlVersion('task'))).toBeGreaterThan(server.control);
    retry(store); await bridge.syncSessions();
    expect(imports).toHaveLength(1); expect(server.runId).toBe('second-run'); expect(server.messages.has('second-answer')).toBe(true);
    expect(store.pending('task')).toEqual([]); expect(store.get('syncFailure:task')).toBeNull();
    expect(store.sync('task')!.ack_seq).toBe(server.source); expect(store.sync('task')!.needs_snapshot).toBe(0);
  });

  it('keeps the snapshot, original events and repair version when snapshot commit fails repeatedly', async () => {
    const { store, bridge, options, imports } = fixture(); reserve(store); legacyPublish(store);
    await bridge.syncSessions();
    expect(store.sync('task')!.needs_snapshot).toBe(1);
    const before = outbox(store), control = store.controlVersion('task');
    const epoch = store.get('snapshotEpoch:task'), ack = store.sync('task')!.ack_seq;
    options.commitError = conflict();
    for (let attempt = 0; attempt < 2; attempt++) {
      retry(store); await bridge.syncSessions();
      expect(store.controlVersion('task')).toBe(control); expect(store.get('snapshotEpoch:task')).toBe(epoch);
      expect(outbox(store).filter(event => event.source_seq <= before.at(-1)!.source_seq)).toEqual(before);
      expect(store.sync('task')!.ack_seq).toBe(ack); expect(store.get<any>('import:task')?.beginConfirmed).toBe(true);
    }
    expect(new Set(imports.map(value => value.importId)).size).toBe(1);
    delete options.commitError; retry(store); await bridge.syncSessions(); expect(store.pending('task')).toEqual([]);
  });

  for (const [code, message] of [[47006, 'Object version has different content'], [47019, conflictMessage]] as const) {
    it(`does not replace events for unrelated rejection ${code}: ${message}`, async () => {
      const { store, bridge, options } = fixture(); reserve(store); legacyPublish(store);
      const before = outbox(store), control = store.controlVersion('task');
      options.requestError = new RemoteApiError(code, message, null, 409);
      await bridge.syncSessions();
      expect(store.sync('task')!.needs_snapshot).toBe(0); expect(store.controlVersion('task')).toBe(control);
      expect(outbox(store)).toEqual(before); expect(store.get('import:task')).toBeNull();
    });
  }

  for (const switched of ['owner', 'device'] as const) it(`does not repair another ${switched} after a delayed rejection`, async () => {
    const { store, bridge, options, changeOwner } = fixture(); reserve(store); legacyPublish(store);
    const before = outbox(store), control = store.controlVersion('task');
    options.requestError = conflict();
    options.onRequest = switched === 'owner' ? changeOwner : () => { bridge.registration.deviceId = 'replacement'; };
    await bridge.syncSessions();
    expect(store.sync('task')!.needs_snapshot).toBe(0); expect(store.controlVersion('task')).toBe(control);
    expect(outbox(store)).toEqual(before); expect(store.get('syncFailure:task')).toBeNull();
  });

  it('retains events appended after the replacement snapshot baseline until their own ACK', async () => {
    const { store, bridge, options, server } = fixture(); reserve(store); legacyPublish(store); addMessage(store, 'before-snapshot');
    await bridge.syncSessions(); expect(store.sync('task')!.needs_snapshot).toBe(1);
    options.onCommit = () => { addMessage(store, 'during-snapshot'); };
    retry(store); await bridge.syncSessions();
    expect(server.messages.has('before-snapshot')).toBe(true); expect(server.messages.has('during-snapshot')).toBe(false);
    const pending = store.pending('task');
    expect(pending.some(event => event.eventType === 'message.upsert' && event.payload.message.messageId === 'during-snapshot')).toBe(true);
    expect(pending.every(event => Number(event.sourceSeq) > store.sync('task')!.ack_seq)).toBe(true);
    delete options.onCommit; await bridge.syncSessions();
    expect(server.messages.has('during-snapshot')).toBe(true); expect(store.pending('task')).toEqual([]);
  });
});
