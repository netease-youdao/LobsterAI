import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, expect, it, vi } from 'vitest';

import { AgentId } from '../../shared/agent/constants';
import type { RemoteAgentCatalogItem } from '../../shared/remote/constants';
import type { RemoteSyncTargetIdentity } from '../../shared/remote/syncTarget';
import { AgentOwnerStore } from '../agentOwnership';
import { RemoteAgentCatalog } from './remoteAgentCatalog';
import { RemoteStore } from './remoteStore';
import { RemoteSyncTargetStore } from './remoteSyncTargetStore';

const owner = { userId: '10001', scopeKey: 'personal' };
const testSpace: RemoteSyncTargetIdentity = { version: 1, dataSpaceId: 'test-space', dataGeneration: '1' };
const productionSpace: RemoteSyncTargetIdentity = { ...testSpace, dataSpaceId: 'production-space' };
const dispose: Array<() => void> = [];
afterEach(() => { for (const cleanup of dispose.splice(0).reverse()) cleanup(); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'remote-catalog-origin-'));
  const db = new Database(':memory:');
  dispose.push(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,icon TEXT,enabled INTEGER,created_at INTEGER,updated_at INTEGER);
    INSERT INTO agents VALUES('main','Main','',1,1,1);
    CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,agent_id TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false });
  const ownership = new AgentOwnerStore(db);
  let route = 'https://test.example', targetId: string | null = null;
  store.publicationOrigins.setRouteProvider(() => route);
  ownership.publicationOrigins.setRouteProvider(() => route);
  ownership.transaction(() => {
    db.prepare("INSERT INTO agents VALUES('test-agent','Test Agent','',1,1,1)").run();
    ownership.assignNew('test-agent', owner);
  });
  const targets = new RemoteSyncTargetStore(store);
  const activate = (target: RemoteSyncTargetIdentity, nextRoute: string, deviceId: string) => {
    route = nextRoute;
    store.publicationOrigins.confirm(owner, route, target);
    const active = targets.activate({ owner, deviceId, syncTarget: target, bootstrap: true, allowPartialLegacy: true });
    targetId = active.targetId;
    store.setProjectionIdentity(targetId, owner, deviceId);
    return targetId;
  };
  const catalog = new RemoteAgentCatalog(store, ownership, () => ({ path: directory, name: 'Workspace' }), undefined, () => targetId);
  const activateLegacy = () => {
    const active = targets.activateLegacy({ owner, deviceId: 'test-pc', allowPartialLegacy: true });
    targetId = active.targetId;
    store.publicationOrigins.confirm(owner, route, null, targetId);
  };
  return { db, store, catalog, activate, activateLegacy };
}

it('keeps a test-created Agent out of production while publishing the default Agent', async () => {
  const f = fixture();
  f.activate(testSpace, 'https://test.example', 'test-pc');
  const original = await f.catalog.refresh(owner, 'test-pc', () => true);
  expect(original.map(item => item.agentId)).toEqual([AgentId.Main, 'test-agent']);
  const selected = original.find(item => item.agentId === 'test-agent')!;
  f.activate(productionSpace, 'https://production.example', 'production-pc');
  expect((await f.catalog.refresh(owner, 'production-pc', () => true)).map(item => item.agentId)).toEqual([AgentId.Main]);
  expect(() => f.catalog.resolve(owner, 'production-pc', selected.agentId, selected.version, selected.defaultWorkspaceId!)).toThrow();
  f.activate(testSpace, 'https://test.example', 'test-pc');
  expect((await f.catalog.refresh(owner, 'test-pc', () => true)).map(item => item.agentId)).toEqual([AgentId.Main, 'test-agent']);
});

