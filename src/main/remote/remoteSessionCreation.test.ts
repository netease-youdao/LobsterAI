import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getAppPath: () => '/mock' } }));

import { AgentId } from '../../shared/agent/constants';
import { RemoteEnvironment } from '../../shared/remote/environment';
import { CoworkStore } from '../coworkStore';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { OwnershipOperationGate } from '../ownershipOperationGate';
import { payloadHash } from './canonical';
import { type InboxEntry, RemoteBridge } from './remoteBridge';
import { currentRemoteExecution, SessionCommandService } from './sessionCommandService';

const owner = { userId: '10001', scopeKey: 'personal' };
const databases: Database.Database[] = [];
const bridges: RemoteBridge[] = [];

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.stop();
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  // Keep session writes, ownership, run reservation and notification journals real.
  db.exec(`
    CREATE TABLE cowork_sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, claude_session_id TEXT, scheduled_task_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle', pinned INTEGER NOT NULL DEFAULT 0, pin_order INTEGER,
      cwd TEXT NOT NULL, system_prompt TEXT NOT NULL DEFAULT '', model_override TEXT NOT NULL DEFAULT '',
      thinking_level TEXT NOT NULL DEFAULT '', execution_mode TEXT NOT NULL DEFAULT 'local',
      active_skill_ids TEXT, agent_id TEXT DEFAULT 'main', goal_json TEXT,
      parent_session_id TEXT, forked_from_message_id TEXT, forked_at INTEGER,
      fork_mode TEXT DEFAULT 'none', fork_workspace_path TEXT, fork_git_branch TEXT, fork_git_base_ref TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE cowork_messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL,
      metadata TEXT, created_at INTEGER NOT NULL, sequence INTEGER);
    CREATE TABLE cowork_config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', system_prompt TEXT DEFAULT '',
      identity TEXT DEFAULT '', model TEXT DEFAULT '', icon TEXT DEFAULT '', skill_ids TEXT DEFAULT '[]',
      enabled INTEGER DEFAULT 1, is_default INTEGER DEFAULT 0, source TEXT DEFAULT 'custom',
      preset_id TEXT DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO agents (id, name, is_default, created_at, updated_at) VALUES ('main', 'Main', 1, 1, 1);
  `);
  const store = new CoworkStore(db);
  const remote = store.remote;
  const runtime = new EventEmitter() as CoworkRuntime;
  const service = new SessionCommandService(store, runtime, () => owner, { gate: new OwnershipOperationGate() });
  const createSession = vi.spyOn(store, 'createSession');
  const committedObservations: any[] = [];
  const executionObservations: any[] = [];
  store.onSessionProjectionChanges(changes => {
    const localId = changes.changedSessionIds[0];
    committedObservations.push({
      changes, inTransaction: db.inTransaction, session: store.getSession(localId, 0),
      inbox: remote.get<InboxEntry>('inbox:command-1'), sync: remote.sync(localId),
      run: remote.run(localId), owner: remote.owner(localId),
    });
  });
  const start = vi.fn(async () => {
    const context = currentRemoteExecution()!;
    executionObservations.push({
      inTransaction: db.inTransaction, sessionId: context.preparedSessionId, runId: context.runId,
      inbox: remote.get<InboxEntry>('inbox:command-1'), notificationCount: committedObservations.length,
    });
    remote.markRunDispatched(context.preparedSessionId!);
    return { success: true };
  });
  service.configure(start, vi.fn());
  const request = {
    commandId: 'command-1', type: 'create_session', deviceId: 'desktop',
    expiresAt: new Date(Date.now() + 60000).toISOString(), payload: { text: '哈尔滨天气如何', workspaceId: 'workspace' },
  };
  const command = {
    sessionId: 'server-session', runId: 'server-run', commandId: request.commandId,
    type: request.type, status: 'claimed', statusVersion: '2', expiresAt: request.expiresAt,
  };
  const envelope = {
    command, request, requestHash: payloadHash(request), claimId: 'claim', claimToken: 'secret',
    claimUntil: new Date(Date.now() + 15000).toISOString(), statusVersion: '2',
  };
  const requestApi = vi.fn(async (_owner, pathname: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    let data: any;
    if (pathname.endsWith('/commands/claim')) data = { items: [envelope] };
    else if (pathname.includes('/commands?')) {
      data = { items: [{ command, request, requestHash: envelope.requestHash, currentClaimId: 'lost-claim' }], nextCursor: null };
    } else if (pathname.endsWith('/ack')) {
      data = { ...command, status: body.status, statusVersion: body.status === 'received' ? '3' : '4' };
    } else if (pathname.endsWith('/reconcile')) {
      data = body.observedExecution === 'not_started'
        ? { command, executionPermit: { claimId: 'replacement-claim', claimToken: 'replacement-secret', claimUntil: envelope.claimUntil } }
        : { command: { ...command, status: body.observedExecution === 'applied' ? 'applied' : 'unknown' }, executionPermit: null };
    } else throw new Error(`Unexpected request ${pathname}`);
    return new Response(JSON.stringify({ code: 0, message: 'success', data }));
  });
  const dependencies = {
    store: remote, identity: { installationId: 'instance', deviceKey: 'key', databaseId: 'database' },
    getOwner: () => owner, getEnvironment: () => RemoteEnvironment.Test, getApiBaseUrl: () => 'https://example.com', request: requestApi,
    metadata: { name: 'Desktop', hostName: 'host', platform: 'macos', appVersion: '1', instanceLabel: 'default' },
    runSessionTransaction: <T>(operation: () => T): T => store.runSessionTransaction(operation),
    prepare: service.prepare.bind(service), execute: service.execute.bind(service), onAccountChange: vi.fn(),
  };
  const bridge: any = new RemoteBridge(dependencies);
  bridges.push(bridge);
  bridge.owner = owner;
  bridge.registration = { deviceId: 'desktop', ...owner, metadataVersion: '1' };
  bridge.generation = '1';
  bridge.sameAccountAccess = true;
  remote.setWake(() => {});
  remote.put('settings:10001:personal', {
    enabled: true, name: 'Desktop', settingsVersion: '1',
    workspaces: [{ workspaceId: 'workspace', name: 'Folder', path: tmpdir(), available: true }],
  });
  return { db, store, remote, bridge, start, createSession, committedObservations, executionObservations, requestApi };
}

