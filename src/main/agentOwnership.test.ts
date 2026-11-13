import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import { AgentAccessErrorCode, AgentId, AgentOwnerKind } from '../shared/agent/constants';
import { createExpertCatalogFixture, ExpertFixtureId } from '../shared/agent/expertCatalogFixture';
import type { ExpertCatalog } from '../shared/agent/presets';
import type { RemoteOwner } from '../shared/remote/constants';
import { AgentManager } from './agentManager';
import { AgentOwnerStore, withTrustedAgentWrite } from './agentOwnership';
import { CoworkStore } from './coworkStore';

vi.mock('electron', () => ({ app: { getAppPath: () => '/mock' } }));
const ownerA = { userId: '1001', scopeKey: 'personal' };
const ownerB = { userId: '1002', scopeKey: 'personal' };
const databases: Database.Database[] = [];
const tempDirs: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(filename = ':memory:') {
  const db = new Database(filename);
  databases.push(db);
  db.exec(`
    CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT DEFAULT '',system_prompt TEXT DEFAULT '',
      identity TEXT DEFAULT '',model TEXT DEFAULT '',thinking_level TEXT DEFAULT '',working_directory TEXT DEFAULT '',
      icon TEXT DEFAULT '',icon_customized INTEGER,skill_ids TEXT DEFAULT '[]',subagent_allow_agent_ids TEXT DEFAULT '[]',enabled INTEGER DEFAULT 1,
      pinned INTEGER DEFAULT 0,pin_order INTEGER,sort_order INTEGER,is_default INTEGER DEFAULT 0,source TEXT DEFAULT 'custom',
      preset_id TEXT DEFAULT '',created_at INTEGER DEFAULT 1,updated_at INTEGER DEFAULT 1);
    CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,agent_id TEXT,status TEXT,title TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);
    CREATE TABLE user_memories(id TEXT PRIMARY KEY,status TEXT,is_explicit INTEGER,updated_at INTEGER);
    CREATE TABLE user_memory_sources(memory_id TEXT,session_id TEXT,is_active INTEGER);
    INSERT INTO agents(id,name,is_default) VALUES('main','LobsterAI',1);
    INSERT INTO agents(id,name) VALUES('legacy','Shared legacy');
  `);
  const store = new CoworkStore(db);
  return { db, store, ownership: store.agentOwnership };
}

test('migration keeps main shared, legacy anonymous, and late missing ownership quarantined', () => {
  const { db, ownership } = fixture();
  expect(ownership.get(AgentId.Main)?.ownerKind).toBe(AgentOwnerKind.Default);
  expect(ownership.get('legacy')?.ownerKind).toBe(AgentOwnerKind.Anonymous);
  expect(ownership.canView('legacy', ownerA)).toBe(true);
  expect(ownership.canPublish('legacy', ownerA)).toBe(false);
  db.prepare("INSERT INTO agents(id,name) VALUES('late','Old client')").run();
  expect(ownership.get('late')?.ownerKind).toBe(AgentOwnerKind.Quarantined);
  expect(ownership.canView('late', null)).toBe(false);
  new AgentOwnerStore(db);
  expect(ownership.get('late')?.ownerKind).toBe(AgentOwnerKind.Quarantined);
  expect(ownership.get('legacy')?.ownerKind).toBe(AgentOwnerKind.Anonymous);
});

test('trusted creation fixes owner and scopes; no login claims anonymous instances', () => {
  const { store, ownership } = fixture();
  const privateAgent = store.createAgent({ name: 'Private' }, ownerA);
  const anonymous = store.createAgent({ name: 'Anonymous' }, null);
  expect(ownership.canView(privateAgent.id, ownerA)).toBe(true);
  expect(ownership.canView(privateAgent.id, ownerB)).toBe(false);
  expect(ownership.canView(privateAgent.id, { ...ownerA, scopeKey: 'enterprise:12' })).toBe(false);
  expect(ownership.canView(privateAgent.id, null)).toBe(false);
  expect(ownership.canPublish(privateAgent.id, ownerA)).toBe(true);
  expect(new Set(store.listVisibleAgents(ownerB).map(agent => agent.id))).toEqual(new Set(['main', 'legacy', anonymous.id]));
  expect(ownership.get(anonymous.id)?.owner).toBeNull();
  expect(() => store.updateAgent(privateAgent.id, { name: 'Stolen' }, ownerB)).toThrow();
});

