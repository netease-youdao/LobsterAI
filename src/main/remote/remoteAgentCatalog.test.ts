import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, expect, it, vi } from 'vitest';

import { AgentAvatarSvg, encodeAgentAvatarIcon } from '../../shared/agent/avatar';
import type { RemoteAgentCatalogItem } from '../../shared/remote/constants';
import { AgentOwnerStore } from '../agentOwnership';
import { payloadHash } from './canonical';
import { RemoteAgentCatalog, RemoteAgentError } from './remoteAgentCatalog';
import { RemoteStore } from './remoteStore';

const Target = { First: 'space-a-generation-7', Second: 'space-b-generation-4' } as const;
const owner = { userId: '1001', scopeKey: 'personal' };
const other = { userId: '1002', scopeKey: 'personal' };
const dispose: Array<() => void> = [];
afterEach(() => { for (const cleanup of dispose.splice(0).reverse()) cleanup(); });
function fixture(getDefaultInput?: () => RemoteAgentCatalogItem['defaultInput'], getTargetId?: () => string | null, deferredProjection = false) {
  const directory = mkdtempSync(join(tmpdir(), 'remote-agent-catalog-'));
  const db = new Database(':memory:');
  dispose.push(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,icon TEXT,enabled INTEGER,created_at INTEGER,updated_at INTEGER);
    INSERT INTO agents VALUES('main','Main','',1,1,1),('anonymous','Shared','🤖',1,1,1);
    CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,agent_id TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection });
  const ownership = new AgentOwnerStore(db);
  for (const [id, actor] of [['mine', owner], ['other', other]] as const) ownership.transaction(() => {
    db.prepare('INSERT INTO agents VALUES(?,?,?,1,1,1)').run(id, id, 'https://private.invalid/icon');
    ownership.assignNew(id, actor);
  });
  const paths: Record<string, string> = { main: directory, mine: directory };
  const catalog = new RemoteAgentCatalog(store, ownership, agentId => ({ path: paths[agentId], name: 'Workspace' }), getDefaultInput, getTargetId);
  return { db, store, ownership, catalog, directory, paths };
}
it('does not resolve or publish workspace references before a target is known', async () => {
  const { catalog, store } = fixture(undefined, () => null);
  await expect(catalog.refresh(owner, 'device', () => true)).rejects.toThrow('Remote target is not ready');
  const api = vi.fn();
  await expect(catalog.publish(owner, 'device', '1', api, () => true)).rejects.toThrow('Remote target is not ready');
  expect(api).not.toHaveBeenCalled();
  expect(store.entries('agentWorkspaces:')).toEqual([]);
});
it('rejects a stale route response even when the verified target stays the same', async () => {
  const { catalog, store } = fixture(undefined, () => Target.First);
  const before = await catalog.refresh(owner, 'device', () => true);
  let finish!: (value: unknown) => void;
  const pending = catalog.publish(owner, 'device', '1', () => new Promise(resolve => { finish = resolve; }), () => true);
  catalog.reset();
  finish({ catalogVersion: '9', items: [] });
  await expect(pending).rejects.toThrow('Account changed');
  expect(store.entries('agentCatalog:')).toEqual([]);
  expect(await catalog.refresh(owner, 'device', () => true)).toEqual(before);
});
it('does not save resolved workspaces after the route is invalidated during lookup', async () => {
  const { store, ownership, directory } = fixture();
  let finish!: (value: { path: string; name: string }) => void;
  const catalog = new RemoteAgentCatalog(store, ownership, () => new Promise(resolve => { finish = resolve; }), undefined, () => Target.First);
  const pending = catalog.refresh(owner, 'device', () => true);
  catalog.reset();
  finish({ path: directory, name: 'Workspace' });
  await expect(pending).rejects.toThrow('Account changed');
  expect(store.entries('agentWorkspaces:')).toEqual([]);
});
it('isolates workspace aliases when the same account and device use different targets', async () => {
  let targetId: string | null = Target.First;
  const { catalog, directory } = fixture(undefined, () => targetId);
  const first = (await catalog.refresh(owner, 'device', () => true)).find(item => item.agentId === 'mine')!;
  targetId = Target.Second;
  const second = (await catalog.refresh(owner, 'device', () => true)).find(item => item.agentId === 'mine')!;
  expect(second.defaultWorkspaceId).not.toBe(first.defaultWorkspaceId);
  expect(() => catalog.resolve(owner, 'device', 'mine', second.version, first.defaultWorkspaceId!)).toThrow('AGENT_UNAVAILABLE');
  targetId = Target.First;
  expect(catalog.resolve(owner, 'device', 'mine', first.version, first.defaultWorkspaceId!)).toBe(directory);
});
it('does not retain a publication receipt received in another target', async () => {
  let targetId: string | null = Target.First;
  const { catalog, store } = fixture(undefined, () => targetId);
  let finish!: (value: unknown) => void;
  const pending = catalog.publish(owner, 'device', '1', () => new Promise(resolve => { finish = resolve; }), () => true);
  targetId = Target.Second;
  finish({ catalogVersion: '9', items: [] });
  await expect(pending).rejects.toThrow('Account changed');
  expect(store.entries('agentCatalog:')).toEqual([]);
});
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

