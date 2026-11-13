import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getAppPath: () => '/mock' } }));

import type { RemoteOwner } from '../../shared/remote/constants';
import type { RemoteSyncTargetIdentity } from '../../shared/remote/syncTarget';
import { type CoworkSession, CoworkStore } from '../coworkStore';
import type { IMStore } from '../im/imStore';
import { OpenClawChannelSessionSync } from '../libs/openclawChannelSessionSync';
import { remotePublicationAllowed, RemotePublicationKind } from './remotePublicationOrigins';
import { RemoteStore } from './remoteStore';

const owner: RemoteOwner = { userId: 'automation-owner', scopeKey: 'personal' };
const routes = { test: 'https://test.example', production: 'https://production.example' };
const targets = {
  test: { version: 1, dataSpaceId: 'test-space', dataGeneration: '1' },
  production: { version: 1, dataSpaceId: 'production-space', dataGeneration: '1' },
} satisfies Record<string, RemoteSyncTargetIdentity>;
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,claude_session_id TEXT,scheduled_task_id TEXT,
    status TEXT,pinned INTEGER,cwd TEXT,system_prompt TEXT,model_override TEXT,thinking_level TEXT,execution_mode TEXT,
    active_skill_ids TEXT,agent_id TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);
    CREATE TABLE remote_sync_targets(target_id TEXT PRIMARY KEY,sync_target_json TEXT);`);
  const remote = new RemoteStore(db, { deferredProjection: true, restoreRuns: false });
  let route = routes.test;
  let current: { owner: RemoteOwner; route: string; dataSpaceId: string } | null = null;
  remote.publicationOrigins.setRouteProvider(() => route);
  remote.publicationOrigins.setCurrentTargetProvider(() => current);
  const activate = (environment: keyof typeof targets) => {
    route = routes[environment];
    db.prepare('INSERT OR IGNORE INTO remote_sync_targets VALUES (?,?)').run(environment, JSON.stringify(targets[environment]));
    remote.publicationOrigins.confirm(owner, route, targets[environment]);
    current = { owner, route, dataSpaceId: targets[environment].dataSpaceId };
  };
  // Use the production creation method and its real ownership/source transaction.
  // Notification delivery and unrelated UI reads are outside this fixture.
  const sessions = new Map<string, CoworkSession>();
  const cowork = Object.assign(Object.create(CoworkStore.prototype) as CoworkStore, {
    db, remote,
    writeSessionProjections: <T>(_ids: readonly string[], operation: () => T): T => remote.transaction(operation),
    getSession: (id: string) => sessions.get(id) ?? null,
    getSessionIdByScheduledTaskId: (id: string, agentId: string) => [...sessions.values()]
      .find(session => session.scheduledTaskId === id && session.agentId === agentId)?.id ?? null,
    createSession: (...args: Parameters<CoworkStore['createSession']>) => {
      const session = CoworkStore.prototype.createSession.apply(cowork, args);
      sessions.set(session.id, session); return session;
    },
  });
  const sync = new OpenClawChannelSessionSync({ coworkStore: cowork,
    imStore: { getSessionMapping: () => null, getSessionMappingByOpenClawSessionKey: () => null,
      createSessionMapping: () => {}, updateSessionLastActive: () => {}, getIMSettings: () => ({}) } as unknown as IMStore,
    getDefaultCwd: () => '/tmp/automation-workspace',
  });
  const allowed = (id: string, target = 'production') => remotePublicationAllowed(db, RemotePublicationKind.Session, id, owner, target);
  return { db, remote, cowork, sync, activate, allowed };
}

it.each([
  { source: 'cron:test-job', key: 'agent:main:cron:test-job:run:historical-run', cron: true },
  { source: 'im:feishu:test-bot', key: 'agent:main:feishu:test-bot:direct:historical-peer', cron: false },
])('keeps a test-bound automation source out of production on first materialization: $source', ({ source, key, cron }) => {
  const f = fixture(); f.activate('test'); f.remote.bindSource(source, owner);
  f.activate('production');
  const id = cron ? f.sync.resolveOrCreateCronSession(key) : f.sync.resolveOrCreateSession(key);
  expect(id).toBeTruthy();
  expect(f.remote.owner(id!)).toEqual(owner);
  expect(f.allowed(id!)).toBe(false);
  expect(f.remote.sync(id!)?.ack_seq).toBe(0);
});

it('inherits the source captured before an asynchronous binding finishes in another environment', () => {
  const f = fixture(); f.activate('test');
  const finishBinding = f.remote.prepareSourceBinding(owner);
  f.activate('production'); finishBinding('cron:delayed-job');
  const id = f.sync.resolveOrCreateCronSession('agent:main:cron:delayed-job:run:run-1')!;
  expect(f.allowed(id)).toBe(false);
  expect(f.allowed(id, 'test')).toBe(true);
});

it('allows a newly bound production automation while retaining normal local ownership', () => {
  const f = fixture(); f.activate('production'); f.remote.bindSource('cron:production-job', owner);
  const id = f.sync.resolveOrCreateCronSession('agent:main:cron:production-job:run:run-1')!;
  expect(f.remote.owner(id)).toEqual(owner);
  expect(f.allowed(id)).toBe(true);
  expect(f.remote.sync(id)?.ack_seq).toBe(0);
});

it('does not assign the current environment to a legacy owner-only binding when it is saved again', () => {
  const f = fixture(); f.activate('test');
  f.db.prepare('INSERT INTO remote_source_owner VALUES (?,?)').run('cron:legacy-job', JSON.stringify(owner));
  f.activate('production'); f.remote.bindSource('cron:legacy-job', owner);
  const id = f.sync.resolveOrCreateCronSession('agent:main:cron:legacy-job:run:run-1')!;
  expect(f.allowed(id)).toBe(false);
  expect(f.allowed(id, 'test')).toBe(false);
  expect(f.db.prepare("SELECT route,data_space_id FROM remote_publication_origins WHERE kind='session' AND local_id=?").get(id))
    .toEqual({ route: '', data_space_id: null });
});

it('keeps bound automation without a source ID local instead of treating it as a newly created production task', () => {
  const f = fixture(); f.activate('production');
  const session = f.cowork.createSession('Automation', '/tmp/automation-workspace', '', 'local', [], 'main', '', {
    owner, ownershipSource: 'bound_automation',
  });
  expect(f.remote.owner(session.id)).toEqual(owner);
  expect(f.allowed(session.id)).toBe(false);
  expect(f.db.prepare("SELECT route,data_space_id FROM remote_publication_origins WHERE kind='session' AND local_id=?").get(session.id))
    .toEqual({ route: '', data_space_id: null });
});

it('keeps a previously materialized cron task and its original mapping when another environment discovers it', () => {
  const f = fixture(); f.activate('test'); f.remote.bindSource('cron:existing-job', owner);
  const id = f.sync.resolveOrCreateCronSession('agent:main:cron:existing-job:run:run-1')!;
  const original = f.remote.sync(id);
  f.activate('production');
  expect(f.sync.resolveOrCreateCronSession('agent:main:cron:existing-job:run:run-2')).toBe(id);
  expect(f.remote.sync(id)).toEqual(original);
  expect(f.allowed(id)).toBe(false);
  expect(f.allowed(id, 'test')).toBe(true);
});

it.each([
  { description: 'anonymous source cannot be claimed', originalOwner: null },
  { description: 'foreign origin without its owner binding cannot be rebound', originalOwner: { ...owner, userId: 'other-owner' } },
  { description: 'same-owner origin cannot recreate a missing owner binding', originalOwner: owner },
])('$description', ({ originalOwner }) => {
  const f = fixture(); f.activate('test');
  const sourceId = 'cron:protected-source';
  f.remote.bindSource(sourceId, originalOwner);
  // Reproduce origin-only evidence left by a damaged or partial old binding.
  if (originalOwner) f.db.prepare('DELETE FROM remote_source_owner WHERE source_id=?').run(sourceId);
  const read = () => ({
    owner: f.db.prepare('SELECT * FROM remote_source_owner WHERE source_id=?').get(sourceId),
    origin: f.db.prepare('SELECT * FROM remote_publication_origins WHERE kind=? AND local_id=?').get(RemotePublicationKind.Source, sourceId),
  });
  const before = read(); expect(before.owner).toBeUndefined(); expect(before.origin).toBeDefined();
  f.activate('production');
  expect(() => f.remote.bindSource(sourceId, owner)).toThrow();
  expect(read()).toEqual(before);
  expect(f.remote.sourceOwner(sourceId)).toBeNull();
});

it('rolls back a new automation owner binding when saving its source fails', () => {
  const f = fixture(); f.activate('test');
  f.db.exec(`CREATE TRIGGER reject_source_origin BEFORE INSERT ON remote_publication_origins
    WHEN NEW.kind='${RemotePublicationKind.Source}' BEGIN SELECT RAISE(ABORT,'source write blocked'); END;`);
  expect(() => f.remote.bindSource('cron:failed-source', owner)).toThrow('source write blocked');
  expect(f.db.prepare('SELECT * FROM remote_source_owner').all()).toEqual([]);
  expect(f.db.prepare('SELECT * FROM remote_publication_origins').all()).toEqual([]);
});