test('external updates cannot damage an owned Agent or hide it after reopening ownership', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-agent-guard-'));
  tempDirs.push(dir);
  const filename = path.join(dir, 'test.sqlite');
  const { db, store, ownership } = fixture(filename);
  const agent = store.createAgent({ name: 'Private' }, ownerA);
  const before = ownership.get(agent.id);
  const external = new Database(filename);
  databases.push(external);
  expect(() => external.prepare('UPDATE agents SET name=?,identity=? WHERE id=?').run('Changed', 'Changed identity', agent.id))
    .toThrow('Use LobsterAI Agent settings');
  expect(store.getVisibleAgent(agent.id, ownerA)).toEqual(agent);
  expect(ownership.get(agent.id)).toEqual(before);
  expect(new AgentOwnerStore(db).canView(agent.id, ownerA)).toBe(true);
});

test.each(['DELETE FROM agents WHERE id=?', 'INSERT OR REPLACE INTO agents(id,name) VALUES(?,\'Replacement\')'])(
  'external mutation %s preserves owned Agent data and tombstone state', statement => {
    const { db, store, ownership } = fixture();
    const agent = store.createAgent({ name: 'Private' }, ownerA);
    const before = ownership.get(agent.id);
    expect(() => db.prepare(statement).run(agent.id)).toThrow();
    expect(store.getVisibleAgent(agent.id, ownerA)).toEqual(agent);
    expect(ownership.get(agent.id)).toEqual(before);
  },
);

test('trusted settings, reorder, model backfill and deletion retain their normal authorization', () => {
  const { db, store, ownership } = fixture();
  const agent = store.createAgent({ name: 'Private' }, ownerA);
  expect(store.updateAgent(agent.id, { name: 'Updated', identity: 'New identity' }, ownerA)?.identity).toBe('New identity');
  store.reorderAgents([agent.id], ownerA);
  store.backfillEmptyAgentModels('provider/model');
  expect(store.getAgent(agent.id)?.model).toBe('provider/model');
  expect(ownership.get(agent.id)?.owner).toEqual(ownerA);
  expect(() => store.deleteAgent(agent.id, ownerB)).toThrow();
  expect(store.deleteAgent(agent.id, ownerA)).toBe(true);
  expect(ownership.get(agent.id)?.deletedAt).not.toBeNull();
  expect(db.prepare('SELECT trusted FROM agent_write_context WHERE id=1').get()).toEqual({ trusted: 0 });
});

test('trusted migration failure rolls back Agent changes and trust; missing trust fails closed', () => {
  const { db, store, ownership } = fixture();
  const agent = store.createAgent({ name: 'Private' }, ownerA);
  const before = ownership.get(agent.id);
  expect(() => withTrustedAgentWrite(db, () => {
    db.prepare('UPDATE agents SET name=? WHERE id=?').run('Partial migration', agent.id);
    throw new Error('migration failed');
  })).toThrow('migration failed');
  expect(store.getAgent(agent.id)).toEqual(agent);
  expect(ownership.get(agent.id)).toEqual(before);
  expect(db.prepare('SELECT trusted FROM agent_write_context WHERE id=1').get()).toEqual({ trusted: 0 });
  withTrustedAgentWrite(db, () => {
    expect(() => withTrustedAgentWrite(db, () => {
      db.prepare('UPDATE agents SET name=? WHERE id=?').run('Nested failure', agent.id);
      throw new Error('nested migration failed');
    })).toThrow('nested migration failed');
    expect(store.getAgent(agent.id)).toEqual(agent);
    expect(db.prepare('SELECT trusted FROM agent_write_context WHERE id=1').get()).toEqual({ trusted: 1 });
    db.prepare('UPDATE agents SET name=? WHERE id=?').run('Trusted outer change', agent.id);
  });
  expect(ownership.get(agent.id)?.owner).toEqual(ownerA);
  expect(db.prepare('SELECT trusted FROM agent_write_context WHERE id=1').get()).toEqual({ trusted: 0 });
  db.prepare('DELETE FROM agent_write_context').run();
  expect(() => db.prepare('UPDATE agents SET name=? WHERE id=?').run('Untrusted', agent.id)).toThrow();
  expect(() => withTrustedAgentWrite(db, () => undefined)).toThrow('Invalid Agent write context');
});