it('defers message scans while renaming an Agent and projects only the changed session summary', () => {
  const { db, store, ownership, catalog } = fixture(undefined, undefined, true);
  store.setEnabledOwner(owner); store.setAgentSummaryResolver((id, actor) => catalog.summary(id, actor));
  store.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES('session','Task',1,1,'idle','mine')").run(); store.assignNew('session', owner, 'local_create');
    db.prepare("INSERT INTO cowork_messages VALUES('message','session','user','Existing conversation',null,1,1)").run();
  });
  store.projectIsolatedForTest('session');
  const before = store.pending('session');
  const revision = store.projectionRevision('session');
  const read = vi.spyOn(db, 'prepare');
  store.transaction(() => ownership.transaction(() => db.prepare("UPDATE agents SET name='Renamed',updated_at=2 WHERE id='mine'").run()));
  expect(read.mock.calls.some(([sql]) => sql.includes('SELECT * FROM cowork_messages'))).toBe(false);
  expect(store.projectionRevision('session')).toBeGreaterThan(revision);
  expect(store.pending('session')).toEqual(before);
  // Model the isolated projection turn after the foreground write has returned.
  store.projectIsolatedForTest('session');
  const added = store.pending('session').slice(before.length);
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ eventType: 'session.upsert', payload: { session: { preview: 'Existing conversation', agent: { name: 'Renamed' } } } });
  read.mockRestore();
});


it('advances the Agent version when default model or thinking settings change and keeps unchanged refreshes stable', async () => {
  let defaults: RemoteAgentCatalogItem['defaultInput'] = { modelRef: null, modelVersion: null, thinkingLevel: null };
  const { catalog } = fixture(() => defaults);
  const first = await catalog.refresh(owner, 'device', () => true);
  defaults = { modelRef: 'model', modelVersion: '2', thinkingLevel: 'high' };
  const changed = await catalog.refresh(owner, 'device', () => true);
  expect(BigInt(changed[0].version)).toBe(BigInt(first[0].version) + 1n);
  expect(changed[0].defaultInput).toEqual(defaults);
  expect(await catalog.refresh(owner, 'device', () => true)).toEqual(changed);
  defaults = { ...defaults, thinkingLevel: 'low' };
  const thinkingChanged = await catalog.refresh(owner, 'device', () => true);
  expect(BigInt(thinkingChanged[0].version)).toBe(BigInt(changed[0].version) + 1n);
});

it('migrates the old workspace-only fingerprint once before publishing default input', async () => {
  const { catalog, store, ownership, directory } = fixture(() => ({ modelRef: 'model', modelVersion: '2', thinkingLevel: 'high' }));
  store.put('agentWorkspaceState:main', payloadHash({ path: directory, available: true }));
  const before = ownership.get('main')!.version;
  const first = await catalog.refresh(owner, 'device', () => true);
  expect(BigInt(first[0].version)).toBe(BigInt(before) + 1n);
  expect(await catalog.refresh(owner, 'device', () => true)).toEqual(first);
});