it('does not resend or rewrite a pre-fix pending production catalog containing a foreign Agent', async () => {
  const f = fixture();
  f.activate(testSpace, 'https://test.example', 'test-pc');
  const items = await f.catalog.refresh(owner, 'test-pc', () => true);
  const productionTarget = f.activate(productionSpace, 'https://production.example', 'production-pc');
  const key = `agentCatalog:${JSON.stringify([productionTarget, owner.userId, owner.scopeKey, 'production-pc'])}`;
  const state = { catalogVersion: '0', syncedHash: null, pending: { publicationId: 'old-production-publication', expectedCatalogVersion: '0', items } };
  f.store.put(key, state);
  const api = vi.fn(async () => ({ deviceId: 'production-pc', catalogVersion: '0', lastPublicationId: null, syncStatus: 'pending', items: [] }));
  await expect(f.catalog.publish(owner, 'production-pc', '1', api, () => true)).rejects.toThrow();
  expect(api.mock.calls).toHaveLength(1);
  expect(f.store.get(key)).toEqual(state);
});


it.each([false, true])('requires the original catalog item proof before upgrading a legacy Agent source (mismatch: %s)', async mismatch => {
  const f = fixture(); f.activateLegacy();
  let items: RemoteAgentCatalogItem[] = [], version = '0', lastPublicationId: string | null = null;
  const api = vi.fn(async (_path: string, method?: string, body?: unknown) => {
    if (method === 'PUT') {
      const publication = body as { publicationId: string; items: RemoteAgentCatalogItem[] };
      items = publication.items; version = String(Number(version) + 1); lastPublicationId = publication.publicationId;
      return { deviceId: 'test-pc', publicationId: lastPublicationId, catalogVersion: version };
    }
    return { deviceId: 'test-pc', catalogVersion: version, lastPublicationId, syncStatus: 'ready', items };
  });
  await f.catalog.publish(owner, 'test-pc', '1', api, () => true);
  expect(items.map(item => item.agentId)).toEqual([AgentId.Main, 'test-agent']);
  f.activate(testSpace, 'https://test.example', 'test-pc');
  if (mismatch) items = items.map(item => item.agentId === 'test-agent' ? { ...item, name: 'Unproved replacement' } : item);
  await f.catalog.publish(owner, 'test-pc', '2', api, () => true);
  const current = await f.catalog.refresh(owner, 'test-pc', () => true);
  expect(current.some(item => item.agentId === 'test-agent')).toBe(!mismatch);
});


it.each([false, true])('recovers pre-target catalogs and reprojects old tasks once (existing empty origin: %s)', async emptyOrigin => {
  const f = fixture();
  f.activate(testSpace, 'https://test.example', 'test-pc');
  const original = await f.catalog.refresh(owner, 'test-pc', () => true);
  f.store.put(`agentCatalog:${JSON.stringify([owner.userId, owner.scopeKey, 'test-pc'])}`,
    { catalogVersion: '5', syncedItems: original, pending: null });
  f.store.transaction(() => {
    f.db.prepare("INSERT INTO cowork_sessions VALUES('old-task','Task',1,1,'completed','test-agent')").run();
    f.store.assignNew('old-task', owner, 'local_create');
  });
  if (emptyOrigin) f.db.prepare("UPDATE remote_publication_origins SET route=NULL,data_space_id=NULL WHERE kind='agent' AND local_id='test-agent'").run();
  else f.db.prepare("DELETE FROM remote_publication_origins WHERE kind='agent' AND local_id='test-agent'").run();
  f.store.setEnabledOwner(owner);
  f.store.setAgentSummaryResolver((id, actor) => f.catalog.summary(id, actor));
  f.store.projectIsolatedForTest('old-task');
  const queued = f.store.pending('old-task');
  expect(queued.at(-1)?.payload.session?.agent).toBeNull();
  const revision = () => (f.db.prepare("SELECT revision FROM remote_session_revisions WHERE session_id='old-task'").get() as { revision: number }).revision;
  const before = revision();
  expect(f.catalog.summary('old-task', owner)).toBeNull();
  f.store.publicationOrigins.inferLegacy(owner);
  expect((await f.catalog.refresh(owner, 'test-pc', () => true)).map(item => item.agentId)).toEqual(['main', 'test-agent']);
  expect(f.catalog.summary('old-task', owner)?.agentId).toBe('test-agent');
  expect(revision()).toBe(before + 1);
  f.store.publicationOrigins.inferLegacy(owner);
  expect(revision()).toBe(before + 1);
  f.store.projectIsolatedForTest('old-task');
  const after = f.store.pending('old-task');
  expect(after.slice(0, queued.length)).toEqual(queued);
  expect(after.slice(queued.length).filter(event => event.eventType === 'session.upsert')).toHaveLength(1);
  expect(after.at(-1)?.payload.session?.agent?.agentId).toBe('test-agent');
  f.activate(productionSpace, 'https://production.example', 'production-pc');
  expect((await f.catalog.refresh(owner, 'production-pc', () => true)).map(item => item.agentId)).toEqual(['main']);
});