test('legacy anonymous writes remain compatible and malformed ownership remains quarantined', () => {
  const { db, store, ownership } = fixture();
  db.prepare("UPDATE agents SET name='Legacy update' WHERE id='legacy'").run();
  expect(ownership.canView('legacy', ownerA)).toBe(true);
  const agent = store.createAgent({ name: 'Private' }, ownerA);
  db.prepare("UPDATE agent_ownership SET owner_kind='owned',owner_user_id=NULL WHERE agent_id=?").run(agent.id);
  expect(ownership.canView(agent.id, null)).toBe(false);
  new AgentOwnerStore(db);
  expect(ownership.get(agent.id)?.ownerKind).toBe(AgentOwnerKind.Quarantined);
  expect(store.getVisibleAgent(agent.id, ownerA)).toBeNull();
});

test('owner assignment, versions and notifications commit atomically and tombstones prevent reuse', () => {
  const { db, store, ownership } = fixture();
  const listener = vi.fn(() => expect(db.inTransaction).toBe(false));
  ownership.subscribe(listener);
  expect(() => ownership.transaction(() => {
    store.createAgent({ id: 'rollback', name: 'Rollback' }, ownerA);
    throw new Error('rollback');
  })).toThrow('rollback');
  expect(ownership.get('rollback')).toBeNull();
  expect(listener).not.toHaveBeenCalled();
  const agent = store.createAgent({ name: 'Private' }, ownerA);
  expect(ownership.get(agent.id)?.version).toBe('1');
  store.updateAgent(agent.id, { name: 'Renamed' }, ownerA);
  expect(ownership.get(agent.id)?.version).toBe('2');
  ownership.touch(agent.id);
  expect(ownership.get(agent.id)?.version).toBe('3');
  ownership.transaction(() => db.prepare('DELETE FROM agents WHERE id=?').run(agent.id));
  expect(ownership.get(agent.id)?.version).toBe('4');
  expect(ownership.get(agent.id)?.deletedAt).not.toBeNull();
  expect(() => store.createAgent({ id: agent.id, name: 'Reuse' }, ownerA)).toThrow();
  expect(() => db.prepare('INSERT INTO agents(id,name) VALUES(?,?)').run(agent.id, 'Old client reuse')).toThrow();
});

test('same preset installs independent private UUIDs and does not reuse anonymous legacy instances', async () => {
  const { store, ownership } = fixture();
  let actor: RemoteOwner | null = null;
  const manager = new AgentManager(store, async () => createExpertCatalogFixture(), () => actor);
  const preset = createExpertCatalogFixture().experts[0];
  const anonymous = (await manager.addPresetAgent(preset.id))!;
  actor = ownerA;
  expect((await manager.getPresetAgents()).some(item => item.id === preset.id)).toBe(true);
  const a = (await manager.addPresetAgent(preset.id))!;
  expect((await manager.addPresetAgent(preset.id))?.id).toBe(a.id);
  actor = ownerB;
  const b = (await manager.addPresetAgent(preset.id))!;
  expect(new Set([anonymous.id, a.id, b.id]).size).toBe(3);
  expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(a.presetId).toBe(preset.id);
  expect(ownership.get(a.id)?.owner).toEqual(ownerA);
  expect(manager.getAgent(a.id)).toBeNull();
  expect(() => manager.updateAgent(a.id, { enabled: false })).toThrow();
  expect(() => manager.reorderAgents([a.id])).toThrow();
  const captured = manager.captureOwner();
  actor = ownerA;
  expect(() => manager.assertCurrentOwner(captured)).toThrow();
});