async function rejectedPublicationFixture() {
  let defaults: RemoteAgentCatalogItem['defaultInput'] = { modelRef: null, modelVersion: null, thinkingLevel: null };
  const data = fixture(() => defaults);
  const server = { current: { deviceId: 'device', catalogVersion: '0', lastPublicationId: null as string | null,
    syncStatus: 'pending', items: [] as RemoteAgentCatalogItem[] }, puts: [] as any[] };
  const api = vi.fn(async (_path: string, method?: string, body?: any) => {
    if (method !== 'PUT') return structuredClone(server.current);
    server.puts.push(structuredClone(body));
    for (const item of body.items as RemoteAgentCatalogItem[]) {
      const before = server.current.items.find(value => value.agentId === item.agentId);
      if (before && (before.kind !== item.kind || BigInt(item.version) < BigInt(before.version)
        || item.version === before.version && payloadHash(item) !== payloadHash(before))) {
        throw new RemoteAgentError(47029, 'AGENT_VERSION_CONFLICT', 'VERSION_REUSED');
      }
    }
    server.current = { ...server.current, catalogVersion: String(BigInt(server.current.catalogVersion) + 1n),
      lastPublicationId: body.publicationId, syncStatus: 'ready', items: body.items };
    return { deviceId: 'device', publicationId: body.publicationId, catalogVersion: server.current.catalogVersion };
  });
  await data.catalog.publish(owner, 'device', '1', api, () => true);
  defaults = { modelRef: 'model', modelVersion: '2', thinkingLevel: 'high' };
  const entry = data.store.entries<any>('agentCatalog:')[0];
  const pending = { publicationId: 'legacy-publication', expectedCatalogVersion: entry.value.catalogVersion,
    items: entry.value.syncedItems.map((item: RemoteAgentCatalogItem) => ({ ...item, defaultInput: defaults })) };
  data.store.put(entry.key, { ...entry.value, pending });
  return { ...data, server, api, pending, key: entry.key };
}

it('retires a definitively rejected same-version publication and publishes fresh versions with a new immutable ID', async () => {
  const { catalog, store, api, pending, key, server } = await rejectedPublicationFixture();
  const original = structuredClone(pending);
  await expect(catalog.publish(owner, 'device', '2', api, () => true)).rejects.toThrow('AGENT_VERSION_CONFLICT');
  expect(store.get<any>(key).pending).toBeNull();
  expect(server.current.catalogVersion).toBe('1');
  await catalog.publish(owner, 'device', '2', api, () => true);
  expect(server.puts).toHaveLength(3);
  expect(server.puts[1]).toEqual({ ...original, connectionGeneration: '2' });
  expect(server.puts[2].publicationId).not.toBe(original.publicationId);
  expect(server.puts[2].expectedCatalogVersion).toBe('1');
  expect(BigInt(server.puts[2].items[0].version)).toBeGreaterThan(BigInt(original.items[0].version));
  expect(server.puts[2].items[0].defaultInput).toEqual(original.items[0].defaultInput);
  expect(store.get<any>(key).pending).toBeNull();
  expect(catalog.isSynced(owner, 'device', 'main')).toBe(true);
});

it.each(['identity', 'rollback'] as const)('does not repair a rejected publication with a server %s conflict', async conflict => {
  const { catalog, store, api, pending, key, server, ownership } = await rejectedPublicationFixture();
  const main = server.current.items[0];
  if (conflict === 'identity') main.kind = 'owned';
  else main.version = String(BigInt(main.version) + 1n);
  const before = ownership.get('main')!.version;
  await expect(catalog.publish(owner, 'device', '2', api, () => true)).rejects.toThrow('AGENT_VERSION_CONFLICT');
  expect(store.get<any>(key).pending).toEqual(pending);
  expect(ownership.get('main')!.version).toBe(before);
});

it('keeps the rejected publication when the confirming GET fails or the account changes', async () => {
  const { catalog, store, api, pending, key, ownership } = await rejectedPublicationFixture();
  const before = ownership.get('main')!.version;
  let gets = 0;
  const offline = async (path: string, method?: string, body?: any) => {
    if (method !== 'PUT' && ++gets === 2) throw new Error('Offline');
    return api(path, method, body);
  };
  await expect(catalog.publish(owner, 'device', '2', offline, () => true)).rejects.toThrow('Offline');
  expect(store.get<any>(key).pending).toEqual(pending);
  let current = true; gets = 0;
  const switched = async (path: string, method?: string, body?: any) => {
    if (method !== 'PUT' && ++gets === 2) current = false;
    return api(path, method, body);
  };
  await expect(catalog.publish(owner, 'device', '2', switched, () => current)).rejects.toThrow('Account changed');
  expect(store.get<any>(key).pending).toEqual(pending);
  expect(ownership.get('main')!.version).toBe(before);
});

