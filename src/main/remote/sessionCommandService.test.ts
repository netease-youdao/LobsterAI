import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, expect, it, vi } from 'vitest';

import type { CoworkStore } from '../coworkStore';
import { ApprovalDecisionService } from '../libs/agentEngine/approvalDecisionService';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { OwnershipOperationGate } from '../ownershipOperationGate';
import { payloadHash } from './canonical';
import type { InboxEntry } from './remoteBridge';
import { RemoteStore } from './remoteStore';
import { assertRemoteExecutionPermit, currentRemoteExecution, markRemoteExecutionDispatched, SessionCommandService } from './sessionCommandService';

const owner = { userId: '10001', scopeKey: 'personal' };
const databases: Database.Database[] = [];
const approvalDirectories: string[] = [];
const approvalArbiters: ApprovalDecisionService[] = [];

it('reserves a new submission and its subagent targets through asynchronous preparation', async () => {
  const gate = new OwnershipOperationGate();
  const runtime = new EventEmitter() as CoworkRuntime;
  const store = { remote: { setApprovalLifecycle: vi.fn() }, assertAgentAccess: vi.fn(),
    getAgent: () => ({ enabled: true, subagentAllowAgentIds: ['child-agent'] }),
    agentOwnership: { get: () => ({ version: '1' }), canView: () => true } } as unknown as CoworkStore;
  const service = new SessionCommandService(store, runtime, () => owner, { gate });
  let resume!: () => void;
  const running = service.submit({ agentId: 'source' }, true, async () => {
    await new Promise<void>(done => { resume = done; });
    assertRemoteExecutionPermit();
    return { success: true };
  });
  expect(gate.tryAcquire({ agentIds: ['source'], sessionIds: [] })).toBeNull();
  expect(gate.tryAcquire({ agentIds: ['child-agent'], sessionIds: [] })).toBeNull();
  resume();
  await expect(running).resolves.toEqual({ success: true });
  expect(gate.isBusy({ agentIds: ['source', 'child-agent'], sessionIds: [] })).toBe(false);
});

