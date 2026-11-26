import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, expect, it, vi } from 'vitest';

import { AgentOwnerKind } from '../../shared/agent/constants';
import { AgentOwnerStore } from '../agentOwnership';
import type { CoworkStore } from '../coworkStore';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import type { InputPreparationService } from './inputPreparationService';
import type { InboxEntry, RemoteCommand } from './remoteBridge';
import type { RemoteModelCatalog } from './remoteModelCatalog';
import { RemotePublicationKind } from './remotePublicationOrigins';
import { RemoteStore } from './remoteStore';
import { assertRemoteExecutionPermit, markRemoteExecutionDispatched, SessionCommandService } from './sessionCommandService';

const owner = { userId: 'account', scopeKey: 'personal' };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'anonymous-agent-continuation-'));
  const db = new Database(':memory:');
  cleanups.push(() => { db.close(); rmSync(cwd, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,created_at INTEGER,updated_at INTEGER,enabled INTEGER);
    CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,agent_id TEXT,cwd TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);
    CREATE TABLE remote_sync_targets(target_id TEXT PRIMARY KEY,sync_target_json TEXT);
    INSERT INTO agents VALUES('anon','Anonymous',1,1,1),('other','Other',1,1,1);`);
  const remote = new RemoteStore(db), agents = new AgentOwnerStore(db);
  db.prepare('INSERT INTO remote_sync_targets VALUES (?,?)').run('target', JSON.stringify({ version: 1, dataSpaceId: 'task-space', dataGeneration: '1' }));
  remote.publicationOrigins.setRouteProvider(() => 'https://task.example');
  remote.publicationOrigins.setCurrentTargetProvider(() => ({ owner, route: 'https://task.example', dataSpaceId: 'task-space' }));
  remote.publicationOrigins.capture(RemotePublicationKind.Agent, 'anon', null);
  remote.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES('local','Owned task','anon',?,'idle',1,1)").run(cwd);
    db.prepare("INSERT INTO cowork_sessions VALUES('unrelated','Local task','anon',?,'idle',1,1)").run(cwd);
    remote.assignNew('local', owner, 'local_create');
    remote.assignNew('unrelated', null, 'local_create');
    remote.bindRemote('local', 'remote', 'pc');
  });
  let admitted = true;
  remote.setTaskAdmission(id => id === 'local' && admitted);
  const store = { remote, agentOwnership: agents, getConfig: () => ({ systemPrompt: '' }),
    assertAgentAccess: (id: string, actor: typeof owner | null) => agents.assertAccess(id, actor),
    getAgent: (id: string) => db.prepare('SELECT * FROM agents WHERE id=?').get(id),
    getSession: (id: string) => db.prepare('SELECT id,agent_id AS agentId,cwd FROM cowork_sessions WHERE id=?').get(id),
  } as unknown as CoworkStore;
  const service = new SessionCommandService(store, new EventEmitter() as CoworkRuntime, () => owner);
  service.configureInput({ preparations: {} as InputPreparationService, models: {} as RemoteModelCatalog,
    getDeviceId: () => 'pc', getTargetId: () => 'target' });
  const send = vi.fn(async () => { assertRemoteExecutionPermit(); markRemoteExecutionDispatched(); return { success: true }; });
  service.configure(send, options => service.submit(options, false, send));
  const command: RemoteCommand = { commandId: 'cmd', type: 'send_message', sessionId: 'remote', runId: 'run',
    status: 'claimed', statusVersion: '1', requestHash: 'hash', expiresAt: new Date(Date.now() + 60000).toISOString(),
    request: { commandId: 'cmd', type: 'send_message', sessionId: 'remote', expectedControlVersion: remote.controlVersion('local'), payload: { text: 'continue' } } };
  const prepare = (): InboxEntry => ({ command, owner, ...remote.transaction(() => service.prepare(command, owner, null)), state: 'executing', result: null });
  return { db, remote, agents, service, send, command, prepare, revokeAdmission: () => { admitted = false; } };
}

it('continues only the admitted owned task without claiming its anonymous Agent or sibling task', async () => {
  const f = fixture();
  const origin = f.db.prepare("SELECT * FROM remote_publication_origins WHERE kind='agent'").get();
  await expect(f.service.execute(f.prepare(), () => true)).resolves.toEqual({ outcome: 'started' });
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.agents.get('anon')?.ownerKind).toBe(AgentOwnerKind.Anonymous);
  expect(f.remote.owner('unrelated')).toBeNull();
  expect(f.remote.sync('unrelated')).toBeNull();
  expect(f.db.prepare("SELECT * FROM remote_publication_origins WHERE kind='agent'").get()).toEqual(origin);
});

it.each(['admission', 'source', 'foreign-agent', 'quarantined-agent', 'deleted-agent', 'disabled-agent'] as const)(
  'rejects %s both during command preparation and before execution', async boundary => {
    const f = fixture(), entry = f.prepare();
    if (boundary === 'admission') f.revokeAdmission();
    if (boundary === 'source') f.db.prepare("UPDATE remote_publication_origins SET data_space_id='other-space' WHERE kind='session'").run();
    if (boundary === 'foreign-agent') f.db.prepare("UPDATE agent_ownership SET owner_kind='owned',owner_user_id='other-account',owner_scope_key='personal' WHERE agent_id='anon'").run();
    if (boundary === 'quarantined-agent') f.db.prepare("UPDATE agent_ownership SET owner_kind='quarantined' WHERE agent_id='anon'").run();
    if (boundary === 'deleted-agent') f.db.prepare("UPDATE agent_ownership SET deleted_at=1 WHERE agent_id='anon'").run();
    if (boundary === 'disabled-agent') f.agents.transaction(() => f.db.prepare("UPDATE agents SET enabled=0 WHERE id='anon'").run());
    expect(() => f.prepare()).toThrow();
    await expect(f.service.execute(entry, () => true)).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  },
);

it('rejects a changed fixed Agent before dispatch even if the replacement is also anonymous', async () => {
  const f = fixture(), entry = f.prepare();
  f.service.configure(f.send, options => f.service.submit(options, false, async () => {
    f.db.prepare("UPDATE cowork_sessions SET agent_id='other' WHERE id='local'").run();
    assertRemoteExecutionPermit();
    return f.send();
  }));
  await expect(f.service.execute(entry, () => true)).rejects.toThrow();
  expect(f.send).not.toHaveBeenCalled();
});

it('does not permit mobile creation on an anonymous Agent because one task is already admitted', () => {
  const f = fixture();
  f.command.type = 'create_session';
  f.command.request = { commandId: 'cmd', type: 'create_session', payload: { text: 'new', agentId: 'anon', expectedAgentVersion: '1' } };
  expect(() => f.remote.transaction(() => f.service.prepare(f.command, owner, tmpdir()))).toThrow();
  expect(f.remote.run('local')).toBeNull();
  expect(f.send).not.toHaveBeenCalled();
});