describe.each(['claim', 'reconcile'] as const)('mobile session creation through %s', path => {
  it('commits the real session, ownership, run and inbox before notifying or executing, without replay on retries', async () => {
    const { db, remote, bridge, start, createSession, committedObservations, executionObservations, requestApi } = fixture();
    await bridge[path]();

    const entry = remote.get<InboxEntry>('inbox:command-1');
    expect(entry).toMatchObject({ state: 'applied', remoteSessionId: 'server-session', runId: 'server-run', result: { outcome: 'started' } });
    const localId = entry!.localSessionId!;
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(committedObservations).toEqual([expect.objectContaining({
      inTransaction: false,
      changes: { changedSessionIds: [localId], deletedSessionIds: [], affectedArtifactIds: [] },
      session: expect.objectContaining({ id: localId, title: '哈尔滨天气如何', agentId: AgentId.Main }),
      inbox: expect.objectContaining({ state: 'prepared', localSessionId: localId, remoteSessionId: 'server-session', runId: 'server-run' }),
      sync: expect.objectContaining({ local_id: localId, session_id: 'server-session', device_id: 'desktop' }),
      run: expect.objectContaining({ runId: 'server-run', status: 'starting' }), owner,
    })]);
    expect(executionObservations).toEqual([expect.objectContaining({
      inTransaction: false, sessionId: localId, runId: 'server-run', notificationCount: 1,
      inbox: expect.objectContaining({ state: 'executing' }),
    })]);
    if (path === 'reconcile') {
      const reconciliation = requestApi.mock.calls.find(call => call[1].endsWith('/reconcile'))!;
      expect(JSON.parse(String(reconciliation[2].body))).toMatchObject({
        claimId: 'lost-claim', observedExecution: 'not_started', requestExecutionPermit: true,
        localEvidence: { databaseHealthy: true, historyComplete: true, inboxPersisted: true, executionNeverStarted: true },
      });
      expect(JSON.parse(String(reconciliation[2].body))).not.toHaveProperty('claimToken');
    }

    await bridge.claim();
    await bridge.reconcile();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(committedObservations).toHaveLength(1);
    expect(db.prepare('SELECT id FROM cowork_sessions').all()).toEqual([{ id: localId }]);
  });

  it('rolls back all preparation writes and emits no notification when inbox persistence fails', async () => {
    const { db, remote, bridge, start, createSession, committedObservations } = fixture();
    const put = remote.put.bind(remote);
    let wrotePreparedInbox = false;
    vi.spyOn(remote, 'put').mockImplementation((key, value) => {
      put(key, value);
      if (key === 'inbox:command-1' && (value as InboxEntry).state === 'prepared') {
        wrotePreparedInbox = true;
        throw new Error('Injected failure after persisting the prepared inbox');
      }
    });

    await bridge[path]();

    expect(wrotePreparedInbox).toBe(true);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(committedObservations).toEqual([]);
    for (const table of ['cowork_sessions', 'cowork_session_ownership', 'remote_sync', 'remote_outbox', 'remote_projection']) {
      expect(db.prepare(`SELECT * FROM ${table}`).all(), table).toEqual([]);
    }
    expect(remote.entries('run:')).toEqual([]);
    expect(remote.entries('agentExecution:')).toEqual([]);
    expect(remote.entries('origin:')).toEqual([]);
    expect(db.inTransaction).toBe(false);
    if (path === 'claim') {
      expect(remote.get<InboxEntry>('inbox:command-1')).toMatchObject({ state: 'rejected', localSessionId: null });
    } else expect(remote.get('inbox:command-1')).toBeNull();
  });
});
