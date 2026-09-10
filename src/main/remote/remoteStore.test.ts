import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { fenceCronJobs,filterOwnedInstances } from './automationOwnership';
import { payloadHash, stableJson } from './canonical';
import { createRemoteDatabaseFence, loadRemoteIdentity } from './installationIdentity';
import { RemoteStore } from './remoteStore';

const owner = { userId: '10001', scopeKey: 'personal' };
const other = { userId: '10002', scopeKey: 'personal' };
const databases: Database.Database[] = [];
const directories: string[] = [];
function fixture(filename = ':memory:', withArtifacts = false): RemoteStore {
  const db = new Database(filename); databases.push(db);
  db.exec(`CREATE TABLE IF NOT EXISTS cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE IF NOT EXISTS cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  if (withArtifacts) db.exec(`CREATE TABLE library_local_artifacts(id TEXT PRIMARY KEY,file_name TEXT,extension TEXT,size_bytes INTEGER,availability TEXT,file_path TEXT,path_key TEXT);
    CREATE TABLE library_artifact_sessions(artifact_id TEXT,session_id TEXT,last_message_id TEXT);`);
  return new RemoteStore(db);
}
function create(store: RemoteStore, id: string, owned = true): void {
  store.transaction(() => {
    store.db.prepare("INSERT INTO cowork_sessions VALUES (?,?,1,1,'idle')").run(id, id);
    if (owned) store.assignNew(id, owner, 'local_create');
  });
}
function message(store: RemoteStore, content: string): void {
  store.transaction(() => store.db.prepare("INSERT INTO cowork_messages VALUES ('m','s','assistant',?,null,2,1)").run(content));
}
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('durable ownership and synchronization', () => {
  it('records ownership while remote is off and never adopts unowned history', () => {
    const store = fixture(); create(store, 'legacy', false); create(store, 's');
    store.setEnabledOwner(owner);
    store.transaction(() => store.db.prepare("UPDATE cowork_sessions SET title='continued' WHERE id='legacy'").run());
    expect(store.owner('legacy')).toBeNull(); expect(store.owner('s')).toEqual(owner);
    expect(store.sessions(owner).map(s => s.local_id)).toEqual(['s']);
  });
  it('rolls back creation and owner together', () => {
    const store = fixture();
    expect(() => store.transaction(() => { create(store, 's'); throw new Error('fail'); })).toThrow('fail');
    expect(store.owner('s')).toBeNull(); expect(store.sync('s')).toBeNull();
  });
  it('rejects cross-account controls and separates enterprise ownership', () => {
    const store = fixture(); create(store, 's');
    expect(() => store.assertActor('s', other)).toThrow();
    expect(() => store.assertActor('s', { ...owner, scopeKey: 'enterprise:1' })).toThrow();
    expect(() => store.assertActor('s', owner)).not.toThrow();
  });
  it('quarantines writes made by an unsupported old binary', () => {
    const store = fixture(); create(store, 's');
    store.db.prepare("UPDATE cowork_sessions SET title='old writer' WHERE id='s'").run();
    expect(store.owner('s')).toBeNull(); expect(() => store.assertActor('s', owner)).toThrow();
  });
  it('keeps assigned outbox payloads immutable and increments replacement revision', () => {
    const store = fixture(); store.setEnabledOwner(owner); create(store, 's'); message(store, 'one');
    const before = store.pending('s').find(e => e.eventType === 'message.upsert')!;
    store.transaction(() => store.db.prepare("UPDATE cowork_messages SET content='two' WHERE id='m'").run());
    const messages = store.pending('s').filter(e => e.eventType === 'message.upsert');
    expect(messages[0]).toEqual(before); expect(messages[1].payload.message.revision).toBe('2');
    expect(messages[0].payload.message.blocks[0].text).toBe('one');
  });
  it('drops raw tool input, thinking and oversized complete content', () => {
    const store = fixture(); store.setEnabledOwner(owner); create(store, 's'); message(store, '<thinking>private</thinking>public');
    expect(JSON.stringify(store.snapshot('s'))).not.toContain('private');
    store.transaction(() => store.db.prepare("UPDATE cowork_messages SET content=? WHERE id='m'").run('x'.repeat(600000)));
    const m = store.snapshot('s').records.find(r => r.eventType === 'message.upsert')!.payload.message;
    expect(m.contentState).toBe('desktop_only'); expect(m.blocks).toEqual([]);
  });
  it('validates ACK identity and sequence before deleting durable outbox', () => {
    const store = fixture(); store.setEnabledOwner(owner); create(store, 's'); message(store, 'hello');
    const remoteId = store.sync('s')!.session_id; store.bindRemote('s', remoteId, 'desktop');
    const count = store.pending('s').length;
    expect(() => store.acknowledge('s', 'wrong', remoteId, '1', '1')).toThrow();
    expect(() => store.acknowledge('s', 'desktop', remoteId, '999', '999')).toThrow();
    expect(store.pending('s')).toHaveLength(count);
    const seq = String(store.sync('s')!.source_seq); store.acknowledge('s', 'desktop', remoteId, seq, '10', true);
    expect(store.pending('s')).toEqual([]); expect(store.sync('s')!.needs_snapshot).toBe(0);
  });
  it('preserves uncertain runs across restart and uses synchronous FULL persistence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-test-')); directories.push(dir);
    const file = path.join(dir, 'db.sqlite'); const store = fixture(file); create(store, 's');
    const run = store.beginRun('s'); store.put('inbox:one', { state: 'executing', runId: run.runId });
    expect(store.db.pragma('synchronous', { simple: true })).toBe(2); store.db.close();
    const reopened = fixture(file); expect(reopened.run('s')!.runId).toBe(run.runId); expect(reopened.run('s')!.status).toBe('reconciling');
    expect(reopened.get('inbox:one')).toEqual({ state: 'executing', runId: run.runId });
  });
  it('quarantines restored checkpoints and removes inherited execution/source bindings', () => {
    const store = fixture(); create(store, 's'); store.bindSource('cron:job', owner);
    store.validateDatabaseInstance('instance', 0); store.put('inbox:c', { state: 'prepared' });
    store.validateDatabaseInstance('instance', 3);
    expect(store.owner('s')).toBeNull(); expect(store.get('inbox:c')).toBeNull(); expect(store.sourceOwner('cron:job')).toBeNull();
  });
  it('excludes real isThinking metadata from both preview and messages, tombstoning later reclassification', () => {
    const store = fixture(); store.setEnabledOwner(owner); create(store, 's'); message(store, 'bare private reasoning');
    store.transaction(() => store.db.prepare("UPDATE cowork_messages SET metadata=? WHERE id='m'").run(JSON.stringify({ isThinking: true })));
    const snapshot = store.snapshot('s');
    expect(JSON.stringify(snapshot)).not.toContain('bare private reasoning');
    expect(snapshot.records.some(r => r.eventType === 'message.deleted' && r.payload.messageId === 'm')).toBe(true);
  });
  it('retains all historical runs when several local rounds finish before remote is enabled', () => {
    const store = fixture(); create(store, 's');
    const first = store.beginRun('s'); store.updateRun('s', 'succeeded');
    const second = store.beginRun('s'); store.updateRun('s', 'failed', 'Task failed');
    store.setEnabledOwner(owner);
    const records = store.snapshot('s').records.filter(r => r.eventType === 'run.updated');
    expect(new Set(records.map(r => r.payload.run.runId))).toEqual(new Set([first.runId, second.runId]));
    const error = records.find(r => r.payload.run.runId === second.runId)!.payload.run.error;
    expect(typeof error.code).toBe('number'); expect(Object.keys(error)).toHaveLength(6);
  });
  it('never publishes a remotely reserved run until execution is dispatched', () => {
    const store = fixture(); store.setEnabledOwner(owner); create(store, 's');
    const run = store.beginRun('s', 'server-run', 'command');
    expect(store.snapshot('s').records.filter(r => r.eventType === 'run.updated')).toEqual([]);
    store.markRunDispatched('s');
    expect(store.snapshot('s').records.find(r => r.eventType === 'run.updated')!.payload.run.runId).toBe(run.runId);
  });
  it('captures deletion as a tombstone-only import and preserves newer snapshot requests on ACK', () => {
    const store = fixture(); store.setEnabledOwner(owner); create(store, 's'); message(store, 'body');
    const before = store.snapshot('s'); const mapping = store.sync('s')!; store.bindRemote('s', mapping.session_id, 'desktop');
    store.transaction(() => store.db.prepare("DELETE FROM cowork_sessions WHERE id='s'").run());
    const deleted = store.snapshot('s'); expect(deleted.records).toHaveLength(1); expect(deleted.records[0].eventType).toBe('session.deleted');
    store.acknowledge('s', 'desktop', mapping.session_id, before.baseSourceSeq, '1', true, before.snapshotEpoch);
    expect(store.sync('s')!.needs_snapshot).toBe(1);
  });
  it('publishes only related artifact metadata and observes catalog changes without file access', () => {
    const store = fixture(':memory:', true); store.setEnabledOwner(owner); create(store, 's'); message(store, 'Result');
    store.db.prepare("INSERT INTO library_local_artifacts VALUES ('a','report.pdf','.pdf',42,'available','/secret/path','secret-key')").run();
    store.db.prepare("INSERT INTO library_artifact_sessions VALUES ('a','s','m')").run();
    store.transaction(() => undefined);
    let snapshot = store.snapshot('s'); let item = snapshot.records.find(r => r.eventType === 'message.upsert')!.payload.message;
    expect(item.blocks[1]).toEqual({ type: 'artifact', artifactId: 'a', name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: '42', availability: 'desktop_only' });
    expect(JSON.stringify(snapshot)).not.toContain('/secret/path'); expect(JSON.stringify(snapshot)).not.toContain('secret-key');
    store.db.prepare("UPDATE library_local_artifacts SET availability='missing' WHERE id='a'").run(); store.transaction(() => undefined);
    snapshot = store.snapshot('s'); item = snapshot.records.find(r => r.eventType === 'message.upsert')!.payload.message;
    expect(item.blocks[1].availability).toBe('missing');
  });
  it('filters mismatched IM instances and pauses only verified other-owner cron jobs', () => {
    const store = fixture(); store.bindSource('im:nim:a', owner); store.bindSource('cron:job', owner);
    expect(filterOwnedInstances([{ instanceId: 'a' }, { instanceId: 'unowned' }], 'nim', store, other)).toEqual([{ instanceId: 'unowned' }]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-cron-')); directories.push(dir); fs.mkdirSync(path.join(dir, 'cron'));
    const file = path.join(dir, 'cron', 'jobs.json'); fs.writeFileSync(file, JSON.stringify({ jobs: [{ id: 'job', enabled: true }, { id: 'legacy', enabled: true }] }));
    fenceCronJobs(dir, store, other); expect(JSON.parse(fs.readFileSync(file, 'utf8')).jobs.map((j: any) => j.enabled)).toEqual([false, true]);
    fenceCronJobs(dir, store, owner); expect(JSON.parse(fs.readFileSync(file, 'utf8')).jobs[0].enabled).toBe(true);
  });
});

describe('canonical hashes and installation identity', () => {
  it('uses the shared UTF-8 golden canonical form', () => {
    const value = { b: '中文', a: ['1', { z: true, a: null }] };
    expect(stableJson(value)).toBe('{"a":["1",{"a":null,"z":true}],"b":"中文"}');
    expect(payloadHash(value)).toBe('7eaeb5e471966f6be4cc5d06226663f1a5f9d1bf9d791ce9f5d90e3cfa0c3086');
    expect(() => stableJson({ value: Infinity })).toThrow();
  });
  it('keeps profile credentials stable outside migrated data and advances the fence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-identity-')); directories.push(dir); const profile = path.join(dir, 'profile'); fs.mkdirSync(profile);
    const cipher = { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => v.toString() };
    const first = loadRemoteIdentity(dir, profile, cipher); expect(loadRemoteIdentity(dir, profile, cipher)).toEqual(first);
    const fence = createRemoteDatabaseFence(dir, profile, cipher, first); expect(fence.checkpoint).toBe(0); expect(fence.advance()).toBe(1);
    expect(createRemoteDatabaseFence(dir, profile, cipher, first).checkpoint).toBe(1);
    expect(() => loadRemoteIdentity(dir, profile, { ...cipher, isEncryptionAvailable: () => false })).toThrow();
  });
});

describe('approval projection compatibility', () => {
  function approval(overrides: Record<string, any> = {}): any {
    return { approvalId: 'approval', runId: 'run', approvalVersion: '1', title: 'Execute', summary: 'Public action',
      operationDigest: 'digest', remoteAllowed: true, requiresLocalAction: false, expiresAt: new Date(Date.now() + 60000).toISOString(),
      status: 'pending', resolvedAt: null, resolution: { phase: 'idle', source: null, confirmedDecision: null, confirmedAt: null }, ...overrides };
  }
  it('omits extended fields and remote execution for legacy servers, leaving assigned events immutable', () => {
    const store = fixture(); store.setEnabledOwner(owner); create(store, 's'); store.beginRun('s', 'run');
    store.updateApproval('s', approval({ pendingDecision: 'approved' }));
    const original = store.pending('s').find(event => event.eventType === 'approval.updated')!;
    expect(original.payload.approval.resolution).toBeUndefined();
    expect(original.payload.approval.pendingDecision).toBeUndefined();
    expect(original.payload.approval.remoteAllowed).toBe(false);
    store.setApprovalProjectionSupported(true);
    store.updateApproval('s', approval({ approvalVersion: '2' }));
    const events = store.pending('s').filter(event => event.eventType === 'approval.updated');
    expect(events[0]).toEqual(original);
    expect(events[1].payload.approval).toMatchObject({ approvalVersion: '2', remoteAllowed: true, resolution: { phase: 'idle' } });
  });
  it('keeps newer and closed approvals monotonic while retaining late confirmed history', () => {
    const store = fixture(); store.setEnabledOwner(owner); create(store, 's'); store.beginRun('s', 'run');
    const resolvedAt = new Date().toISOString();
    store.updateApproval('s', approval({ approvalVersion: '2', status: 'cancelled', remoteAllowed: false, resolvedAt,
      resolution: { phase: 'finished', source: 'system', confirmedDecision: null, confirmedAt: null } }));
    store.updateRun('s', 'cancelled');
    store.updateApproval('s', approval({ approvalVersion: '1' }));
    store.updateApproval('s', approval({ approvalVersion: '3' }));
    expect(store.get<any>('approval:s:approval')?.status).toBe('cancelled');
    const before = store.run('s');
    store.updateApproval('s', approval({ approvalVersion: '3', status: 'cancelled', remoteAllowed: false, resolvedAt,
      resolution: { phase: 'finished', source: 'unknown', confirmedDecision: 'approve', confirmedAt: new Date().toISOString() } }));
    expect(store.get<any>('approval:s:approval')?.resolution.confirmedDecision).toBe('approve');
    expect(store.get<any>('approval:s:approval')?.resolvedAt).toBe(resolvedAt);
    expect(store.run('s')).toEqual(before);
  });
  it('does not let wall clock expiry overwrite a dispatched unknown decision', () => {
    const store = fixture(); store.setEnabledOwner(owner); create(store, 's'); store.beginRun('s', 'run');
    store.updateApproval('s', approval({ remoteAllowed: false, resolution: { phase: 'unknown', source: 'mobile', confirmedDecision: null, confirmedAt: null } }));
    store.expireApprovals(Date.now() + 3600000);
    expect(store.get<any>('approval:s:approval')?.status).toBe('pending');
    expect(store.run('s')?.status).toBe('reconciling');
  });
});

it('sends exact approval closure before a published run terminal even when each event is a separate HTTP batch', () => {
  const store = fixture(); store.setEnabledOwner(owner); store.setApprovalProjectionSupported(true);
  create(store, 's'); store.beginRun('s', 'run');
  const approval = { approvalId: 'approval', runId: 'run', approvalVersion: '1', title: 'Execute', summary: 'Safe action',
    operationDigest: 'digest', remoteAllowed: true, requiresLocalAction: false, expiresAt: new Date(Date.now() + 60000).toISOString(),
    status: 'pending', resolvedAt: null, resolution: { phase: 'idle', source: null, confirmedDecision: null, confirmedAt: null } };
  store.updateApproval('s', approval);
  const initial = store.pending('s');
  const boundary = Number(initial.at(-1)!.sourceSeq);
  const resolvedAt = '2026-09-10T01:02:03.000Z';
  const closed = { ...approval, approvalVersion: '2', status: 'cancelled', remoteAllowed: false, resolvedAt,
    resolution: { phase: 'finished', source: 'system', confirmedDecision: null, confirmedAt: null } };
  store.transaction(() => { store.updateApproval('s', closed); store.updateRun('s', 'cancelled'); });
  const finishing = store.pending('s').filter(event => Number(event.sourceSeq) > boundary);
  const approvalAt = finishing.findIndex(event => event.eventType === 'approval.updated');
  const runAt = finishing.findIndex(event => event.eventType === 'run.updated');
  const summaryAt = finishing.findIndex(event => event.eventType === 'session.upsert');
  expect(approvalAt).toBeGreaterThanOrEqual(0); expect(approvalAt).toBeLessThan(runAt); expect(approvalAt).toBeLessThan(summaryAt);
  // Model the previous server's stronger per-event cancellation behavior. Splitting into
  // one-event batches must never create a server-clock resolvedAt competing with our v2.
  let serverApproval: any = null;
  let synthesized = 0;
  for (const event of [...initial, ...finishing]) {
    if (event.eventType === 'approval.updated') {
      const incoming = event.payload.approval;
      if (serverApproval?.approvalVersion === incoming.approvalVersion) expect(incoming).toEqual(serverApproval);
      serverApproval = incoming;
    } else if (event.eventType === 'run.updated' && event.payload.run.status === 'cancelled' && serverApproval?.status === 'pending') {
      synthesized++;
      serverApproval = { ...serverApproval, status: 'cancelled', approvalVersion: String(BigInt(serverApproval.approvalVersion) + 1n), resolvedAt: '2026-09-10T02:00:00.000Z' };
    }
  }
  expect(synthesized).toBe(0); expect(serverApproval).toEqual(closed);
});
it('does not retrofit resolution into an already published legacy approval at the same version', () => {
  const store = fixture(); store.setEnabledOwner(owner); create(store, 's'); store.beginRun('s', 'run');
  const resolvedAt = new Date().toISOString();
  const closed = { approvalId: 'approval', runId: 'run', approvalVersion: '2', title: 'Execute', summary: 'Action', operationDigest: 'digest',
    remoteAllowed: false, requiresLocalAction: false, expiresAt: resolvedAt, status: 'cancelled', resolvedAt,
    resolution: { phase: 'finished', source: 'system', confirmedDecision: null, confirmedAt: null } };
  store.updateApproval('s', closed);
  const initial = store.pending('s').find(event => event.eventType === 'approval.updated')!;
  store.setApprovalProjectionSupported(true); store.snapshot('s');
  expect(store.pending('s').filter(event => event.eventType === 'approval.updated')).toEqual([initial]);
  store.updateApproval('s', { ...closed, approvalVersion: '3', resolution: { ...closed.resolution, source: 'unknown', confirmedDecision: 'approve', confirmedAt: resolvedAt } });
  const events = store.pending('s').filter(event => event.eventType === 'approval.updated');
  expect(events.at(-1)?.payload.approval).toMatchObject({ approvalVersion: '3', resolution: { confirmedDecision: 'approve' } });
});
