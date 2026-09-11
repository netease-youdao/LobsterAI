import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, expect, it, vi } from 'vitest';

import { AgentOwnerStore } from '../agentOwnership';
import { payloadHash } from './canonical';
import { RemoteAgentCatalog } from './remoteAgentCatalog';
import { RemoteStore } from './remoteStore';

const owner = { userId: '1001', scopeKey: 'personal' };
const other = { userId: '1002', scopeKey: 'personal' };
const dispose: Array<() => void> = [];
afterEach(() => { for (const cleanup of dispose.splice(0).reverse()) cleanup(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'remote-agent-catalog-'));
  const db = new Database(':memory:');
  dispose.push(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,icon TEXT,enabled INTEGER,created_at INTEGER,updated_at INTEGER);
    INSERT INTO agents VALUES('main','Main','',1,1,1),('anonymous','Shared','🤖',1,1,1);
    CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,agent_id TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db);
  const ownership = new AgentOwnerStore(db);
  for (const [id, actor] of [['mine', owner], ['other', other]] as const) ownership.transaction(() => {
    db.prepare('INSERT INTO agents VALUES(?,?,?,1,1,1)').run(id, id, 'https://private.invalid/icon');
    ownership.assignNew(id, actor);
  });
  const paths: Record<string, string> = { main: directory, mine: directory };
  const catalog = new RemoteAgentCatalog(store, ownership, agentId => ({ path: paths[agentId], name: 'Workspace' }));
  return { db, store, ownership, catalog, directory, paths };
}
it('publishes only main and the current owner, sanitizes icons, and keeps anonymous Agent session summaries', async () => {
  const { db, store, catalog } = fixture();
  store.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES('private','Task',1,1,'idle','anonymous')").run();
    store.assignNew('private', owner, 'local_create');
    db.prepare("INSERT INTO cowork_sessions VALUES('guest','Guest task',1,1,'idle','anonymous')").run();
  });
  const items = await catalog.refresh(owner, 'device', () => true);
  expect(items.map(item => item.agentId)).toEqual(['main', 'mine']);
  expect(items.find(item => item.agentId === 'mine')?.icon).toBeNull();
  expect(catalog.summary('private', owner)).toMatchObject({ agentId: 'anonymous', kind: 'anonymous', icon: '🤖' });
  expect(catalog.summary('private', other)).toBeNull();
  expect(catalog.summary('guest', owner)).toBeNull();
});

it('keeps main and unrelated agents while delaying a claimed Agent until admission', async () => {
  const { catalog, ownership, paths, directory } = fixture();
  ownership.transaction(() => ownership.associateHistorical('anonymous', owner, Date.now()));
  paths.anonymous = directory;
  const blocked = (id: string) => id !== 'anonymous';
  const first = await catalog.refresh(owner, 'device', () => true, blocked);
  expect(first.map(item => item.agentId)).toEqual(['main', 'mine']);
  const second = await catalog.refresh(owner, 'device', () => true);
  expect(second.map(item => item.agentId)).toEqual(['anonymous', 'main', 'mine']);
  expect(second[0].kind).toBe('owned');
});

