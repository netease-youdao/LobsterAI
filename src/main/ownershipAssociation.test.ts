import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentOwnerKind } from '../shared/agent/constants';
import { OwnershipAction, OwnershipErrorCode, OwnershipResultStatus, OwnershipSyncState, OwnershipTargetKind } from '../shared/ownership/constants';
import type { OwnershipCommitRequest, OwnershipPreview, OwnershipTarget } from '../shared/ownership/types';
import type { RemoteOwner } from '../shared/remote/constants';
import { AgentOwnerStore } from './agentOwnership';
import { SubagentTracker } from './libs/agentEngine/subagent/tracker';
import { type OwnershipActor, OwnershipAssociationBlockReason, OwnershipAssociationService } from './ownershipAssociation';
import { OwnershipAssociationStore } from './ownershipAssociationStore';
import { OwnershipOperationGate } from './ownershipOperationGate';
import type { PublicationTarget } from './ownershipPublication';
import { LEGACY_IMPORT_TAKEOVER_ARCHIVE_PREFIX } from './remote/remoteImportSnapshots';
import { RemotePublicationKind } from './remote/remotePublicationOrigins';
import { RemoteStore } from './remote/remoteStore';
import { SubagentRunStore } from './subagentRunStore';

const a = { userId: 'a', scopeKey: 'personal' };
const b = { userId: 'b', scopeKey: 'personal' };
const task = (id: string): OwnershipTarget => ({ kind: OwnershipTargetKind.Task, id });
const agent = (id = 'office'): OwnershipTarget => ({ kind: OwnershipTargetKind.Agent, id });
const databases: Database.Database[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); });

