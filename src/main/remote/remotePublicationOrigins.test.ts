import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { RemoteOwner } from '../../shared/remote/constants';
import type { RemoteSyncTargetIdentity } from '../../shared/remote/syncTarget';
import { remotePublicationAllowed, RemotePublicationKind, RemotePublicationOrigins } from './remotePublicationOrigins';

const owner: RemoteOwner = { userId: '10001', scopeKey: 'personal' };
const routes = { test: 'https://test.example', production: 'https://production.example', alias: 'https://alias.example' };
const targets = {
  test: { version: 1, dataSpaceId: 'test-space', dataGeneration: '1' },
  production: { version: 1, dataSpaceId: 'production-space', dataGeneration: '1' },
} satisfies Record<string, RemoteSyncTargetIdentity>;
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_session_ownership(session_id TEXT PRIMARY KEY,owner_user_id TEXT,owner_scope_key TEXT,ownership_status TEXT);
    CREATE TABLE remote_sync(local_id TEXT PRIMARY KEY,sync_environment TEXT);
    CREATE TABLE remote_sync_targets(target_id TEXT PRIMARY KEY,sync_target_json TEXT,owner_user_id TEXT,owner_scope_key TEXT);
    CREATE TABLE remote_sync_target_archives(target_id TEXT,table_name TEXT,row_json TEXT);
    CREATE TABLE remote_state(key TEXT PRIMARY KEY,value TEXT);`);
  db.prepare('INSERT INTO remote_sync_targets VALUES (?,?,?,?)').run('test-target', JSON.stringify(targets.test), owner.userId, owner.scopeKey);
  db.prepare('INSERT INTO remote_sync_targets VALUES (?,?,?,?)').run('production-target', JSON.stringify(targets.production), owner.userId, owner.scopeKey);
  const origins = new RemotePublicationOrigins(db);
  let route = routes.test;
  origins.setRouteProvider(() => route);
  let current: { owner: RemoteOwner; route: string; dataSpaceId: string } | null = null;
  origins.setCurrentTargetProvider(() => current);
  const confirm = (actor: RemoteOwner, address: string, target: RemoteSyncTargetIdentity) => {
    origins.confirm(actor, address, target);
    current = { owner: actor, route: address, dataSpaceId: target.dataSpaceId };
  };
  const session = (id: string, environment: string | null = null) => {
    db.prepare("INSERT INTO cowork_session_ownership VALUES (?,?,?,'confirmed')").run(id, owner.userId, owner.scopeKey);
    db.prepare('INSERT INTO remote_sync VALUES (?,?)').run(id, environment);
  };
  const allowed = (kind: typeof RemotePublicationKind[keyof typeof RemotePublicationKind], id: string, target = 'test-target', actor = owner) =>
    remotePublicationAllowed(db, kind, id, actor, target);
  return { db, origins, session, allowed, confirm, route(value: string) { route = value; } };
}

describe('local publication source authority', () => {
  it('keeps pre-sync test sessions and Agents out of the first production registration', () => {
    const f = fixture();
    for (const kind of Object.values(RemotePublicationKind)) f.origins.capture(kind, 'offline-created', owner);
    f.route(routes.production);
    f.confirm(owner, routes.production, targets.production);
    for (const kind of Object.values(RemotePublicationKind)) {
      expect(f.allowed(kind, 'offline-created', 'production-target')).toBe(false);
      expect(f.allowed(kind, 'offline-created')).toBe(false);
    }
    f.confirm(owner, routes.test, targets.test);
    for (const kind of Object.values(RemotePublicationKind)) {
      expect(f.allowed(kind, 'offline-created')).toBe(true);
      expect(f.allowed(kind, 'offline-created', 'production-target')).toBe(false);
    }
  });

  it('does not rewrite a persisted origin after restart or another environment login', () => {
    const f = fixture();
    f.confirm(owner, routes.test, targets.test);
    f.origins.capture(RemotePublicationKind.Session, 'existing', owner);
    const before = f.db.prepare('SELECT * FROM remote_publication_origins').get();
    const restarted = new RemotePublicationOrigins(f.db);
    restarted.setRouteProvider(() => routes.production);
    restarted.confirm(owner, routes.production, targets.production);
    restarted.capture(RemotePublicationKind.Session, 'existing', owner);
    expect(f.db.prepare('SELECT * FROM remote_publication_origins').get()).toEqual(before);
    expect(f.allowed(RemotePublicationKind.Session, 'existing')).toBe(true);
    expect(f.allowed(RemotePublicationKind.Session, 'existing', 'production-target')).toBe(false);
  });

  it('permits an authenticated alias of the same data space without changing source authority', () => {
    const f = fixture(); f.origins.capture(RemotePublicationKind.Session, 'existing', owner);
    f.confirm(owner, routes.test, targets.test);
    f.route(routes.alias); f.confirm(owner, routes.alias, targets.test);
    f.origins.capture(RemotePublicationKind.Session, 'new-alias-task', owner);
    expect(f.allowed(RemotePublicationKind.Session, 'existing')).toBe(true);
    expect(f.allowed(RemotePublicationKind.Session, 'new-alias-task')).toBe(true);
    expect(f.allowed(RemotePublicationKind.Session, 'new-alias-task', 'production-target')).toBe(false);
  });

  it('does not trust a hard-coded test URL alias before that address is authenticated', () => {
    const f = fixture();
    const first = 'https://lobsterai-server.inner.youdao.com';
    const second = 'https://lobsterai-server-dev.inner.youdao.com';
    f.confirm(owner, first, targets.test);
    f.route(second); f.origins.capture(RemotePublicationKind.Session, 'second-route-task', owner);
    expect(f.allowed(RemotePublicationKind.Session, 'second-route-task')).toBe(false);
    f.confirm(owner, second, targets.production);
    expect(f.allowed(RemotePublicationKind.Session, 'second-route-task')).toBe(false);
    expect(f.allowed(RemotePublicationKind.Session, 'second-route-task', 'production-target')).toBe(true);
  });

  it('keeps an old source while capturing new work in the newly confirmed space at the same URL', () => {
    const f = fixture(); f.confirm(owner, routes.test, targets.test);
    f.origins.capture(RemotePublicationKind.Session, 'old-task', owner);
    f.confirm(owner, routes.test, targets.production);
    f.origins.capture(RemotePublicationKind.Session, 'new-task', owner);
    expect(f.allowed(RemotePublicationKind.Session, 'old-task')).toBe(true);
    expect(f.allowed(RemotePublicationKind.Session, 'old-task', 'production-target')).toBe(false);
    expect(f.allowed(RemotePublicationKind.Session, 'new-task')).toBe(false);
    expect(f.allowed(RemotePublicationKind.Session, 'new-task', 'production-target')).toBe(true);
  });

  it('does not equate matching numeric user IDs across owner scopes', () => {
    const f = fixture(); f.confirm(owner, routes.test, targets.test);
    f.origins.capture(RemotePublicationKind.Session, 'personal-task', owner);
    expect(f.allowed(RemotePublicationKind.Session, 'personal-task', 'test-target', { ...owner, scopeKey: 'enterprise:7' })).toBe(false);
    expect(f.allowed(RemotePublicationKind.Session, 'personal-task', 'test-target', { ...owner, userId: 'different' })).toBe(false);
  });

  it('retains the anonymous creation environment through explicit account association', () => {
    const f = fixture(); f.origins.capture(RemotePublicationKind.Session, 'anonymous-task', null);
    f.route(routes.production); f.confirm(owner, routes.production, targets.production);
    f.origins.associate(RemotePublicationKind.Session, 'anonymous-task', owner);
    expect(f.allowed(RemotePublicationKind.Session, 'anonymous-task', 'production-target')).toBe(false);
    f.confirm(owner, routes.test, targets.test);
    expect(f.allowed(RemotePublicationKind.Session, 'anonymous-task')).toBe(true);
  });

  it('inherits the parent source instead of the currently selected production service', () => {
    const f = fixture(); f.confirm(owner, routes.test, targets.test);
    f.origins.capture(RemotePublicationKind.Session, 'parent', owner);
    f.route(routes.production); f.confirm(owner, routes.production, targets.production);
    f.origins.capture(RemotePublicationKind.Session, 'child', owner, 'parent');
    expect(f.allowed(RemotePublicationKind.Session, 'child')).toBe(true);
    expect(f.allowed(RemotePublicationKind.Session, 'child', 'production-target')).toBe(false);
  });

  it('retains unknown legacy content locally instead of claiming it on login', () => {
    const f = fixture(); f.session('legacy');
    f.confirm(owner, routes.production, targets.production);
    expect(f.allowed(RemotePublicationKind.Session, 'legacy', 'production-target')).toBe(false);
    expect(f.origins.claimSession('legacy', owner, 'production-target', false)).toBe(false);
    f.origins.associate(RemotePublicationKind.Agent, 'legacy-agent', owner);
    expect(f.allowed(RemotePublicationKind.Agent, 'legacy-agent', 'production-target')).toBe(false);
  });

  it('preserves the sole known legacy data-space binding', () => {
    const f = fixture(); f.session('legacy', 'test-target');
    f.confirm(owner, routes.production, targets.production);
    expect(f.allowed(RemotePublicationKind.Session, 'legacy')).toBe(true);
    expect(f.allowed(RemotePublicationKind.Session, 'legacy', 'production-target')).toBe(false);
  });

  it('does not turn conflicting legacy archives into production authority after a mapping proof', () => {
    const f = fixture(); f.session('copied', 'production-target');
    f.db.prepare('INSERT INTO remote_sync_target_archives VALUES (?,?,?)')
      .run('test-target', 'remote_sync', JSON.stringify({ local_id: 'copied', sync_environment: 'test-target' }));
    f.confirm(owner, routes.production, targets.production);
    expect(f.allowed(RemotePublicationKind.Session, 'copied', 'production-target')).toBe(false);
    expect(f.origins.claimSession('copied', owner, 'production-target', true)).toBe(false);
    expect(f.allowed(RemotePublicationKind.Session, 'copied', 'production-target')).toBe(false);
  });

  it.each(['{broken', '{}', '[]', '{"local_id":123}', '{"local_id":"possibly-copied","sync_environment":7}'])('does not ignore a damaged archive from another service when inferring legacy source (%s)', damaged => {
    const f = fixture(); f.session('possibly-copied', 'production-target');
    f.db.prepare('INSERT INTO remote_sync_target_archives VALUES (?,?,?)').run('test-target', 'remote_sync', damaged);
    f.confirm(owner, routes.production, targets.production);
    expect(f.allowed(RemotePublicationKind.Session, 'possibly-copied', 'production-target')).toBe(false);
    expect(f.origins.claimSession('possibly-copied', owner, 'production-target', true)).toBe(false);
  });

  it.each(['test', 'production', 'missing-target'])('does not discard unresolved historical source evidence (%s)', environment => {
    const f = fixture(); f.session('possibly-copied', 'production-target');
    f.db.prepare('INSERT INTO remote_sync_target_archives VALUES (?,?,?)')
      .run('test-target', 'remote_sync', JSON.stringify({ local_id: 'possibly-copied', sync_environment: environment }));
    f.confirm(owner, routes.production, targets.production);
    expect(f.allowed(RemotePublicationKind.Session, 'possibly-copied', 'production-target')).toBe(false);
    expect(f.origins.claimSession('possibly-copied', owner, 'production-target', true)).toBe(false);
  });

  it('keeps the default Agent selectable without admitting its foreign task history', () => {
    const f = fixture(); f.confirm(owner, routes.test, targets.test);
    f.origins.capture(RemotePublicationKind.Session, 'main-task', owner);
    expect(f.allowed(RemotePublicationKind.Agent, 'main', 'production-target')).toBe(true);
    expect(f.allowed(RemotePublicationKind.Session, 'main-task', 'production-target')).toBe(false);
  });

  it('rolls back creation provenance with the containing transaction', () => {
    const f = fixture();
    expect(() => f.db.transaction(() => {
      f.origins.capture(RemotePublicationKind.Session, 'rolled-back', owner);
      throw new Error('creation failed');
    })()).toThrow('creation failed');
    expect(f.db.prepare('SELECT 1 FROM remote_publication_origins WHERE local_id=?').get('rolled-back')).toBeUndefined();
  });
});