it('does not rewrite an uncertain publication when its new context has not admitted an Agent', async () => {
  const { catalog, ownership, paths, directory, store } = fixture();
  ownership.transaction(() => ownership.associateHistorical('anonymous', owner, Date.now()));
  paths.anonymous = directory;
  const puts: unknown[] = [];
  const api = async (_path: string, method?: string, body?: unknown) => {
    if (method !== 'PUT') return { catalogVersion: '0', lastPublicationId: null, syncStatus: 'pending', items: [] };
    puts.push(body); throw new Error('Offline');
  };
  await expect(catalog.publish(owner, 'device', '1', api, () => true)).rejects.toThrow('Offline');
  const pending = store.entries<any>('agentCatalog:')[0].value.pending;
  await expect(catalog.publish(owner, 'device', '2', api, () => true, undefined, id => id !== 'anonymous')).rejects.toThrow('waiting for server support');
  expect(puts).toHaveLength(1);
  expect(store.entries<any>('agentCatalog:')[0].value.pending).toEqual(pending);
});
it('never repoints workspace aliases and rejects stale version or cross-account selection', async () => {
  const { catalog, ownership, paths, directory, store } = fixture();
  const first = (await catalog.refresh(owner, 'device', () => true)).find(item => item.agentId === 'mine')!;
  const secondDirectory = join(directory, 'next'); mkdirSync(secondDirectory); paths.mine = secondDirectory;
  const second = (await catalog.refresh(owner, 'device', () => true)).find(item => item.agentId === 'mine')!;
  expect(BigInt(second.version)).toBeGreaterThan(BigInt(first.version));
  expect(second.defaultWorkspaceId).not.toBe(first.defaultWorkspaceId);
  expect(() => catalog.resolve(owner, 'device', 'mine', first.version, first.defaultWorkspaceId!)).toThrow('AGENT_VERSION_CONFLICT');
  expect(() => catalog.resolve(other, 'device', 'mine', second.version, second.defaultWorkspaceId!)).toThrow('AGENT_UNAVAILABLE');
  expect(catalog.resolve(owner, 'device', 'mine', second.version, second.defaultWorkspaceId!)).toBe(secondDirectory);
  const saved = store.entries<Array<{ workspaceId: string; path: string }>>('agentWorkspaces:').flatMap(row => row.value);
  expect(saved.find(item => item.workspaceId === first.defaultWorkspaceId)?.path).toBe(directory);
  paths.mine = directory;
  const third = (await catalog.refresh(owner, 'device', () => true)).find(item => item.agentId === 'mine')!;
  expect(third.defaultWorkspaceId).not.toBe(first.defaultWorkspaceId);
  ownership.touch('mine');
  expect(() => catalog.resolve(owner, 'device', 'mine', third.version, third.defaultWorkspaceId!)).toThrow('AGENT_VERSION_CONFLICT');
});
it('persists publication before PUT and reconciles an uncertain commit across reconnect without reusing its body', async () => {
  const { catalog, store, ownership } = fixture();
  let current: any = { deviceId: 'device', catalogVersion: '0', lastPublicationId: null, syncStatus: 'pending', items: [] };
  const puts: any[] = [];
  let failAfterCommit = true;
  const api = async (_path: string, method?: string, body?: unknown) => {
    if (method !== 'PUT') return current;
    const publication = body as any; puts.push(publication);
    expect(store.entries<any>('agentCatalog:')[0].value.pending.publicationId).toBe(publication.publicationId);
    expect(publication.expectedCatalogVersion).toBe(current.catalogVersion);
    current = { ...current, catalogVersion: String(BigInt(current.catalogVersion) + 1n), lastPublicationId: publication.publicationId, syncStatus: 'ready', items: publication.items };
    if (failAfterCommit) { failAfterCommit = false; throw new Error('Response lost'); }
    return { deviceId: 'device', publicationId: publication.publicationId, catalogVersion: current.catalogVersion };
  };
  await expect(catalog.publish(owner, 'device', '1', api, () => true)).rejects.toThrow('Response lost');
  const firstHash = payloadHash(puts[0].items);
  ownership.touch('mine');
  await catalog.publish(owner, 'device', '2', api, () => true);
  expect(puts).toHaveLength(2);
  expect(puts[1].publicationId).not.toBe(puts[0].publicationId);
  expect(puts[1].expectedCatalogVersion).toBe('1');
  expect(puts[1].connectionGeneration).toBe('2');
  expect(payloadHash(puts[0].items)).toBe(firstHash);
  expect(store.entries<any>('agentCatalog:')[0].value.pending).toBeNull();
});
it('recovers the exact pending publication before applying new catalog limits', async () => {
  const { catalog, ownership } = fixture();
  const puts: any[] = [];
  const api = async (_path: string, method?: string, body?: unknown) => {
    if (method !== 'PUT') return { catalogVersion: '0', lastPublicationId: null, syncStatus: 'pending', items: [] };
    puts.push(body); throw new Error('Offline');
  };
  await expect(catalog.publish(owner, 'device', '1', api, () => true)).rejects.toThrow('Offline');
  ownership.touch('mine');
  await expect(catalog.publish(owner, 'device', '2', api, () => true)).rejects.toThrow('Offline');
  expect(puts[1]).toEqual({ ...puts[0], connectionGeneration: '2' });
  await expect(catalog.publish(owner, 'device', '3', api, () => true, { items: 1, bytes: 262144 })).rejects.toThrow('Offline');
  expect(puts[2]).toEqual({ ...puts[0], connectionGeneration: '3' });
});
it('refuses a new over-limit snapshot without leaving a pending publication', async () => {
  const { catalog, store } = fixture();
  const api = vi.fn(async () => ({ catalogVersion: '0', lastPublicationId: null, syncStatus: 'pending', items: [] }));
  await expect(catalog.publish(owner, 'device', '1', api, () => true, { items: 1, bytes: 262144 })).rejects.toThrow('PAYLOAD_TOO_LARGE');
  expect(api).toHaveBeenCalledTimes(1);
  expect(store.entries<any>('agentCatalog:').some(row => row.value.pending)).toBe(false);
});
it('adds summaries only after negotiation while preserving the bytes and hashes of already queued events', async () => {
  const { db, store, catalog } = fixture();
  store.setEnabledOwner(owner);
  store.transaction(() => { db.prepare("INSERT INTO cowork_sessions VALUES('session','Task',1,1,'idle','mine')").run(); store.assignNew('session', owner, 'local_create'); });
  const before = store.pending('session');
  expect(before.find(event => event.eventType === 'session.upsert')?.payload.session.agent).toBeUndefined();
  const beforeHash = payloadHash(before);
  store.setAgentSummaryResolver((id, actor) => catalog.summary(id, actor));
  store.transaction(() => undefined);
  const after = store.pending('session');
  expect(payloadHash(after.slice(0, before.length))).toBe(beforeHash);
  expect(after.at(-1)?.payload.session.agent).toMatchObject({ agentId: 'mine', kind: 'owned' });
  store.setAgentSummaryResolver(null);
  expect(payloadHash(store.pending('session'))).toBe(payloadHash(after));
});

it('renaming an Agent emits only its session summary without scanning existing messages', () => {
  const { db, store, ownership, catalog } = fixture();
  store.setEnabledOwner(owner); store.setAgentSummaryResolver((id, actor) => catalog.summary(id, actor));
  store.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES('session','Task',1,1,'idle','mine')").run(); store.assignNew('session', owner, 'local_create');
    db.prepare("INSERT INTO cowork_messages VALUES('message','session','user','Existing conversation',null,1,1)").run();
  });
  const before = store.pending('session');
  const read = vi.spyOn(db, 'prepare');
  store.transaction(() => ownership.transaction(() => db.prepare("UPDATE agents SET name='Renamed',updated_at=2 WHERE id='mine'").run()));
  expect(read.mock.calls.some(([sql]) => sql.includes('SELECT * FROM cowork_messages'))).toBe(false);
  const added = store.pending('session').slice(before.length);
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ eventType: 'session.upsert', payload: { session: { preview: 'Existing conversation', agent: { name: 'Renamed' } } } });
  read.mockRestore();
});