it('keeps legacy icons until icon key capability is configured, then migrates each changed summary once', async () => {
  const { db, store, ownership, catalog } = fixture();
  ownership.transaction(() => db.prepare("UPDATE agents SET icon='agent-avatar-svg:code' WHERE id='mine'").run());
  store.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES('session','Task',1,1,'idle','mine')").run();
    store.assignNew('session', owner, 'local_create');
  });
  const legacy = catalog.summary('session', owner)!;
  const revision = store.projectionRevision('session');
  expect(legacy.icon).toBeNull();
  catalog.configureIconKeys(owner, true);
  const summary = catalog.summary('session', owner)!;
  expect(summary.icon).toBe('agent-avatar-svg:code');
  expect(BigInt(summary.version)).toBe(BigInt(legacy.version) + 1n);
  expect(store.projectionRevision('session')).toBeGreaterThan(revision);
  expect((await catalog.refresh(owner, 'device', () => true)).find(item => item.agentId === 'mine')).toMatchObject(summaryWithoutState(summary));
  catalog.configureIconKeys(owner, true);
  expect(catalog.summary('session', owner)).toEqual(summary);
  catalog.reset();
  expect(catalog.summary('session', owner)).toEqual(summary);
  expect(ownership.get('mine')?.version).toBe(summary.version);
  catalog.configureIconKeys(owner, true);
  expect(catalog.summary('session', owner)).toEqual(summary);
});

function summaryWithoutState(summary: { agentId: string; icon: string | null; version: string }) {
  return { agentId: summary.agentId, icon: summary.icon, version: summary.version };
}

it('migrates an uncached built-in icon once and preserves emoji, simple identifiers and unsafe fallbacks', async () => {
  const { db, ownership, catalog } = fixture();
  ownership.transaction(() => db.prepare("UPDATE agents SET icon='agent-avatar-svg:lobster' WHERE id='main'").run());
  const before = ownership.get('main')!.version;
  catalog.configureIconKeys(owner, true);
  expect(BigInt(ownership.get('main')!.version)).toBe(BigInt(before) + 1n);
  for (const [icon, expected] of [
    ['agent-avatar-svg:document', 'agent-avatar-svg:document'], ['agent-avatar-svg:future', null],
    ['agent-avatar-svg:../code', null], [' agent-avatar-svg:code', null], ['agent-avatar-svg:code\n', null],
    ['https://shared.ydstatic.com/expert.webp', null], ['data:image/svg+xml,<svg/>', null],
    ['🤖', '🤖'], ['robot', 'robot'], ['', null],
  ] as const) {
    ownership.transaction(() => db.prepare("UPDATE agents SET icon=? WHERE id='main'").run(icon));
    const sourceVersion = ownership.get('main')!.version;
    expect((await catalog.refresh(owner, 'device', () => true)).find(item => item.agentId === 'main')?.icon).toBe(expected);
    expect(ownership.get('main')!.version).toBe(sourceVersion);
  }
});

it('uses higher Agent versions when capability projection changes, without changing identity or workspace', async () => {
  const { db, ownership, catalog } = fixture();
  ownership.transaction(() => db.prepare("UPDATE agents SET icon='agent-avatar-svg:code' WHERE id='mine'").run());
  catalog.configureIconKeys(owner, true);
  const first = (await catalog.refresh(owner, 'device', () => true)).find(item => item.agentId === 'mine')!;
  catalog.configureIconKeys(owner, false);
  const second = (await catalog.refresh(owner, 'device', () => true)).find(item => item.agentId === 'mine')!;
  expect(second).toMatchObject({ agentId: first.agentId, icon: null, defaultWorkspaceId: first.defaultWorkspaceId });
  expect(BigInt(second.version)).toBe(BigInt(first.version) + 1n);
  catalog.configureIconKeys(owner, true);
  const third = (await catalog.refresh(owner, 'device', () => true)).find(item => item.agentId === 'mine')!;
  expect(third.icon).toBe(first.icon);
  expect(BigInt(third.version)).toBe(BigInt(second.version) + 1n);
});