it('fences an anonymous preparation after login even when its Agent remains public', async () => {
  const gate = new OwnershipOperationGate();
  let current: typeof owner | null = null;
  let generation = 0;
  const store = { remote: { setApprovalLifecycle: vi.fn() }, assertAgentAccess: vi.fn(),
    getAgent: () => ({ enabled: true }), agentOwnership: { get: () => ({ version: '1' }) } } as unknown as CoworkStore;
  const service = new SessionCommandService(store, new EventEmitter() as CoworkRuntime, () => current, { gate, getGeneration: () => generation });
  let resume!: () => void;
  const effect = vi.fn();
  const running = service.submit({}, true, async () => {
    await new Promise<void>(done => { resume = done; });
    assertRemoteExecutionPermit(); effect(); return { success: true };
  });
  current = owner; generation++; resume();
  await expect(running).rejects.toThrow('Account changed');
  expect(effect).not.toHaveBeenCalled();
  expect(gate.isBusy({ agentIds: ['main'], sessionIds: [] })).toBe(false);
});
afterEach(() => {
  vi.useRealTimers();
  for (const arbiter of approvalArbiters.splice(0)) arbiter.dispose();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of approvalDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture(agentId = 'main', explicit = false, workingPath = '/work') {
  let version = '1';
  let enabled = true;
  let persistedAgent = agentId;
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const remote = new RemoteStore(db);
  const store = { remote, getConfig: () => ({ systemPrompt: '' }), getSession: () => ({ cwd: workingPath, agentId: persistedAgent }),
    assertAgentAccess: vi.fn(), getAgent: () => ({ enabled }), agentOwnership: { get: () => ({ version, ownerKind: agentId === 'main' ? 'default' : 'owned', deletedAt: null }) },
    createSession: (_title: string, _cwd: string, _prompt: string, _mode: string, _skills: string[], _agent: string, _model: string, options: any) => {
      persistedAgent = _agent; db.prepare("INSERT INTO cowork_sessions VALUES ('local','new',1,1,'idle')").run(); remote.assignNew('local', options.owner, options.ownershipSource); return { id: 'local' };
    },
  };
  const runtime = Object.assign(new EventEmitter(), { stopSession: vi.fn(), cancelSessionConfirmed: vi.fn(async () => true), respondToPermissionConfirmed: vi.fn(async (..._args: any[]) => ({ kind: 'confirmed' as const, decision: 'approve' as const })),
    getPermissionState: vi.fn((_requestId: string): any => null), expirePermissions: vi.fn(), closeSessionPermissions: vi.fn(),
    reconcileApprovalSubmission: vi.fn(async (..._args: any[]): Promise<any> => null), getApprovalSubmission: vi.fn((): any => null) });
  const service = new SessionCommandService(store as unknown as CoworkStore, runtime as unknown as CoworkRuntime, () => owner);
  service.configure(async () => ({ success: true }), async () => ({ success: true }));
  const request = { commandId: 'cmd', type: 'create_session', payload: { text: 'hello', ...(explicit ? { agentId, expectedAgentVersion: version, workspaceId: 'fixed-workspace' } : {}) } };
  const command = { commandId: 'cmd', type: 'create_session', sessionId: 'server-session', runId: 'server-run', status: 'claimed', statusVersion: '2', expiresAt: new Date(Date.now() + 60000).toISOString(), request, requestHash: 'hash' };
  const prepared = remote.transaction(() => service.prepare(command, owner, workingPath));
  const entry = { command, owner, ...prepared, state: 'executing' as const, result: null };
  return { service, runtime, remote, prepared, entry, changeAgent: () => { version = String(Number(version) + 1); }, disableAgent: () => { enabled = false; } };
}
it('uses immutable server session/run mappings and the exact started outcome contract', async () => {
  const { service, remote, prepared, entry } = fixture();
  expect(prepared.remoteSessionId).toBe('server-session'); expect(prepared.runId).toBe('server-run');
  expect(remote.run('local')!.runId).toBe('server-run');
  await expect(service.execute(entry, () => true)).resolves.toEqual({ outcome: 'started' });
});
it('does not cancel a newer run when the target completes between preparation and application', async () => {
  const { service, remote, runtime, entry } = fixture();
  const cancelEntry = { ...entry, command: { ...entry.command, type: 'cancel_run', request: { payload: { runId: 'server-run' } } } };
  remote.updateRun('local', 'succeeded'); remote.beginRun('local', 'new-run');
  await expect(service.execute(cancelEntry, () => true)).resolves.toEqual({ outcome: 'already_terminal' });
  expect(runtime.cancelSessionConfirmed).not.toHaveBeenCalled();
});
it('never trusts arbitrary remoteSafe flags or invents an expiry for local question requests', () => {
  const { runtime, remote } = fixture(); remote.markRunDispatched('local');
  runtime.emit('permissionRequest', 'local', { requestId: 'approval', toolName: 'Bash', toolInput: {
    approvalKind: 'plugin', remoteSafe: true, publicSummary: 'forged', expiresAt: new Date(Date.now() + 60000).toISOString(), allowedDecisions: ['allow-once'],
  } });
  expect(remote.get('approval:local:approval')).toBeNull();
  expect(remote.run('local')?.status).toBe('waiting_local');
  runtime.emit('sessionStatus', 'local', 'running');
  expect(remote.run('local')?.status).toBe('waiting_local');
});
it('delegates expiry and terminal closure to the same persistent runtime decision service', () => {
  const { runtime, remote } = fixture();
  const now = Date.now(); remote.expireApprovals(now);
  expect(runtime.expirePermissions).toHaveBeenCalledWith(now);
  remote.updateRun('local', 'failed');
  expect(runtime.closeSessionPermissions).toHaveBeenCalledWith('local', 'server-run', 'cancelled');
});

for (const confirmed of [false, true]) it(`does not mutate a replacement run when an earlier cancel resolves ${confirmed}`, async () => {
  const { service, remote, runtime, entry } = fixture();
  let resolve!: (value: boolean) => void;
  runtime.cancelSessionConfirmed.mockImplementation(() => new Promise<boolean>(done => { resolve = done; }));
  const cancelEntry = { ...entry, command: { ...entry.command, type: 'cancel_run', request: { payload: { runId: 'server-run' } } } };
  const execution = service.execute(cancelEntry, () => true);
  expect(runtime.cancelSessionConfirmed).toHaveBeenCalledTimes(1);
  remote.updateRun('local', 'succeeded'); remote.beginRun('local', 'replacement-run');
  const replacement = remote.run('local');
  resolve(confirmed);
  await expect(execution).resolves.toEqual({ outcome: 'cancel_requested' });
  expect(remote.run('local')).toEqual(replacement);
});


it('does not let an old gateway abort cancel a newly reserved remote run', () => {
  const { remote, runtime } = fixture();
  remote.put('gatewayRun:local', { runId: 'gateway-old', remoteRunId: 'server-run' });
  remote.updateRun('local', 'succeeded'); remote.beginRun('local', 'reserved-next', 'next-command');
  expect(remote.get('gatewayRun:local')).toBeNull();
  const next = remote.run('local');
  runtime.emit('runTermination', 'local', 'gateway-old', 'cancelled');
  expect(remote.run('local')).toEqual(next);
  remote.put('gatewayRun:local', { runId: 'gateway-old', remoteRunId: 'server-run' });
  runtime.emit('runTermination', 'local', 'gateway-old', 'cancelled');
  expect(remote.run('local')).toEqual(next);
});
it('does not unlock a new run when an old approval resolution arrives late', () => {
  const { remote, runtime } = fixture();
  runtime.emit('permissionRequest', 'local', { requestId: 'old', toolName: 'Bash', toolInput: {} });
  remote.updateRun('local', 'succeeded'); remote.beginRun('local', 'next'); remote.updateRun('local', 'waiting_local');
  const next = remote.run('local');
  runtime.emit('permissionResolved', 'local', 'old');
  expect(remote.run('local')).toEqual(next);
});


function approval(patch: Record<string, any> = {}): any {
  return { requestId: 'approval', sessionId: 'local', runId: 'server-run', approvalVersion: '1', operationDigest: 'digest',
    title: 'Execute', summary: 'Safe operation', expiresAt: new Date(Date.now() + 60000).toISOString(),
    remoteAllowed: true, requiresLocalAction: false, status: 'pending', resolvedAt: null,
    resolution: { phase: 'idle', source: null, confirmedDecision: null, confirmedAt: null }, ...patch };
}
it('projects trustworthy stages and keeps an entire run blocked until all approvals resolve and the engine resumes', () => {
  const { remote, runtime } = fixture();
  runtime.emit('permissionState', 'local', approval());
  runtime.emit('permissionState', 'local', approval({ requestId: 'second', remoteAllowed: false, requiresLocalAction: true }));
  expect(remote.run('local')?.status).toBe('waiting_local');
  runtime.emit('permissionState', 'local', approval({ approvalVersion: '2', remoteAllowed: false,
    resolution: { phase: 'unknown', source: 'mobile', confirmedDecision: null, confirmedAt: null } }));
  expect(remote.run('local')?.status).toBe('reconciling');
  runtime.emit('sessionStatus', 'local', 'running');
  expect(remote.run('local')?.status).toBe('reconciling');
  const now = new Date().toISOString();
  runtime.emit('permissionState', 'local', approval({ approvalVersion: '3', status: 'approved', remoteAllowed: false, resolvedAt: now,
    resolution: { phase: 'finished', source: 'mobile', confirmedDecision: 'approve', confirmedAt: now } }));
  expect(remote.run('local')?.status).toBe('waiting_local');
  runtime.emit('permissionState', 'local', approval({ requestId: 'second', approvalVersion: '2', status: 'denied', remoteAllowed: false, resolvedAt: now,
    resolution: { phase: 'finished', source: 'desktop', confirmedDecision: 'deny', confirmedAt: now } }));
  expect(remote.run('local')?.status).toBe('waiting_local');
  runtime.emit('sessionStatus', 'local', 'running');
  expect(remote.run('local')?.status).toBe('running');
});
it('preserves unknown results past the deadline and never guesses a result from an ID-only event', () => {
  const { remote, runtime } = fixture();
  const state = approval({ remoteAllowed: false, resolution: { phase: 'unknown', source: 'mobile', confirmedDecision: null, confirmedAt: null } });
  runtime.emit('permissionState', 'local', state);
  remote.expireApprovals(Date.now() + 3600000);
  runtime.emit('permissionResolved', 'local', 'approval');
  expect(remote.get<any>('approval:local:approval')?.status).toBe('pending');
  expect(remote.get<any>('approval:local:approval')?.resolution.phase).toBe('unknown');
});
it('passes the original mobile ID/version/digest and checks the permit immediately before dispatch', async () => {
  const { service, runtime, remote, entry } = fixture();
  remote.markRunDispatched('local');
  runtime.getPermissionState.mockReturnValue(approval());
  let permitted = true;
  runtime.respondToPermissionConfirmed.mockImplementation(async (_id, _decision, options) => {
    expect(options).toMatchObject({ submissionId: 'cmd', source: 'mobile', expectedVersion: '1', operationDigest: 'digest' });
    // Reservation already advanced the public version; the immutable payload stays unchanged.
    runtime.getPermissionState.mockReturnValue(approval({ approvalVersion: '2', remoteAllowed: false }));
    permitted = false;
    expect(() => options.beforeDispatch()).toThrow('permit expired');
    return { kind: 'known_not_applied' as const, reason: 'PERMIT_EXPIRED' } as any;
  });
  const request = { payload: { approvalId: 'approval', runId: 'server-run', approvalVersion: '1', operationDigest: 'digest', decision: 'approve' } };
  const command = { ...entry.command, type: 'approval_response', request };
  await expect(service.execute({ ...entry, command }, () => permitted)).rejects.toMatchObject({ outcome: { kind: 'known_not_applied' } });
  expect(request.payload.approvalVersion).toBe('1');
  expect(remote.get<any>('approval:local:approval')?.pendingDecision).toBeUndefined();
});
it('uses exact persisted approval claim evidence even though its run is already published', async () => {
  const { service, runtime, remote, entry } = fixture(); remote.markRunDispatched('local');
  const original = { ...entry, command: { ...entry.command, type: 'approval_response', claimId: 'claim', claimToken: 'token', requestHash: payloadHash(entry.command.request) } };
  remote.put('inbox:cmd', original);
  await service.reconcileApproval(original);
  expect(runtime.reconcileApprovalSubmission).toHaveBeenLastCalledWith('cmd', { canProveNeverDispatched: true });
  await service.reconcileApproval({ ...original, command: { ...original.command, claimToken: 'wrong' } });
  expect(runtime.reconcileApprovalSubmission).toHaveBeenLastCalledWith('cmd', { canProveNeverDispatched: false });
});

it('executes the persisted non-main Agent and workspace instead of the foreground selection', async () => {
  const { service, entry } = fixture('report-agent', true, '/private/tmp');
  const start = vi.fn(async () => ({ success: true })); service.configure(start, vi.fn());
  await expect(service.execute(entry, () => true)).resolves.toEqual({ outcome: 'started' });
  expect(start).toHaveBeenCalledWith({ prompt: 'hello', agentId: 'report-agent', cwd: '/private/tmp' });
});
it('rejects a changed Agent before starting and rechecks after asynchronous startup preparation', async () => {
  const first = fixture('report-agent', true, '/private/tmp');
  const start = vi.fn(async () => ({ success: true })); first.service.configure(start, vi.fn());
  first.changeAgent();
  await expect(first.service.execute(first.entry, () => true)).rejects.toThrow('AGENT_VERSION_CONFLICT');
  expect(start).not.toHaveBeenCalled();
  const next = fixture('report-agent', true, '/private/tmp');
  let release!: () => void;
  const sideEffect = vi.fn();
  next.service.configure(async () => { await new Promise<void>(done => { release = done; }); assertRemoteExecutionPermit(); sideEffect(); return { success: true }; }, vi.fn());
  const running = next.service.execute(next.entry, () => true);
  next.changeAgent(); release();
  await expect(running).rejects.toThrow('AGENT_VERSION_CONFLICT');
  expect(sideEffect).not.toHaveBeenCalled();
});
it('does not start a disabled Agent, while cancellation of its already running task remains allowed', async () => {
  const { service, entry, disableAgent, runtime } = fixture('report-agent', true, '/private/tmp');
  disableAgent();
  await expect(service.execute(entry, () => true)).rejects.toThrow('AGENT_UNAVAILABLE');
  const cancel = { ...entry, command: { ...entry.command, type: 'cancel_run', request: { payload: { runId: entry.runId } } } };
  await expect(service.execute(cancel, () => true)).resolves.toEqual({ outcome: 'cancel_requested' });
  expect(runtime.cancelSessionConfirmed).toHaveBeenCalledOnce();
});

it('consumes only the initial dispatch guards while preserving the task execution identity', async () => {
  const { service, entry, changeAgent } = fixture('report-agent', true, '/private/tmp');
  let permitted = true;
  service.configure(async () => {
    markRemoteExecutionDispatched();
    permitted = false; changeAgent();
    await Promise.resolve();
    expect(() => assertRemoteExecutionPermit()).not.toThrow();
    return { success: true };
  }, vi.fn());
  await expect(service.execute(entry, () => permitted)).resolves.toEqual({ outcome: 'started' });
});

it('retains a definitive Agent rejection when the main handler returns an error response', async () => {
  const { service, entry, changeAgent } = fixture('report-agent', true, '/private/tmp');
  service.configure(async () => {
    await Promise.resolve(); changeAgent();
    try { assertRemoteExecutionPermit(); return { success: true }; }
    catch (error) { return { success: false, error: String(error) }; }
  }, vi.fn());
  await expect(service.execute(entry, () => true)).rejects.toMatchObject({ code: 47029, reason: 'AGENT_VERSION_CONFLICT' });
});

function persistentApprovalFixture(anonymous = false) {
  const directory = mkdtempSync(join(tmpdir(), 'lobster-dual-approval-integration-'));
  approvalDirectories.push(directory);
  const filename = join(directory, 'desktop.sqlite');
  const rawRequest = { command: 'rm report.txt', cwd: directory, sessionKey: 'agent:main:desktop:local' };
  const createdAtMs = Date.now() - 1000;
  const expiresAtMs = Date.now() + 60000;
  const gateway = vi.fn(async (method: string): Promise<any> => {
    if (method === 'exec.approval.list') return [{ id: 'approval', request: rawRequest, createdAtMs, expiresAtMs }];
    if (method === 'approval.get') return { approval: null };
    throw new Error('Simulated dispatch timeout');
  });
  const snapshot = (decision: 'allow-once' | 'deny') => ({ id: 'approval', presentation: { kind: 'exec' }, createdAtMs, expiresAtMs,
    status: decision === 'deny' ? 'denied' : 'allowed', decision, resolvedAtMs: Date.now(), source: { sessionKey: rawRequest.sessionKey } });
  const reopen = () => {
    const db = new Database(filename); databases.push(db);
    db.exec(`CREATE TABLE IF NOT EXISTS cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
      CREATE TABLE IF NOT EXISTS cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
    const remote = new RemoteStore(db); remote.setEnabledOwner(owner); remote.setApprovalProjectionSupported(true);
    if (!db.prepare("SELECT 1 FROM cowork_sessions WHERE id='local'").get()) remote.transaction(() => {
      db.prepare("INSERT INTO cowork_sessions VALUES ('local','task',1,1,'running')").run();
      if (!anonymous) { remote.assignNew('local', owner, 'local_create'); remote.bindRemote('local', 'server-session', 'desktop'); remote.beginRun('local', 'run'); }
    });
    const store = { remote, getSession: () => ({ agentId: 'main', cwd: directory }), assertAgentAccess: vi.fn() } as unknown as CoworkStore;
    let arbiter!: ApprovalDecisionService;
    const runtime = Object.assign(new EventEmitter(), {
      getPermissionState: (id: string) => arbiter.getState(id),
      listPendingPermissions: () => arbiter.listPending(),
      expirePermissions: (now: number) => arbiter.expire(now),
      closeSessionPermissions: (id: string, runId: string) => arbiter.closeSession(id, runId),
      respondToPermissionConfirmed: (id: string, result: any, options: any) => arbiter.submit(id, result.behavior === 'allow' ? 'allow-once' : 'deny', options),
      reconcileApprovalSubmission: (id: string, options: any) => arbiter.reconcileSubmission(id, options),
      getApprovalSubmission: (id: string) => arbiter.getSubmission(id),
    });
    const continuation = vi.fn(async (): Promise<void> => {});
    arbiter = new ApprovalDecisionService({ persistence: remote, getGateway: () => ({ request: gateway }),
      getBinding: () => ({ runId: remote.run('local')?.runId || null, identity: { owner: anonymous ? null : owner, agentId: 'main', cwd: directory } }),
      emitState: (id, state) => { expect(db.inTransaction).toBe(true); runtime.emit('permissionState', id, state); },
      emitResolved: (id, requestId) => { runtime.emit('permissionResolved', id, requestId); },
      emitRequest: (id, request) => { runtime.emit('permissionRequest', id, request); },
      emitError: (id, message) => { runtime.emit('error', id, message); },
      continueSession: continuation, isSessionActive: () => false });
    approvalArbiters.push(arbiter);
    const service = new SessionCommandService(store, runtime as unknown as CoworkRuntime, () => anonymous ? null : owner);
    if (anonymous && !remote.run('local')) runtime.emit('sessionStatus', 'local', 'running');
    arbiter.setGatewayContract({ version: '2026.8.1', bootId: 'boot', methods: ['approval.get', 'approval.resolve', 'exec.approval.list', 'plugin.approval.list'] });
    arbiter.configure({ enabled: true, projectionSupported: true });
    return { db, remote, runtime, arbiter, service, continuation };
  };
  const first = reopen();
  const state = first.arbiter.register({ pending: { requestId: 'approval', sessionId: 'local', kind: 'exec' }, rawRequest,
    permission: { requestId: 'approval', toolName: 'Bash', toolInput: {} }, createdAtMs, expiresAtMs,
    description: { title: 'Delete report', summary: 'Delete report.txt in this workspace', remoteSafe: true } })!;
  const request = { commandId: 'mobile', type: 'approval_response', sessionId: 'server-session', payload: {
    runId: state.runId, approvalId: 'approval', approvalVersion: state.approvalVersion, operationDigest: state.operationDigest, decision: 'approve',
  } };
  const entry: InboxEntry = { command: { commandId: 'mobile', type: 'approval_response', request, requestHash: payloadHash(request),
    status: 'received', statusVersion: '3', claimId: 'original-claim', claimToken: 'original-token', claimUntil: new Date(Date.now() + 15000).toISOString(), expiresAt: new Date(expiresAtMs).toISOString() },
  owner, localSessionId: 'local', remoteSessionId: 'server-session', runId: state.runId, state: 'executing', result: null };
  if (!anonymous) first.remote.put('inbox:mobile', entry);
  return { first, reopen, gateway, entry, rawRequest, snapshot };
}

it('recovers a file-backed reserved approval and atomically rejects its original inbox before allowing desktop resolution', async () => {
  const f = persistentApprovalFixture();
  const originalSubmit = f.first.runtime.respondToPermissionConfirmed;
  f.first.runtime.respondToPermissionConfirmed = (id, decision, options) => originalSubmit(id, decision, { ...options,
    beforeDispatch: async () => { options.beforeDispatch(); await new Promise<void>(() => {}); } });
  void f.first.service.execute(f.entry, () => true);
  expect(f.first.remote.get<any>('approvalResolution:approval')?.submission.phase).toBe('reserved');
  expect(f.first.remote.get<any>('approval:local:approval')?.resolution.phase).toBe('submitting');
  f.first.arbiter.dispose(); f.first.db.close();
  const restarted = f.reopen();
  const persisted = restarted.remote.get<InboxEntry>('inbox:mobile')!;
  expect((await restarted.service.reconcileApproval(persisted))?.kind).toBe('known_not_applied');
  expect(restarted.remote.get<InboxEntry>('inbox:mobile')).toMatchObject({ state: 'rejected', command: { claimToken: 'original-token' } });
  expect(restarted.remote.get<any>('approval:local:approval')?.resolution.phase).toBe('idle');
  expect(restarted.arbiter.getSubmission('mobile')?.kind).toBe('known_not_applied');
  expect(f.gateway.mock.calls.filter(call => call[0] === 'approval.resolve')).toHaveLength(0);
  f.gateway.mockImplementation(async method => method === 'approval.resolve' ? { applied: true, approval: f.snapshot('deny') } : { approval: null });
  expect((await restarted.arbiter.submit('approval', 'deny', { submissionId: 'desktop', source: 'desktop' })).kind).toBe('confirmed');
  expect(restarted.remote.get<any>('approval:local:approval')).toMatchObject({ status: 'denied', resolution: { confirmedDecision: 'deny', source: 'desktop' } });
  expect(restarted.remote.get<InboxEntry>('inbox:mobile')?.state).toBe('rejected');
});

it('restores file-backed unknown proof, preserves it after expiry and only appends late history after the run ends', async () => {
  const f = persistentApprovalFixture();
  await expect(f.first.service.execute(f.entry, () => true)).rejects.toMatchObject({ outcome: { kind: 'unknown' } });
  expect(f.first.remote.get<InboxEntry>('inbox:mobile')?.state).toBe('unknown');
  f.first.arbiter.dispose(); f.first.db.close();
  const restarted = f.reopen();
  expect(restarted.remote.get<any>('approval:local:approval')?.resolution.phase).toBe('unknown');
  expect(restarted.remote.run('local')?.status).toBe('reconciling');
  restarted.remote.expireApprovals(Date.now() + 86400000);
  expect(restarted.arbiter.getState('approval')?.status).toBe('pending');
  restarted.remote.updateRun('local', 'succeeded');
  const closedAt = restarted.arbiter.getState('approval')?.resolvedAt;
  restarted.arbiter.mergeResolved('approval', 'allow-once', Date.now(), f.rawRequest);
  expect(restarted.remote.get<any>('approval:local:approval')).toMatchObject({ status: 'cancelled', resolvedAt: closedAt,
    resolution: { phase: 'finished', confirmedDecision: 'approve' } });
  expect(restarted.remote.run('local')?.status).toBe('succeeded');
  expect(restarted.continuation).not.toHaveBeenCalled();
  expect(f.gateway.mock.calls.filter(call => call[0] === 'approval.resolve')).toHaveLength(1);
  const event = restarted.remote.pending('local').filter(item => item.eventType === 'approval.updated').at(-1)!;
  expect(event.payload.approval).toMatchObject({ status: 'cancelled', resolution: { confirmedDecision: 'approve' } });
});
it('consumes the mobile permit at actual dispatch so a late ACK may continue the original run', async () => {
  const f = persistentApprovalFixture();
  let complete!: (result: any) => void;
  let permitted = true;
  f.gateway.mockImplementation(async method => method === 'approval.resolve' ? new Promise(resolve => { complete = resolve; }) : { approval: null });
  f.first.continuation.mockImplementation(async () => {
    expect(() => assertRemoteExecutionPermit()).not.toThrow();
    expect(currentRemoteExecution()).toMatchObject({ owner, runId: 'run', commandId: 'mobile' });
  });
  const execution = f.first.service.execute(f.entry, () => permitted);
  await Promise.resolve(); await Promise.resolve();
  expect(f.gateway.mock.calls.filter(call => call[0] === 'approval.resolve')).toHaveLength(1);
  // The RPC has already been sent. Expiring its first-dispatch permit must not revoke
  // the original run or turn its required exec continuation into a second remote command.
  permitted = false;
  complete({ applied: true, approval: f.snapshot('allow-once') });
  await expect(execution).resolves.toEqual({ outcome: 'approval_applied' });
  await vi.waitFor(() => expect(f.first.remote.get<any>('approvalResolution:approval')?.continuation).toBe('confirmed'), { timeout: 2500 });
  expect(f.first.continuation).toHaveBeenCalledOnce();
});
it('gives anonymous tasks distinct local runs and never lets an old approval continue a later anonymous turn', async () => {
  const f = persistentApprovalFixture(true);
  const firstRun = f.first.remote.run('local')!.runId;
  expect(f.first.remote.owner('local')).toBeNull(); expect(f.first.remote.sync('local')).toBeNull();
  expect(f.first.arbiter.getState('approval')?.runId).toBe(firstRun);
  expect((await f.first.arbiter.submit('approval', 'allow-once', { submissionId: 'anonymous-desktop', source: 'desktop' })).kind).toBe('unknown');
  f.first.runtime.emit('complete', 'local');
  expect(f.first.arbiter.getState('approval')?.status).toBe('cancelled');
  f.first.runtime.emit('sessionStatus', 'local', 'running');
  const next = f.first.remote.run('local');
  expect(next?.runId).not.toBe(firstRun);
  f.first.arbiter.mergeResolved('approval', 'allow-once', Date.now(), f.rawRequest);
  expect(f.first.arbiter.getState('approval')).toMatchObject({ runId: firstRun, status: 'cancelled', resolution: { confirmedDecision: 'approve' } });
  expect(f.first.remote.run('local')).toEqual(next);
  expect(f.first.continuation).not.toHaveBeenCalled();
  expect(f.first.remote.pending('local')).toEqual([]); expect(f.first.remote.sessions(owner)).toEqual([]);
});