test('catalog avatar updates retain ownership and leave other accounts unchanged', async () => {
  const { store, ownership } = fixture();
  let actor: RemoteOwner | null = ownerA;
  const catalog = createExpertCatalogFixture();
  const manager = new AgentManager(store, async () => catalog, () => actor);
  const a = (await manager.addPresetAgent(ExpertFixtureId.Data))!;
  actor = ownerB;
  const b = (await manager.addPresetAgent(ExpertFixtureId.Data))!;
  actor = ownerA;
  const icon = 'https://ydhardwarecommon.nosdn.127.net/category-research.webp';
  catalog.experts[0].icon = icon;

  await manager.getExpertCatalog();

  expect(store.getAgent(a.id)?.icon).toBe(icon);
  expect(ownership.get(a.id)?.owner).toEqual(ownerA);
  expect(ownership.get(a.id)?.ownerKind).toBe(AgentOwnerKind.Owned);
  expect(store.getAgent(b.id)).toEqual(b);
});

test.each(['catalog', 'installation'])('account changes during %s fetch prevent late writes', async operation => {
  const { store } = fixture();
  let actor: RemoteOwner | null = ownerA;
  const loadCatalog = vi.fn(async () => createExpertCatalogFixture());
  const manager = new AgentManager(store, loadCatalog, () => actor);
  await manager.addPresetAgent(ExpertFixtureId.Data);
  const before = store.listAgents();
  let resolveCatalog!: (catalog: ExpertCatalog) => void;
  loadCatalog.mockReturnValueOnce(new Promise(resolve => { resolveCatalog = resolve; }));
  const result = operation === 'catalog' ? manager.getExpertCatalog() : manager.addPresetAgent(ExpertFixtureId.App);
  actor = ownerB;
  const catalog = createExpertCatalogFixture();
  catalog.experts[0].icon = 'https://ydhardwarecommon.nosdn.127.net/category-research.webp';
  resolveCatalog(catalog);

  await expect(result).rejects.toMatchObject({ code: AgentAccessErrorCode.AccountChanged });
  expect(store.listAgents()).toEqual(before);
});

test('deletion rejects foreign or quarantined sessions before any database mutation', () => {
  const { db, store, ownership } = fixture();
  db.prepare("INSERT INTO cowork_sessions VALUES('foreign','legacy','idle','task',1,1)").run();
  store.remote.transaction(() => store.remote.assignNew('foreign', ownerB, 'local_create')); 
  expect(() => ownership.assertDeletable('legacy', ownerA)).toThrowError(expect.objectContaining({ code: AgentAccessErrorCode.ForeignSessions }));
  db.prepare("UPDATE cowork_session_ownership SET ownership_status='quarantined' WHERE session_id='foreign'").run();
  expect(() => ownership.assertDeletable('legacy', ownerB)).toThrow();
  expect(store.getAgent('legacy')).not.toBeNull();
  expect(db.prepare('SELECT 1 FROM cowork_sessions').get()).toBeTruthy();
});

test.each(['local', 'run', 'inbox', 'approval'])('deletion rejects %s in-flight evidence', kind => {
  const { db, store, ownership } = fixture();
  db.prepare("INSERT INTO cowork_sessions VALUES('task','legacy','idle','task',1,1)").run();
  if (kind === 'local') db.prepare("UPDATE cowork_sessions SET status='running'").run();
  if (kind === 'run') store.remote.put('run:task', { status: 'reconciling' });
  if (kind === 'inbox') store.remote.put('inbox:command', { localSessionId: 'task', state: 'unknown', command: { status: 'received' } });
  if (kind === 'approval') store.remote.put('approval:task:permission', { status: 'pending' });
  expect(() => ownership.assertDeletable('legacy', ownerA)).toThrowError(expect.objectContaining({ code: AgentAccessErrorCode.Busy }));
  expect(store.getAgent('legacy')).not.toBeNull();
});
