import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { afterEach, expect, it, vi } from 'vitest';

import type { CoworkStore } from '../coworkStore';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { RemoteStore } from './remoteStore';
import { SessionCommandService } from './sessionCommandService';

const owner = { userId: '10001', scopeKey: 'personal' };
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const remote = new RemoteStore(db);
  const store = { remote, getConfig: () => ({ systemPrompt: '' }), getSession: () => ({ cwd: '/work' }),
    createSession: (_title: string, _cwd: string, _prompt: string, _mode: string, _skills: string[], _agent: string, _model: string, options: any) => {
      db.prepare("INSERT INTO cowork_sessions VALUES ('local','new',1,1,'idle')").run(); remote.assignNew('local', options.owner, options.ownershipSource); return { id: 'local' };
    },
  };
  const runtime = Object.assign(new EventEmitter(), { stopSession: vi.fn(), cancelSessionConfirmed: vi.fn(async () => true), respondToPermissionConfirmed: vi.fn(async () => undefined) });
  const service = new SessionCommandService(store as unknown as CoworkStore, runtime as unknown as CoworkRuntime, () => owner);
  service.configure(async () => ({ success: true }), async () => ({ success: true }));
  const request = { commandId: 'cmd', type: 'create_session', payload: { text: 'hello' } };
  const command = { commandId: 'cmd', type: 'create_session', sessionId: 'server-session', runId: 'server-run', status: 'claimed', statusVersion: '2', expiresAt: new Date(Date.now() + 60000).toISOString(), request, requestHash: 'hash' };
  const prepared = remote.transaction(() => service.prepare(command, owner, '/work'));
  const entry = { command, owner, ...prepared, state: 'executing' as const, result: null };
  return { service, runtime, remote, prepared, entry };
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
it('projects local-only approval with full expiry/resolution fields and invalidates it when run ends', () => {
  const { runtime, remote } = fixture(); remote.markRunDispatched('local');
  runtime.emit('permissionRequest', 'local', { requestId: 'approval', toolName: 'Bash', toolInput: { command: 'private command' } });
  const approval = remote.get<any>('approval:local:approval');
  expect(approval.remoteAllowed).toBe(false); expect(approval.requiresLocalAction).toBe(true);
  expect(approval.resolvedAt).toBeNull(); expect(Number.isFinite(Date.parse(approval.expiresAt))).toBe(true);
  remote.updateRun('local', 'failed', 'Failed');
  const resolved = remote.get<any>('approval:local:approval'); expect(resolved.status).toBe('cancelled'); expect(resolved.approvalVersion).toBe('2'); expect(resolved.resolvedAt).not.toBeNull();
});

it('expires pending approvals with a new version and a resolved timestamp', () => {
  const { runtime, remote } = fixture(); remote.markRunDispatched('local');
  runtime.emit('permissionRequest', 'local', { requestId: 'expiry', toolName: 'Bash', toolInput: {} });
  remote.expireApprovals(Date.now() + 16 * 60000);
  const approval = remote.get<any>('approval:local:expiry');
  expect(approval.status).toBe('expired'); expect(approval.approvalVersion).toBe('2'); expect(approval.resolvedAt).not.toBeNull();
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


it('preserves an expired approval after desktop confirmation and only resumes its own nonterminal run', () => {
  const { remote, runtime } = fixture();
  runtime.emit('permissionRequest', 'local', { requestId: 'expired-local', toolName: 'Bash', toolInput: {} });
  remote.expireApprovals(Date.now() + 16 * 60000);
  const expired = remote.get<any>('approval:local:expired-local');
  expect(expired.status).toBe('expired');
  runtime.emit('permissionResolved', 'local', 'expired-local');
  expect(remote.get('approval:local:expired-local')).toEqual(expired);
  expect(remote.run('local')?.status).toBe('running');
  remote.updateRun('local', 'succeeded');
  runtime.emit('permissionResolved', 'local', 'expired-local');
  expect(remote.run('local')?.status).toBe('succeeded');
  remote.beginRun('local', 'new-run'); remote.updateRun('local', 'waiting_local');
  const next = remote.run('local');
  runtime.emit('permissionResolved', 'local', 'expired-local');
  expect(remote.run('local')).toEqual(next);
  expect(remote.get('approval:local:expired-local')).toEqual(expired);
});