it.each([false, true])('keeps an immutable publication through capability changes (previous support: %s)', async initialSupport => {
  const { db, ownership, catalog, store } = fixture();
  ownership.transaction(() => db.prepare("UPDATE agents SET icon='agent-avatar-svg:code' WHERE id='mine'").run());
  catalog.configureIconKeys(owner, initialSupport);
  let current: any = { deviceId: 'device', catalogVersion: '0', lastPublicationId: null, syncStatus: 'pending', items: [] };
  const puts: any[] = [];
  let fail = true;
  const api = async (_path: string, method?: string, body?: any) => {
    if (method !== 'PUT') return current;
    puts.push(structuredClone(body));
    if (fail) { fail = false; throw new Error('Offline'); }
    current = { ...current, catalogVersion: String(BigInt(current.catalogVersion) + 1n), lastPublicationId: body.publicationId, syncStatus: 'ready', items: body.items };
    return { deviceId: 'device', catalogVersion: current.catalogVersion, publicationId: body.publicationId };
  };
  await expect(catalog.publish(owner, 'device', '1', api, () => true)).rejects.toThrow('Offline');
  const pending = structuredClone(store.entries<any>('agentCatalog:')[0].value.pending);
  catalog.configureIconKeys(owner, !initialSupport);
  expect(store.entries<any>('agentCatalog:')[0].value.pending).toEqual(pending);
  await catalog.publish(owner, 'device', '2', api, () => true);
  expect(puts[1]).toEqual({ ...puts[0], connectionGeneration: '2' });
  await catalog.publish(owner, 'device', '2', api, () => true);
  expect(puts[2].publicationId).not.toBe(pending.publicationId);
  expect(puts[2].items.find((item: RemoteAgentCatalogItem) => item.agentId === 'mine')).toMatchObject({ icon: initialSupport ? null : 'agent-avatar-svg:code' });
});

it('retains and versions known tombstone icons without restoring deleted Agent execution access', () => {
  const { db, store, ownership, catalog } = fixture();
  ownership.transaction(() => db.prepare("UPDATE agents SET icon='agent-avatar-svg:code' WHERE id='mine'").run());
  store.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES('session','Task',1,1,'idle','mine')").run();
    store.assignNew('session', owner, 'local_create');
  });
  catalog.configureIconKeys(owner, true);
  ownership.transaction(() => db.prepare("DELETE FROM agents WHERE id='mine'").run());
  const removed = catalog.summary('session', owner)!;
  const deletedAt = ownership.get('mine')!.deletedAt;
  expect(removed).toMatchObject({ icon: 'agent-avatar-svg:code', state: 'deleted' });
  catalog.configureIconKeys(owner, false);
  const legacy = catalog.summary('session', owner)!;
  expect(legacy).toMatchObject({ icon: null, state: 'deleted' });
  expect(BigInt(legacy.version)).toBe(BigInt(removed.version) + 1n);
  expect(ownership.get('mine')!.deletedAt).toBe(deletedAt);
  expect(ownership.canPublish('mine', owner)).toBe(false);
  catalog.configureIconKeys(owner, true);
  const restoredDisplay = catalog.summary('session', owner)!;
  expect(restoredDisplay).toMatchObject({ icon: 'agent-avatar-svg:code', state: 'deleted' });
  expect(BigInt(restoredDisplay.version)).toBe(BigInt(legacy.version) + 1n);
  expect(ownership.canView('mine', owner)).toBe(false);
});


it('advances past a newer legacy summary even when an older icon projection already exists', async () => {
  const { db, store, ownership, catalog } = fixture();
  ownership.transaction(() => db.prepare("UPDATE agents SET icon='agent-avatar-svg:code' WHERE id='mine'").run());
  catalog.configureIconKeys(owner, false);
  const old = store.get<any>('agentSummary:mine');
  // An older desktop binary edits and publishes this version without updating the new projection record.
  ownership.transaction(() => db.prepare("UPDATE agents SET name='Renamed' WHERE id='mine'").run());
  const legacyVersion = ownership.get('mine')!.version;
  store.put('agentSummary:mine', { ...old, name: 'Renamed', version: legacyVersion });
  catalog.reset();
  catalog.configureIconKeys(owner, true);
  const item = (await catalog.refresh(owner, 'device', () => true)).find(item => item.agentId === 'mine')!;
  expect(item).toMatchObject({ name: 'Renamed', icon: 'agent-avatar-svg:code' });
  expect(BigInt(item.version)).toBe(BigInt(legacyVersion) + 1n);
});