function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,created_at INTEGER,updated_at INTEGER,subagent_allow_agent_ids TEXT);
    CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,agent_id TEXT,parent_session_id TEXT,status TEXT,created_at INTEGER,updated_at INTEGER,cwd TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);
    CREATE TABLE subagent_runs(id TEXT PRIMARY KEY,parent_session_id TEXT,child_cowork_session_id TEXT,agent_id TEXT,status TEXT,session_key TEXT,task TEXT,label TEXT,created_at INTEGER,ended_at INTEGER,messages_persisted INTEGER DEFAULT 0);
    INSERT INTO agents VALUES('main','Main',1,1,'[]'),('office','Office',1,1,'[]'),('other','Other',1,1,'[]');`);
  const remote = new RemoteStore(db);
  const agents = new AgentOwnerStore(db);
  const gate = new OwnershipOperationGate();
  let actor: OwnershipActor = { owner: a, generation: '1', label: 'Alice', scopeLabel: 'Personal' };
  let now = 1000;
  let publicationTarget: PublicationTarget | null = null;
  const deps = { store: { remote, agentOwnership: agents, runSessionTransaction: <T>(op: () => T): T => remote.transaction(op) },
    actor: () => actor, gate, now: () => now, publicationTarget: () => publicationTarget, confirmPublication: vi.fn(), deviceName: () => 'Computer', afterCommit: vi.fn() };
  const service = new OwnershipAssociationService(deps);
  let requests = 0;
  const create = (id: string, agentId = 'office', owner: RemoteOwner | null = null, parent: string | null = null) => {
    remote.transaction(() => {
      db.prepare("INSERT INTO cowork_sessions VALUES (?,?,?,?,'idle',10,20,'/existing/workspace')").run(id, id, agentId, parent);
      remote.assignNew(id, owner, 'local_create');
    });
  };
  const link = (parent: string, child: string | null, agentId = 'office', status = 'done', sessionKey: string | null = null) => {
    db.prepare('INSERT INTO subagent_runs(id,parent_session_id,child_cowork_session_id,agent_id,status,session_key) VALUES (?,?,?,?,?,?)').run(`run-${parent}-${child}`, parent, child, agentId, status, sessionKey);
  };
  const input = (preview: OwnershipPreview): OwnershipCommitRequest => ({ planId: preview.planId, planVersion: preview.planVersion,
    accountGeneration: preview.accountGeneration, requestId: `request-${++requests}` });
  const commit = (target: OwnershipTarget) => {
    const preview = service.preview(target);
    expect(preview.eligible).toBe(true);
    const request = input(preview);
    return { result: service.commit(request), request };
  };
  return { db, remote, agents, gate, service, deps, create, link, input, commit,
    setActor: (owner: RemoteOwner | null, generation = '2') => { actor = { ...actor, owner, generation }; },
    setPublicationTarget: (target: PublicationTarget | null) => { publicationTarget = target; },
    advance: () => { now += 400000; } };
}

describe('historical ownership association', () => {
  it('limits Agent detail counts and recent task titles to the current account and anonymous history', () => {
    const f = fixture(); f.create('anonymous'); f.create('mine', 'office', a); f.create('hidden', 'office', b);
    f.db.prepare("UPDATE cowork_sessions SET title='Private title',updated_at=999 WHERE id='hidden'").run();
    expect(f.service.getDetail(agent())).toMatchObject({ visibleTaskCount: 2, latestTaskTitle: 'mine' });
    expect(JSON.stringify(f.service.getDetail(agent()))).not.toContain('Private title');
    f.setActor(null);
    expect(f.service.getDetail(agent())).toMatchObject({ visibleTaskCount: 1, latestTaskTitle: 'anonymous' });
  });
  it('shows task and Agent ownership independently; signed-out users must authenticate', () => {
    const f = fixture(); f.create('s'); f.setActor(null);
    expect(f.service.getDetail(task('s'))).toMatchObject({ ownership: { kind: AgentOwnerKind.Anonymous },
      agent: { ownership: { kind: AgentOwnerKind.Anonymous } }, canAssociate: true, accountPartition: null });
    expect(f.service.preview(task('s'))).toMatchObject({ eligible: false, reason: OwnershipErrorCode.AuthRequired, tasks: [] });
    f.setActor(a); f.commit(task('s'));
    expect(f.service.getDetail(task('s'))).toMatchObject({ ownership: { kind: AgentOwnerKind.Owned, associatedAt: 1000 },
      agent: { ownership: { kind: AgentOwnerKind.Anonymous } }, syncState: OwnershipSyncState.Pending, canAssociate: false });
    f.setActor(b);
    expect(() => f.service.getDetail(task('s'))).toThrow(OwnershipErrorCode.NotAvailable);
  });

  it('associates the true root and descendants while leaving ordinary forks independent', () => {
    const f = fixture(); f.create('root'); f.create('child', 'other', null, 'root'); f.link('root', 'child', 'other');
    f.create('grandchild', 'other', null, 'child'); f.link('child', 'grandchild', 'other');
    f.create('fork', 'office', null, 'root');
    const before = f.db.prepare('SELECT * FROM cowork_sessions ORDER BY id').all();
    const preview = f.service.preview(task('child'));
    expect(preview).toMatchObject({ anonymousTaskCount: 1, subtaskCount: 2, agentWillAssociate: false });
    f.service.commit(f.input(preview));
    expect(f.remote.owner('root')).toEqual(a); expect(f.remote.owner('child')).toEqual(a); expect(f.remote.owner('grandchild')).toEqual(a);
    expect(f.remote.owner('fork')).toBeNull();
    expect(f.agents.get('office')?.ownerKind).toBe(AgentOwnerKind.Anonymous);
    expect(f.agents.get('other')?.ownerKind).toBe(AgentOwnerKind.Anonymous);
    expect(f.db.prepare('SELECT * FROM cowork_sessions ORDER BY id').all()).toEqual(before);
    expect(f.remote.ownershipRecord('child')?.source).toBe('manual_claim');
  });

  it('associates original Agent and anonymous tasks atomically, retaining existing owner, mapping, sequence and dates', () => {
    const f = fixture(); f.create('anonymous'); f.create('owned', 'office', a); f.create('fork', 'office', null, 'owned');
    const existing = { ownership: f.remote.ownershipRecord('owned'), sync: f.remote.sync('owned') };
    const preview = f.service.preview(agent());
    expect(preview).toMatchObject({ anonymousTaskCount: 2, existingOwnedTaskCount: 1 });
    const version = BigInt(f.agents.get('office')!.version);
    const { result } = f.commit(agent());
    expect(f.agents.get('office')).toMatchObject({ owner: a, ownerKind: AgentOwnerKind.Owned, version: String(version + 1n), createdAt: 1 });
    expect(f.remote.owner('anonymous')).toEqual(a); expect(f.remote.owner('fork')).toEqual(a);
    expect(f.remote.ownershipRecord('owned')).toEqual(existing.ownership);
    expect(f.remote.sync('owned')).toEqual(existing.sync);
    expect(result.sessionIds.sort()).toEqual(['anonymous', 'fork', 'owned']);
    expect(f.deps.afterCommit).toHaveBeenCalledTimes(1);
  });

  it('supports an empty anonymous Agent and protects the default Agent', () => {
    const f = fixture(); f.commit(agent());
    expect(f.agents.get('office')?.owner).toEqual(a);
    expect(f.service.getDetail(agent('main'))).toMatchObject({ ownership: { kind: AgentOwnerKind.Default }, canAssociate: false });
    expect(f.service.preview(agent('main'))).toMatchObject({ eligible: false, reason: OwnershipErrorCode.NotAssociable });
    f.create('main-task', 'main'); f.commit(task('main-task'));
    expect(f.agents.get('main')?.ownerKind).toBe(AgentOwnerKind.Default);
  });

  it.each([b, { ...a, scopeKey: 'enterprise:1' }])('rejects the complete Agent group with hidden ownership without revealing titles or counts', owner => {
    const f = fixture(); f.create('anonymous'); f.create('private-title', 'office', owner);
    const preview = f.service.preview(agent());
    expect(preview).toMatchObject({ eligible: false, reason: OwnershipErrorCode.NotAssociable,
      tasks: [], anonymousTaskCount: 0, existingOwnedTaskCount: 0 });
    expect(JSON.stringify(preview)).not.toContain('private-title');
    expect(f.remote.owner('anonymous')).toBeNull(); expect(f.agents.get('office')?.ownerKind).toBe(AgentOwnerKind.Anonymous);
  });

  it('never mistakes a quarantined null owner or orphan sync mapping for a claimable anonymous task', () => {
    const f = fixture(); f.create('quarantined', 'office', a);
    f.db.prepare("UPDATE cowork_sessions SET title='old unsupported writer' WHERE id='quarantined'").run();
    expect(f.remote.owner('quarantined')).toBeNull();
    expect(() => f.service.getDetail(task('quarantined'))).toThrow(OwnershipErrorCode.NotAvailable);
    expect(f.service.preview(agent())).toMatchObject({ eligible: false, reason: OwnershipErrorCode.NotAssociable });
    f.create('orphan', 'other'); f.db.prepare("INSERT INTO remote_sync(local_id,session_id) VALUES('orphan','original')").run();
    expect(f.service.preview(task('orphan'))).toMatchObject({ eligible: false, reason: OwnershipErrorCode.NotAssociable });
  });

  it('requires the external anonymous execution root first, while allowing an existing same-owner parent chain', () => {
    const f = fixture(); f.create('external', 'other'); f.create('child', 'office', null, 'external'); f.link('external', 'child');
    expect(f.service.preview(agent())).toMatchObject({ eligible: false, reason: OwnershipErrorCode.NotAssociable });
    f.remote.transaction(() => f.remote.associateHistorical('external', a, 500));
    expect(f.service.preview(agent()).eligible).toBe(true);
    f.commit(agent()); expect(f.remote.owner('external')).toEqual(a); expect(f.remote.ownershipRecord('external')?.created_at).toBe(500);
  });

  it.each(['cycle', 'missing', 'mismatch', 'multiple'])('rejects invalid real execution graphs: %s', problem => {
    const f = fixture(); f.create('parent'); f.create('child', 'office', null, problem === 'mismatch' ? 'different' : 'parent');
    f.link(problem === 'missing' ? 'gone' : 'parent', 'child');
    if (problem === 'cycle') f.link('child', 'parent');
    if (problem === 'multiple') { f.create('different'); f.link('different', 'child'); }
    expect(f.service.preview(task('child'))).toMatchObject({ eligible: false, reason: OwnershipErrorCode.NotAssociable });
  });

  it('associates after the real tracker records a forbidden spawn with a display-only agent label', () => {
    const f = fixture(); f.create('parent');
    expect(f.service.preview(agent()).eligible).toBe(true);
    const runs = new SubagentRunStore(f.db);
    const tracker = new SubagentTracker(runs, null, () => null);
    const args = { taskName: 'essay-writer-1', task: 'Write an essay' };
    tracker.onToolStart('call-forbidden', args, 'parent');
    tracker.onSpawnResult('call-forbidden', JSON.stringify({ status: 'forbidden', error: 'Explicit agentId is required.' }), args);
    expect(runs.getSubagentRun('call-forbidden')).toMatchObject({
      agentId: 'essay-writer-1', status: 'error', sessionKey: null, childCoworkSessionId: null,
    });
    expect(f.service.preview(agent())).toMatchObject({ eligible: true, anonymousTaskCount: 1 });
    f.commit(agent());
    expect(f.remote.owner('parent')).toEqual(a);
    expect(f.agents.get('office')?.owner).toEqual(a);
    expect(runs.getSubagentRun('call-forbidden')?.agentId).toBe('essay-writer-1');
  });

  it.each([agent(), task('parent')])('keeps a failed spawn without an execution identity from blocking association: %s', target => {
    const f = fixture(); f.create('parent');
    f.link('parent', null, 'essay-writer-1', 'error');
    const before = f.db.prepare('SELECT * FROM subagent_runs').all();
    expect(f.service.preview(target)).toMatchObject({ eligible: true, anonymousTaskCount: 1 });
    f.commit(target);
    expect(f.remote.owner('parent')).toEqual(a);
    expect(f.db.prepare('SELECT * FROM subagent_runs').all()).toEqual(before);
  });

  it.each([
    { status: 'error', sessionKey: 'agent:unknown:subagent:run', child: null },
    { status: 'error', sessionKey: null, child: 'child' },
    { status: 'error', sessionKey: '', child: null },
    { status: 'error', sessionKey: ' ', child: null },
    { status: 'running', sessionKey: null, child: null },
    { status: 'done', sessionKey: null, child: null },
  ])('keeps real, unresolved and malformed execution references protected: %s', ({ status, sessionKey, child }) => {
    const f = fixture(); f.create('parent');
    if (child) f.create(child, 'office', null, 'parent');
    f.link('parent', child, 'unavailable-agent', status, sessionKey);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(f.service.preview(agent())).toMatchObject({ eligible: false, reason: OwnershipErrorCode.NotAssociable, tasks: [] });
    expect(warn).toHaveBeenCalledWith('[Ownership] Association blocked', { reason: OwnershipAssociationBlockReason.ExecutionAgentUnavailable });
    expect(f.remote.owner('parent')).toBeNull();
    expect(f.agents.get('office')?.ownerKind).toBe(AgentOwnerKind.Anonymous);
  });

  it.each(['foreign', 'missing'])('still checks the %s parent of a spawn that never created an execution', parent => {
    const f = fixture(); f.create('current');
    if (parent === 'foreign') f.create(parent, 'other', b);
    f.link(parent, null, 'office', 'error');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(f.service.preview(agent())).toMatchObject({ eligible: false, reason: OwnershipErrorCode.NotAssociable, tasks: [] });
    expect(warn).toHaveBeenCalledWith('[Ownership] Association blocked', { reason: parent === 'foreign'
      ? OwnershipAssociationBlockReason.ForeignOwnership : OwnershipAssociationBlockReason.MissingTask });
    expect(f.remote.owner('current')).toBeNull();
  });

  it('invalidates an approved plan if a real session key arrives without any other relationship changing', () => {
    const f = fixture(); f.create('parent'); f.link('parent', null, 'office', 'error');
    const preview = f.service.preview(agent()); expect(preview.eligible).toBe(true);
    const input = f.input(preview);
    f.db.prepare("UPDATE subagent_runs SET session_key='agent:office:subagent:late'").run();
    expect(() => f.service.commit(input)).toThrow(OwnershipErrorCode.PlanChanged);
    expect(f.remote.owner('parent')).toBeNull();
    expect(f.service.getResult({ requestId: input.requestId })).toEqual({ status: OwnershipResultStatus.NotCommitted });
  });

  it.each([true, false])('logs a fixed private rejection reason with a trusted fixture update=%s', trusted => {
    const f = fixture(); f.create('secret-parent-id', 'office', b);
    const updateTitle = () => f.db.prepare("UPDATE cowork_sessions SET title='secret-title'").run();
    if (trusted) f.remote.transaction(updateTitle); else updateTitle();
    expect(f.remote.ownershipRecord('secret-parent-id')?.ownership_status).toBe(trusted ? 'confirmed' : 'quarantined');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const preview = f.service.preview(agent());
    expect(preview).toMatchObject({ eligible: false, reason: OwnershipErrorCode.NotAssociable, tasks: [], anonymousTaskCount: 0 });
    expect(warn.mock.calls).toEqual([['[Ownership] Association blocked', { reason: trusted
      ? OwnershipAssociationBlockReason.ForeignOwnership : OwnershipAssociationBlockReason.UnconfirmedOwnership }]]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-parent-id|secret-title|office|userId|sessionId|count/u);
  });

  it('preserves preview and commit rejection semantics when the diagnostic sink fails', () => {
    const f = fixture(); f.create('parent');
    const input = f.input(f.service.preview(agent()));
    f.remote.transaction(() => f.remote.associateHistorical('parent', b, 500));
    const before = f.remote.ownershipRecord('parent');
    vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('diagnostic sink unavailable'); });
    expect(f.service.preview(agent())).toMatchObject({ eligible: false, reason: OwnershipErrorCode.NotAssociable });
    expect(f.service.preview(agent('main'))).toMatchObject({ eligible: false, reason: OwnershipErrorCode.NotAssociable });
    expect(() => f.service.commit(input)).toThrow(OwnershipErrorCode.NotAssociable);
    expect(f.remote.ownershipRecord('parent')).toEqual(before);
    expect(f.agents.get('office')?.ownerKind).toBe(AgentOwnerKind.Anonymous);
    expect(f.service.getResult({ requestId: input.requestId })).toEqual({ status: OwnershipResultStatus.NotCommitted });
  });

  it.each(['run', 'local-approval', 'inbox', 'unmaterialized-child', 'reverse-allowlist'])('blocks unresolved execution work: %s', problem => {
    const f = fixture(); f.create('s');
    if (problem === 'run') f.remote.beginRun('s');
    if (problem === 'local-approval') f.remote.updateLocalApprovalBlocker('s', 'approval', null, true);
    if (problem === 'inbox') f.remote.put('inbox:command', { executionTarget: { agentId: 'office' }, state: 'prepared', command: { status: 'accepted' } });
    if (problem === 'unmaterialized-child') { f.create('external', 'other'); f.link('external', null, 'office', 'running'); }
    if (problem === 'reverse-allowlist') {
      f.db.prepare(`UPDATE agents SET subagent_allow_agent_ids='["office"]' WHERE id='other'`).run();
      f.create('external', 'other'); f.remote.beginRun('external');
    }
    expect(f.service.preview(agent())).toMatchObject({ eligible: false, reason: OwnershipErrorCode.ResourceBusy, tasks: [] });
  });

  it('rechecks ownership, range, generation, expiry and operation reservations at commit', () => {
    const f = fixture(); f.create('s'); const preview = f.service.preview(agent()); const request = f.input(preview);
    const release = f.gate.beginOperation({ agentIds: ['office'], sessionIds: [] })!;
    expect(() => f.service.commit(request)).toThrow(OwnershipErrorCode.ResourceBusy); release();
    f.create('later'); expect(() => f.service.commit(request)).toThrow(OwnershipErrorCode.PlanChanged);
    const second = f.input(f.service.preview(agent()));
    f.setActor(a, 'new-generation'); expect(() => f.service.commit(second)).toThrow(OwnershipErrorCode.AccountChanged);
    const third = f.input(f.service.preview(agent())); f.advance();
    expect(() => f.service.commit(third)).toThrow(OwnershipErrorCode.PlanExpired);
    expect(f.service.getResult({ requestId: third.requestId })).toEqual({ status: OwnershipResultStatus.NotCommitted });
  });

  it('rolls back Agent, task, sync mapping and successful receipt if the local commit fails', () => {
    const f = fixture(); f.create('s'); const originalAgent = f.agents.get('office');
    const input = f.input(f.service.preview(agent()));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(f.service.receipts, 'save').mockImplementation(() => { throw new Error('disk full'); });
    expect(() => f.service.commit(input)).toThrow(OwnershipErrorCode.LocalCommitFailed);
    expect(f.agents.get('office')).toEqual(originalAgent); expect(f.remote.owner('s')).toBeNull(); expect(f.remote.sync('s')).toBeNull();
    expect(f.service.getResult({ requestId: input.requestId })).toEqual({ status: OwnershipResultStatus.NotCommitted });
    expect(f.deps.afterCommit).not.toHaveBeenCalled(); expect(f.gate.isBusy({ agentIds: ['office'], sessionIds: ['s'] })).toBe(false);
  });

  it('recovers the original successful receipt without an in-memory plan and rejects reuse with a different request', () => {
    const f = fixture(); f.create('s'); const { result, request } = f.commit(agent());
    const restarted = new OwnershipAssociationService(f.deps);
    expect(restarted.commit(request)).toEqual(result);
    expect(restarted.getResult({ requestId: request.requestId })).toEqual(result);
    expect(() => restarted.commit({ ...request, planId: 'different' })).toThrow(OwnershipErrorCode.RequestConflict);
    expect(f.deps.afterCommit).toHaveBeenCalledTimes(1);
    f.setActor(b);
    expect(restarted.getResult({ requestId: request.requestId })).toEqual({ status: OwnershipResultStatus.NotCommitted });
  });

  it('persists whole-group remote admission per account, environment and device, including existing owned task summaries', () => {
    const f = fixture(); f.create('new'); f.create('existing', 'office', a); f.commit(agent());
    const receiptStore = new OwnershipAssociationStore(f.remote);
    const context = { owner: a, environment: 'https://test.example', deviceId: 'desktop-1' };
    let blocked = receiptStore.prepareRemoteAdmission(context, false);
    expect([...blocked.blockedAgentIds]).toEqual(['office']); expect([...blocked.blockedSessionIds].sort()).toEqual(['existing', 'new']);
    blocked = receiptStore.prepareRemoteAdmission(context, true);
    expect(blocked.blockedAgentIds.size).toBe(0);
    expect(new OwnershipAssociationStore(f.remote).prepareRemoteAdmission(context, false).blockedSessionIds.size).toBe(0);
    expect(receiptStore.prepareRemoteAdmission({ ...context, deviceId: 'desktop-2' }, false).blockedAgentIds.has('office')).toBe(true);
    expect(receiptStore.prepareRemoteAdmission({ ...context, environment: 'https://prod.example' }, false).blockedAgentIds.has('office')).toBe(true);
    expect(receiptStore.prepareRemoteAdmission({ ...context, owner: b }, false).blockedAgentIds.size).toBe(0);
  });

  it('preserves partial content in grouped results while failures and pending work retain priority', () => {
    const f = fixture(); f.create('partial'); f.create('other');
    const { request } = f.commit(agent());
    let other: OwnershipSyncState = OwnershipSyncState.Synced;
    const service = new OwnershipAssociationService({ ...f.deps,
      syncState: target => target.id === 'partial' ? OwnershipSyncState.Partial : other });
    expect(service.getResult({ requestId: request.requestId })).toMatchObject({ syncState: OwnershipSyncState.Partial });
    for (const state of [OwnershipSyncState.Pending, OwnershipSyncState.Failed, OwnershipSyncState.WaitingService]) {
      other = state;
      expect(service.getResult({ requestId: request.requestId })).toMatchObject({ syncState: state });
    }
  });
  it('does not gate a task-only association on Agent promotion capability or invent unsampled content status', () => {
    const f = fixture(); f.create('s'); f.commit(task('s'));
    expect(f.service.receipts.prepareRemoteAdmission({ owner: a, environment: 'test', deviceId: 'desktop' }, false).blockedSessionIds.size).toBe(0);
    f.remote.put('syncFailure:s', { code: 'offline' });
    expect(f.service.getDetail(task('s'))).toMatchObject({ syncState: OwnershipSyncState.Pending,
      contentSync: { state: 'unknown', reason: 'unavailable', retryable: false } });
  });
});


describe('ownership task content detail delegation', () => {
  it('uses one task snapshot after visibility checks and never invokes the old task sync reader', () => {
    const f = fixture(); f.create('mine', 'office', a); f.create('foreign', 'office', b); f.create('anonymous');
    const syncState = vi.fn(() => { throw new Error('heavy legacy reader must not run'); });
    const taskSync = vi.fn(() => ({ syncState: OwnershipSyncState.Pending, contentSync: { state: 'unknown' as const, retryable: false } }));
    const service = new OwnershipAssociationService({ ...f.deps, syncState, taskSync });
    expect(service.getDetail(task('mine')).contentSync).toEqual({ state: 'unknown', retryable: false });
    expect(taskSync).toHaveBeenCalledOnce(); expect(syncState).not.toHaveBeenCalled();
    expect(() => service.getDetail(task('foreign'))).toThrow(OwnershipErrorCode.NotAvailable);
    expect(taskSync).toHaveBeenCalledOnce();
    expect(service.getDetail(task('anonymous')).contentSync).toEqual({ state: 'local', retryable: false });
    expect(taskSync).toHaveBeenCalledOnce();
  });
  it('keeps a readable task available when optional display sampling fails', () => {
    const f = fixture(); f.create('mine', 'office', a);
    const service = new OwnershipAssociationService({ ...f.deps, taskSync: () => { throw new Error('unavailable'); } });
    expect(service.getDetail(task('mine'))).toMatchObject({ syncState: OwnershipSyncState.Pending,
      contentSync: { state: 'unknown', reason: 'unavailable', retryable: false } });
  });
});


const destination = (): PublicationTarget => ({ owner: a, route: 'https://current.example/api', targetId: 'target',
  dataSpaceId: 'space', deviceId: 'desktop', epoch: 1, routeEpoch: 2, accountGeneration: 3 });
const confirmation = (id: string) => ({ ...task(id), action: OwnershipAction.ConfirmPublication });
const origin = (f: ReturnType<typeof fixture>, id: string) => f.db.prepare(
  "SELECT * FROM remote_publication_origins WHERE kind='session' AND local_id=?").get(id);
function oldAssociation() {
  const f = fixture(); f.create('old'); const original = f.commit(task('old'));
  f.setPublicationTarget(destination());
  return { ...f, original };
}

describe('explicit publication destination confirmation', () => {
  it.each(['office', 'main'])('captures a new historical claim without changing the %s Agent or another task', agentId => {
    const f = fixture(); f.create('new-claim', agentId); f.create('unrelated', agentId);
    f.remote.publicationOrigins.setRouteProvider(() => 'https://current.example/api');
    f.remote.publicationOrigins.setCurrentTargetProvider(() => ({ owner: a, route: 'https://current.example/api', dataSpaceId: 'space' }));
    const other = f.remote.sync('unrelated'), agentOwner = f.agents.get(agentId);
    f.commit(task('new-claim'));
    expect(origin(f, 'new-claim')).toMatchObject({ route: 'https://current.example/api', data_space_id: 'space', owner_user_id: a.userId });
    expect(f.agents.get(agentId)).toEqual(agentOwner); expect(f.remote.sync('unrelated')).toEqual(other);
    expect(f.remote.owner('unrelated')).toBeNull(); expect(f.deps.confirmPublication).not.toHaveBeenCalled();
  });

  it('keeps offline claims on the chosen route and never overwrites an existing source', () => {
    const f = fixture(); f.create('offline'); f.create('known');
    f.remote.publicationOrigins.setRouteProvider(() => 'https://original.example');
    f.remote.publicationOrigins.capture(RemotePublicationKind.Session, 'known', null);
    f.remote.publicationOrigins.setRouteProvider(() => 'https://offline.example');
    f.commit(task('offline')); f.commit(task('known'));
    expect(origin(f, 'offline')).toMatchObject({ route: 'https://offline.example', data_space_id: null });
    expect(origin(f, 'known')).toMatchObject({ route: 'https://original.example', data_space_id: null });
    f.remote.publicationOrigins.confirm(a, 'https://offline.example', { version: 1, dataSpaceId: 'offline-space', dataGeneration: '1' });
    expect(origin(f, 'offline')).toMatchObject({ route: 'https://offline.example', data_space_id: 'offline-space' });
  });

  it.each(['route', 'space'])('invalidates new association after preview source %s changes', change => {
    const f = fixture(); f.create('old'); let route = 'https://original.example', space = 'space-a';
    f.remote.publicationOrigins.setRouteProvider(() => route);
    f.remote.publicationOrigins.setCurrentTargetProvider(() => ({ owner: a, route, dataSpaceId: space }));
    const preview = f.service.preview(task('old'));
    if (change === 'route') route = 'https://changed.example'; else space = 'space-b';
    expect(() => f.service.commit(f.input(preview))).toThrow(OwnershipErrorCode.PlanChanged);
    expect(f.remote.owner('old')).toBeNull(); expect(origin(f, 'old')).toBeUndefined();
  });

  it('requires a new confirmation and never treats replaying the original association receipt as destination permission', () => {
    const f = oldAssociation();
    f.remote.publicationOrigins.setRouteProvider(() => destination().route);
    f.remote.publicationOrigins.setCurrentTargetProvider(() => destination());
    expect(f.service.commit(f.original.request)).toEqual(f.original.result);
    expect(origin(f, 'old')).toMatchObject({ route: null, data_space_id: null });
    expect(f.service.getDetail(task('old'))).toMatchObject({ canAssociate: false, canConfirmPublication: true });
    const preview = f.service.preview(confirmation('old'));
    expect(preview).toMatchObject({ eligible: true, action: OwnershipAction.ConfirmPublication,
      publicationTarget: { route: destination().route }, agentWillAssociate: false, tasks: [{ id: 'old' }] });
    expect(preview.publicationTarget).toEqual({ route: destination().route });
    const mapping = f.remote.sync('old'), owner = f.remote.ownershipRecord('old'), agentOwner = f.agents.get('office');
    const request = f.input(preview), result = f.service.commit(request);
    expect(result.action).toBe(OwnershipAction.ConfirmPublication);
    expect(f.remote.sync('old')).toEqual(mapping); expect(f.remote.ownershipRecord('old')).toEqual(owner); expect(f.agents.get('office')).toEqual(agentOwner);
    expect(origin(f, 'old')).toMatchObject({ route: destination().route, data_space_id: destination().dataSpaceId });
    expect(f.deps.confirmPublication).toHaveBeenCalledExactlyOnceWith(['old'], destination());
    expect(f.service.commit(request)).toEqual(result);
    const restarted = new OwnershipAssociationService(f.deps);
    expect(restarted.getResult({ requestId: request.requestId })).toEqual(result);
    expect(restarted.getDetail(task('old')).canConfirmPublication).toBe(false);
  });

  it('confirms only the original real execution closure, leaving ordinary forks and other Agent tasks unchanged', () => {
    const f = fixture(); f.create('root'); f.create('child', 'other', null, 'root'); f.link('root', 'child', 'other');
    f.create('fork', 'office', null, 'root'); f.create('other-task');
    f.commit(task('child')); f.setPublicationTarget(destination());
    const agents = f.db.prepare('SELECT * FROM agent_ownership ORDER BY agent_id').all();
    const preview = f.service.preview(confirmation('child')); expect(preview.eligible).toBe(true);
    expect(preview.tasks.map(t => t.id)).toEqual(['child', 'root']);
    const result = f.service.commit(f.input(preview));
    expect(result.sessionIds.sort()).toEqual(['child', 'root']);
    expect(origin(f, 'root')).toMatchObject({ data_space_id: 'space' }); expect(origin(f, 'child')).toMatchObject({ data_space_id: 'space' });
    expect(f.remote.owner('fork')).toBeNull(); expect(f.remote.owner('other-task')).toBeNull();
    expect(f.db.prepare('SELECT * FROM agent_ownership ORDER BY agent_id').all()).toEqual(agents);
  });

  it('does not silently include a newly joined execution child outside the original association receipt', () => {
    const f = oldAssociation(); f.create('later', 'office', a, 'old'); f.link('old', 'later');
    expect(f.service.getDetail(task('old')).canConfirmPublication).toBe(false);
    expect(f.service.preview(confirmation('old')).eligible).toBe(false);
    expect(origin(f, 'old')).toMatchObject({ route: null, data_space_id: null });
  });

  it.each(['route', 'dataSpaceId', 'targetId', 'deviceId', 'epoch', 'routeEpoch', 'accountGeneration'] as const)(
    'rejects a confirmation plan after trusted target %s changes', field => {
      const f = oldAssociation(), preview = f.service.preview(confirmation('old'));
      const target = destination();
      if (typeof target[field] === 'number') (target as unknown as Record<string, unknown>)[field] = (target[field] as number) + 1;
      else (target as unknown as Record<string, unknown>)[field] = `${target[field]}-changed`;
      f.setPublicationTarget(target);
      expect(() => f.service.commit(f.input(preview))).toThrow(OwnershipErrorCode.PlanChanged);
      expect(origin(f, 'old')).toMatchObject({ route: null, data_space_id: null });
    });

  it('rejects account changes, offline destinations, missing receipts, and non-manual owned tasks', () => {
    const f = oldAssociation(), preview = f.service.preview(confirmation('old'));
    f.setActor(a, 'changed'); expect(() => f.service.commit(f.input(preview))).toThrow(OwnershipErrorCode.AccountChanged);
    f.setPublicationTarget(null); expect(f.service.getDetail(task('old')).canConfirmPublication).toBe(false);
    f.setPublicationTarget(destination());
    f.db.prepare('DELETE FROM ownership_association_operations').run();
    expect(f.service.getDetail(task('old')).canConfirmPublication).toBe(false);
    f.create('ordinary-owned', 'office', a);
    expect(f.service.getDetail(task('ordinary-owned')).canConfirmPublication).toBe(false);
    expect(f.service.preview({ ...agent(), action: OwnershipAction.ConfirmPublication }).eligible).toBe(false);
  });

  it('checks the operation gate and rolls back source, receipt and revisions if bridge confirmation fails', () => {
    const f = oldAssociation();
    const busy = f.gate.tryAcquire({ agentIds: ['office'], sessionIds: ['old'] });
    expect(f.service.preview(confirmation('old'))).toMatchObject({ eligible: false, reason: OwnershipErrorCode.ResourceBusy }); busy!();
    const preview = f.service.preview(confirmation('old')), request = f.input(preview);
    const before = { source: origin(f, 'old'), sync: f.remote.sync('old'), revisions: f.remote.projectionRevision('old') };
    f.deps.confirmPublication.mockImplementation(() => {
      expect(f.db.inTransaction).toBe(true);
      expect(f.service.receipts.find(a, request.requestId)).not.toBeNull();
      expect(origin(f, 'old')).toMatchObject({ data_space_id: 'space' });
      throw new Error('Trusted target became unavailable');
    });
    expect(() => f.service.commit(request)).toThrow(OwnershipErrorCode.LocalCommitFailed);
    expect({ source: origin(f, 'old'), sync: f.remote.sync('old'), revisions: f.remote.projectionRevision('old') }).toEqual(before);
    expect(f.service.getResult({ requestId: request.requestId })).toEqual({ status: OwnershipResultStatus.NotCommitted });
    f.deps.confirmPublication.mockReset(); expect(f.service.commit(request).action).toBe(OwnershipAction.ConfirmPublication);
  });

  it.each([
    ["UPDATE remote_sync SET device_id='published' WHERE local_id='old'"],
    ["UPDATE remote_sync SET sync_environment='other-target' WHERE local_id='old'"],
    ["UPDATE remote_sync SET ack_seq=1 WHERE local_id='old'"],
    ["UPDATE remote_sync SET server_seq='1' WHERE local_id='old'"],
    ["UPDATE remote_sync SET sync_protocol_version=2 WHERE local_id='old'"],
    ["UPDATE remote_sync SET stream_epoch='original-epoch' WHERE local_id='old'"],
    ["UPDATE remote_sync SET source_purge_seq='1' WHERE local_id='old'"],
    ["UPDATE remote_sync SET event_purge_seq='1' WHERE local_id='old'"],
    ["UPDATE remote_sync SET migration_frozen=1 WHERE local_id='old'"],
    ["INSERT INTO remote_state VALUES('import:old','{}')"],
    ["INSERT INTO remote_state VALUES('deletionFence:old','{}')"],
    ["INSERT INTO remote_state VALUES('inputFence:old','{}')"],
    ["INSERT INTO remote_history_migrations VALUES('scope','old','writer','migration','{}','hash','active')"],
    ["INSERT INTO remote_state VALUES('localGcDeleted:old','{}')"],
    ["INSERT INTO remote_state VALUES('deletionClosed:old','{}')"],
    ["INSERT INTO remote_state VALUES('sessionDeletion:old','{}')"],
    ["INSERT INTO remote_state VALUES('runCommand:old','\"remote-command\"')"],
    ["INSERT INTO remote_run_isolation VALUES('old','run','hash','unknown')"],
    ["UPDATE remote_publication_origins SET route='https://known.example' WHERE local_id='old'"],
    ["UPDATE remote_publication_origins SET data_space_id='known-space' WHERE local_id='old'"],
  ])('never confirms a source when historical remote authority or another source exists: %s', statement => {
    const f = oldAssociation(); f.db.exec(statement);
    expect(f.service.getDetail(task('old')).canConfirmPublication).toBe(false);
    expect(f.service.preview(confirmation('old')).eligible).toBe(false);
    expect(f.deps.confirmPublication).not.toHaveBeenCalled();
  });

  it.each(['remote_sync_target_archives', 'remote_sync_admission_evidence'])('rejects original or damaged mapping evidence in %s', table => {
    const f = oldAssociation();
    f.db.exec(`CREATE TABLE ${table}(row_key TEXT,table_name TEXT,row_json TEXT)`);
    f.db.prepare(`INSERT INTO ${table} VALUES(?,?,?)`).run('old', 'remote_sync', JSON.stringify({ local_id: 'old', session_id: 'remote-original' }));
    expect(f.service.preview(confirmation('old')).eligible).toBe(false);
    f.db.prepare(`UPDATE ${table} SET row_key='unknown',row_json='{}'`).run();
    expect(f.service.preview(confirmation('old')).eligible).toBe(false);
    f.db.prepare(`UPDATE ${table} SET row_json=?`).run(JSON.stringify({ local_id: '', session_id: '' }));
    expect(f.service.preview(confirmation('old')).eligible).toBe(false);
  });

  it('preserves unknown source for a future claim with a residual original archive', () => {
    const f = fixture(); f.create('old');
    f.db.exec("CREATE TABLE remote_sync_target_archives(row_key TEXT,table_name TEXT,row_json TEXT)");
    f.db.prepare('INSERT INTO remote_sync_target_archives VALUES(?,?,?)').run('old', 'remote_sync', JSON.stringify({ local_id: 'old', session_id: 'remote-original' }));
    f.remote.publicationOrigins.setRouteProvider(() => destination().route);
    f.remote.publicationOrigins.setCurrentTargetProvider(() => destination());
    f.commit(task('old'));
    expect(origin(f, 'old')).toMatchObject({ route: null, data_space_id: null });
  });
});


describe('publication source control and archived authority', () => {
  it.each(['takeover', 'input', 'empty-input', 'bad-takeover', 'bad-input'])('does not confirm with unresolved %s evidence', kind => {
    const f = oldAssociation();
    const key = kind.includes('takeover') ? `${LEGACY_IMPORT_TAKEOVER_ARCHIVE_PREFIX}operation` : 'inputPreparation:operation';
    const value = kind === 'takeover' ? JSON.stringify({ localId: 'old', importId: 'original' })
      : kind === 'input' ? JSON.stringify({ sessionId: 'old' }) : kind === 'empty-input' ? JSON.stringify({ sessionId: '' }) : '{broken';
    f.db.prepare('INSERT INTO remote_state VALUES(?,?)').run(key, value);
    expect(f.service.getDetail(task('old')).canConfirmPublication).toBe(false);
  });

  it('allows unrelated well-attributed controls and ordinary local deletion version guards', () => {
    const f = oldAssociation();
    f.db.prepare('INSERT INTO remote_state VALUES(?,?)').run(`${LEGACY_IMPORT_TAKEOVER_ARCHIVE_PREFIX}unrelated`, JSON.stringify({ localId: 'unrelated' }));
    f.db.prepare('INSERT INTO remote_state VALUES(?,?)').run('inputPreparation:new-task', JSON.stringify({ sessionId: null }));
    f.db.prepare('INSERT INTO remote_state VALUES(?,?)').run('deletionGuard:old', JSON.stringify({ version: '2', runId: null }));
    expect(f.service.preview(confirmation('old')).eligible).toBe(true);
  });

  it.each(['remote_sync_target_archives', 'remote_sync_admission_evidence'])('retains nested immutable takeover authority in %s', table => {
    const f = oldAssociation();
    f.db.exec(`CREATE TABLE ${table}(row_key TEXT,table_name TEXT,row_json TEXT)`);
    const key = `${LEGACY_IMPORT_TAKEOVER_ARCHIVE_PREFIX}original-import`;
    const body = JSON.stringify({ key, value: JSON.stringify({ localId: 'old', savedImport: { importId: 'original-import' } }) });
    f.db.prepare(`INSERT INTO ${table} VALUES(?,?,?)`).run(key, 'remote_state', body);
    expect(f.service.preview(confirmation('old')).eligible).toBe(false);
  });
});


describe('publication confirmation during received deletion', () => {
  it.each(['local', 'remote', 'malformed'])('rejects %s deletion claim before the task fence is written', kind => {
    const f = oldAssociation();
    const value = kind === 'malformed' ? '{}' : JSON.stringify({ phase: 'received', target: {
      localSessionId: kind === 'local' ? 'old' : 'other',
      sessionId: kind === 'remote' ? f.remote.sync('old')!.session_id : 'unrelated-remote',
    } });
    f.db.prepare('INSERT INTO remote_state VALUES(?,?)').run('sessionDeletion:operation:1:claim', value);
    expect(f.service.preview(confirmation('old')).eligible).toBe(false);
  });

  it('does not confuse an unrelated fully attributed deletion claim with this task', () => {
    const f = oldAssociation();
    f.db.prepare('INSERT INTO remote_state VALUES(?,?)').run('sessionDeletion:operation:1:claim', JSON.stringify({
      phase: 'received', target: { localSessionId: 'unrelated', sessionId: 'unrelated-remote' },
    }));
    expect(f.service.preview(confirmation('old')).eligible).toBe(true);
  });
});