it.each(['ambiguous', 'unknown-device', 'foreign-owner', 'explicit-foreign', 'conflict'])('does not guess legacy Agent origin: %s', async reason => {
  const f = fixture();
  f.activate(testSpace, 'https://test.example', 'test-pc');
  const original = await f.catalog.refresh(owner, 'test-pc', () => true);
  const oldOwner = reason === 'foreign-owner' ? 'another-owner' : owner.userId;
  const oldDevice = reason === 'unknown-device' ? 'unregistered-pc' : 'test-pc';
  f.store.put(`agentCatalog:${JSON.stringify([oldOwner, owner.scopeKey, oldDevice])}`,
    { catalogVersion: '5', syncedItems: original, pending: null });
  f.db.prepare("UPDATE remote_publication_origins SET route=NULL,data_space_id=NULL WHERE kind='agent' AND local_id='test-agent'").run();
  if (reason === 'ambiguous') new RemoteSyncTargetStore(f.store).activate({ owner, deviceId: 'test-pc', syncTarget: productionSpace, bootstrap: true, allowPartialLegacy: true });
  if (reason === 'conflict') {
    const target = new RemoteSyncTargetStore(f.store).activate({ owner, deviceId: 'production-pc', syncTarget: productionSpace, bootstrap: true, allowPartialLegacy: true }).targetId;
    f.store.put(`agentCatalog:${JSON.stringify([target, owner.userId, owner.scopeKey, 'production-pc'])}`,
      { catalogVersion: '5', syncedItems: original, pending: null });
  }
  if (reason === 'explicit-foreign') f.db.prepare("UPDATE remote_publication_origins SET data_space_id='other-space' WHERE kind='agent' AND local_id='test-agent'").run();
  if (reason !== 'explicit-foreign') f.db.prepare("UPDATE remote_publication_origins SET route=NULL,data_space_id=NULL WHERE kind='agent' AND local_id='test-agent'").run();
  f.store.publicationOrigins.inferLegacy(owner);
  const origin = f.db.prepare("SELECT data_space_id FROM remote_publication_origins WHERE kind='agent' AND local_id='test-agent'").get() as { data_space_id: string | null };
  expect(origin.data_space_id).toBe(reason === 'explicit-foreign' ? 'other-space' : null);
});


it('retries pre-target migration after device registration becomes available', async () => {
  const f = fixture();
  f.activate(testSpace, 'https://test.example', 'test-pc');
  const items = await f.catalog.refresh(owner, 'test-pc', () => true);
  f.store.put(`agentCatalog:${JSON.stringify([owner.userId, owner.scopeKey, 'late-pc'])}`,
    { catalogVersion: '5', syncedItems: items, pending: null });
  f.db.prepare("DELETE FROM remote_publication_origins WHERE kind='agent' AND local_id='test-agent'").run();
  f.store.publicationOrigins.inferLegacy(owner);
  expect((await f.catalog.refresh(owner, 'test-pc', () => true)).map(item => item.agentId)).toEqual(['main']);
  f.activate(productionSpace, 'https://production.example', 'late-pc');
  f.store.publicationOrigins.inferLegacy(owner);
  expect((await f.catalog.refresh(owner, 'late-pc', () => true)).map(item => item.agentId)).toEqual(['main', 'test-agent']);
});