it('does not restore a stale tombstone source after an older desktop changed the avatar', () => {
  const { db, store, ownership, catalog } = fixture();
  ownership.transaction(() => db.prepare("UPDATE agents SET icon='agent-avatar-svg:code' WHERE id='mine'").run());
  store.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES('session','Task',1,1,'idle','mine')").run();
    store.assignNew('session', owner, 'local_create');
  });
  catalog.configureIconKeys(owner, true);
  const old = catalog.summary('session', owner)!;
  ownership.transaction(() => db.prepare("UPDATE agents SET icon='https://shared.ydstatic.com/expert.webp' WHERE id='mine'").run());
  store.put('agentSummary:mine', { ...old, icon: null, version: ownership.get('mine')!.version });
  ownership.transaction(() => db.prepare("DELETE FROM agents WHERE id='mine'").run());
  catalog.reset();
  catalog.configureIconKeys(owner, true);
  expect(catalog.summary('session', owner)).toMatchObject({ icon: null, state: 'deleted' });
});

it('isolates confirmed icon modes by target and actor while preserving monotonic display versions', async () => {
  let targetId = Target.First as string;
  const { db, store, ownership, catalog } = fixture(undefined, () => targetId);
  ownership.transaction(() => db.prepare("UPDATE agents SET icon='agent-avatar-svg:code' WHERE id='mine'").run());
  store.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES('session','Task',1,1,'idle','mine')").run();
    store.assignNew('session', owner, 'local_create');
  });
  catalog.configureIconKeys(owner, true);
  const first = catalog.summary('session', owner)!;
  catalog.reset(); targetId = Target.Second;
  // Negotiation is still unknown: preserve existing display instead of writing null at the same version.
  expect(catalog.summary('session', owner)).toEqual(first);
  catalog.configureIconKeys(owner, false);
  const second = catalog.summary('session', owner)!;
  expect(second.icon).toBeNull();
  expect(BigInt(second.version)).toBe(BigInt(first.version) + 1n);
  catalog.reset(); targetId = Target.First;
  catalog.configureIconKeys(owner, true);
  const third = catalog.summary('session', owner)!;
  expect(third.icon).toBe(first.icon);
  expect(BigInt(third.version)).toBe(BigInt(second.version) + 1n);
  const projections = store.entries<any>('agentIconProjection:').filter(entry => entry.key.includes('mine'));
  expect(projections).toHaveLength(2);
  catalog.reset(); catalog.configureIconKeys(other, false);
  expect(catalog.summary('session', other)).toBeNull();
  expect(ownership.get('mine')!.version).toBe(third.version);
  expect(store.entries<any>('agentIconProjection:').filter(entry => entry.key.includes('mine'))).toEqual(projections);
});

it.each(Object.values(AgentAvatarSvg))('publishes negotiated %s for catalogs and session summaries without changing the local avatar', async svg => {
  const { db, store, ownership, catalog } = fixture();
  const localIcon = encodeAgentAvatarIcon({ svg });
  ownership.transaction(() => db.prepare('UPDATE agents SET icon = ? WHERE id = ?').run(localIcon, 'mine'));
  store.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES('avatar-session','Task',1,1,'idle','mine')").run();
    store.assignNew('avatar-session', owner, 'local_create');
  });
  catalog.configureIconKeys(owner, true);
  const items = await catalog.refresh(owner, 'device', () => true);
  const wireIcon = localIcon;
  expect(items.find(item => item.agentId === 'mine')?.icon).toBe(wireIcon);
  expect(catalog.summary('avatar-session', owner)?.icon).toBe(wireIcon);
  expect(wireIcon).toBe(`agent-avatar-svg:${svg}`);
  expect(Buffer.byteLength(wireIcon)).toBeLessThanOrEqual(128);
  expect(db.prepare('SELECT icon FROM agents WHERE id = ?').get('mine')).toEqual({ icon: localIcon });
});

it.each([
  ['agent-avatar-svg_code', 'agent-avatar-svg_code'],
  ['legacy-icon', 'legacy-icon'],
  ['🤖', '🤖'],
  ['', null],
  ['agent-avatar-svg:unknown', null],
  ['agent-avatar-svg:code:extra', null],
  ['https://example.com/avatar.svg', null],
  ['data:image/svg+xml,<svg/>', null],
  ['a'.repeat(129), null],
])('preserves remote icon validation for %s', async (icon, expected) => {
  const { db, ownership, catalog } = fixture();
  ownership.transaction(() => db.prepare('UPDATE agents SET icon = ? WHERE id = ?').run(icon, 'mine'));
  const items = await catalog.refresh(owner, 'device', () => true);
  expect(items.find(item => item.agentId === 'mine')?.icon).toBe(expected);
});
