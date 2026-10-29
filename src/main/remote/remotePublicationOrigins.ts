import type Database from 'better-sqlite3';

import { AgentId } from '../../shared/agent/constants';
import type { RemoteAgentCatalogItem, RemoteOwner } from '../../shared/remote/constants';
import type { RemoteSyncTargetIdentity } from '../../shared/remote/syncTarget';
import { payloadHash } from './canonical';

export const RemotePublicationKind = { Session: 'session', Agent: 'agent' } as const;
type Kind = typeof RemotePublicationKind[keyof typeof RemotePublicationKind];
interface Origin { route: string | null; data_space_id: string | null; owner_user_id: string | null; owner_scope_key: string | null }
const exists = (db: Database.Database, table: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const normalize = (route: string): string => {
  const url = new URL(route);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Invalid remote publication route');
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
};
export const remotePublicationTargetSpace = (db: Database.Database, targetId: string): string | null => {
  if (!exists(db, 'remote_sync_targets')) return null;
  const row = db.prepare('SELECT sync_target_json FROM remote_sync_targets WHERE target_id=?').get(targetId) as { sync_target_json: string | null } | undefined;
  if (!row) return null;
  if (row.sync_target_json) return (JSON.parse(row.sync_target_json) as RemoteSyncTargetIdentity).dataSpaceId;
  if (!exists(db, 'remote_publication_legacy_targets')) return null;
  const legacy = db.prepare('SELECT route FROM remote_publication_legacy_targets WHERE target_id=?').get(targetId) as { route: string } | undefined;
  return legacy ? `legacy-route:${legacy.route}` : null;
};
const enabled = (db: Database.Database): boolean => exists(db, 'remote_publication_policy')
  && !!db.prepare('SELECT 1 FROM remote_publication_policy WHERE id=1').get();

/** Local source authority is independent of mutable transport mappings and delivery receipts. */
export class RemotePublicationOrigins {
  private route: (() => string) | null = null;
  private currentTarget: (() => { owner: RemoteOwner; route: string; dataSpaceId: string } | null) | null = null;
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS remote_publication_origins(
      kind TEXT NOT NULL,local_id TEXT NOT NULL,route TEXT,data_space_id TEXT,owner_user_id TEXT,owner_scope_key TEXT,
      PRIMARY KEY(kind,local_id));
      CREATE TABLE IF NOT EXISTS remote_publication_routes(
        owner_user_id TEXT NOT NULL,owner_scope_key TEXT NOT NULL,route TEXT NOT NULL,data_space_id TEXT NOT NULL,
        PRIMARY KEY(owner_user_id,owner_scope_key,route,data_space_id));
      CREATE TABLE IF NOT EXISTS remote_publication_policy(id INTEGER PRIMARY KEY CHECK(id=1));
      CREATE TABLE IF NOT EXISTS remote_publication_legacy_targets(target_id TEXT PRIMARY KEY,route TEXT NOT NULL);`);
  }
  isEnabled(): boolean { return enabled(this.db); }
  setRouteProvider(route: () => string): void {
    this.route = route;
    this.db.prepare('INSERT OR IGNORE INTO remote_publication_policy VALUES(1)').run();
  }
  setCurrentTargetProvider(provider: () => { owner: RemoteOwner; route: string; dataSpaceId: string } | null): void { this.currentTarget = provider; }
  private get(kind: Kind, id: string): Origin | undefined {
    return this.db.prepare('SELECT route,data_space_id,owner_user_id,owner_scope_key FROM remote_publication_origins WHERE kind=? AND local_id=?').get(kind, id) as Origin | undefined;
  }
  capture(kind: Kind, id: string, owner: RemoteOwner | null, parentId?: string): void {
    if (parentId) {
      this.inferSession(parentId);
      const parent = this.get(kind, parentId);
      this.db.prepare('INSERT OR IGNORE INTO remote_publication_origins VALUES(?,?,?,?,?,?)')
        .run(kind, id, parent?.route ?? null, parent?.data_space_id ?? null, owner?.userId ?? null, owner?.scopeKey ?? null);
      return;
    }
    if (!this.route) return;
    const route = normalize(this.route());
    const current = this.currentTarget?.();
    const space = owner && current?.owner.userId === owner.userId && current.owner.scopeKey === owner.scopeKey && normalize(current.route) === route
      ? current.dataSpaceId : null;
    this.db.prepare('INSERT OR IGNORE INTO remote_publication_origins VALUES(?,?,?,?,?,?)')
      .run(kind, id, route, space, owner?.userId ?? null, owner?.scopeKey ?? null);
  }
  associate(kind: Kind, id: string, owner: RemoteOwner): void {
    // Association changes account ownership, never the environment where the source was created.
    this.db.prepare('INSERT OR IGNORE INTO remote_publication_origins VALUES(?,?,NULL,NULL,?,?)').run(kind, id, owner.userId, owner.scopeKey);
    this.db.prepare('UPDATE remote_publication_origins SET owner_user_id=?,owner_scope_key=? WHERE kind=? AND local_id=? AND owner_user_id IS NULL')
      .run(owner.userId, owner.scopeKey, kind, id);
    this.promote(owner);
  }
  private spaces(owner: RemoteOwner, route: string): string[] {
    return [...new Set((this.db.prepare('SELECT route,data_space_id FROM remote_publication_routes WHERE owner_user_id=? AND owner_scope_key=?')
      .all(owner.userId, owner.scopeKey) as Array<{ route: string; data_space_id: string }>).
      filter(row => row.route === route).map(row => row.data_space_id))];
  }
  private promote(owner: RemoteOwner): void {
    for (const row of this.db.prepare('SELECT kind,local_id,route FROM remote_publication_origins WHERE owner_user_id=? AND owner_scope_key=? AND data_space_id IS NULL AND route IS NOT NULL')
      .all(owner.userId, owner.scopeKey) as Array<{ kind: Kind; local_id: string; route: string }>) {
      const spaces = this.spaces(owner, row.route);
      if (spaces.length === 1) this.db.prepare('UPDATE remote_publication_origins SET data_space_id=? WHERE kind=? AND local_id=? AND data_space_id IS NULL')
        .run(spaces[0], row.kind, row.local_id);
    }
  }
  confirm(owner: RemoteOwner, route: string, target: RemoteSyncTargetIdentity | null, targetId?: string): void {
    this.inferLegacy(owner);
    const space = target?.dataSpaceId ?? (targetId ? `legacy-route:${normalize(route)}` : null);
    if (!space) return;
    if (!target && targetId) this.db.prepare('INSERT INTO remote_publication_legacy_targets VALUES(?,?) ON CONFLICT(target_id) DO UPDATE SET route=excluded.route').run(targetId, normalize(route));
    this.db.prepare('INSERT OR IGNORE INTO remote_publication_routes VALUES(?,?,?,?)').run(owner.userId, owner.scopeKey, normalize(route), space);
    this.promote(owner);
  }
  private environmentOrigin(environment: string | null): { route: string | null; space: string | null } | null {
    if (!environment) return null;
    const space = remotePublicationTargetSpace(this.db, environment);
    if (space) return { route: null, space };
    try { return { route: normalize(environment), space: null }; } catch { return null; }
  }
  private damagedArchive(owner: RemoteOwner): boolean {
    return Boolean(exists(this.db, 'remote_sync_target_archives') && this.db.prepare(`SELECT 1 FROM remote_sync_target_archives a
      JOIN remote_sync_targets t ON t.target_id=a.target_id WHERE t.owner_user_id=? AND t.owner_scope_key=?
      AND a.table_name='remote_sync' AND COALESCE(CASE WHEN json_valid(a.row_json) THEN json_type(a.row_json)='object'
        AND json_type(a.row_json,'$.local_id')='text' AND length(json_extract(a.row_json,'$.local_id'))>0
        AND json_type(a.row_json,'$.session_id')='text' AND length(json_extract(a.row_json,'$.session_id'))>0
        AND json_type(a.row_json,'$.device_id')='text' ELSE 0 END,0)=0 LIMIT 1`).get(owner.userId, owner.scopeKey));
  }
  private inferSession(id: string, archiveDamaged?: boolean): void {
    if (this.get(RemotePublicationKind.Session, id) || !exists(this.db, 'remote_sync')) return;
    const owner = this.db.prepare('SELECT owner_user_id,owner_scope_key FROM cowork_session_ownership WHERE session_id=? AND ownership_status=\'confirmed\'').get(id) as Pick<Origin, 'owner_user_id' | 'owner_scope_key'> | undefined;
    if (!owner) return;
    const damagedArchive = archiveDamaged ?? this.damagedArchive({ userId: owner.owner_user_id!, scopeKey: owner.owner_scope_key! });
    const damagedAdmission = exists(this.db, 'remote_sync_admission_evidence') && this.db.prepare(`SELECT 1 FROM remote_sync_admission_evidence
      WHERE table_name='remote_sync' AND row_key=? AND COALESCE(CASE WHEN json_valid(row_json) THEN json_type(row_json)='object'
        AND json_extract(row_json,'$.local_id')=row_key AND json_type(row_json,'$.session_id')='text'
        AND length(json_extract(row_json,'$.session_id'))>0 AND json_type(row_json,'$.device_id')='text' ELSE 0 END,0)=0 LIMIT 1`).get(id);
    if (damagedArchive || damagedAdmission) {
      this.db.prepare('INSERT OR IGNORE INTO remote_publication_origins VALUES(?,?,?,NULL,?,?)')
        .run(RemotePublicationKind.Session, id, '', owner.owner_user_id, owner.owner_scope_key);
      return;
    }
    const environments: Array<string | null> = [];
    const current = this.db.prepare('SELECT sync_environment FROM remote_sync WHERE local_id=?').get(id) as { sync_environment: string | null } | undefined;
    if (current) environments.push(current.sync_environment);
    for (const table of ['remote_sync_target_archives', 'remote_sync_admission_evidence']) {
      if (!exists(this.db, table)) continue;
      for (const row of this.db.prepare(`SELECT CASE WHEN json_valid(row_json) THEN json_extract(row_json,'$.sync_environment') END AS environment FROM ${table}
        WHERE table_name='remote_sync' AND CASE WHEN json_valid(row_json) THEN json_extract(row_json,'$.local_id') END=?`).iterate(id) as Iterable<{ environment: string | null }>) environments.push(row.environment);
    }
    const origins = environments.map(value => this.environmentOrigin(value)).filter((value): value is NonNullable<typeof value> => value !== null);
    const spaces = [...new Set(origins.flatMap(value => value.space ? [value.space] : []))];
    const routes = [...new Set(origins.flatMap(value => value.route ? [value.route] : []))];
    const unresolved = environments.some(value => value !== null && !this.environmentOrigin(value))
      || origins.length > 0 && environments.some(value => value === null);
    const space = !unresolved && spaces.length === 1 && !routes.length ? spaces[0] : null;
    const route = unresolved ? '' : !spaces.length && routes.length === 1 ? routes[0] : spaces.length + routes.length > 1 ? '' : null;
    this.db.prepare('INSERT OR IGNORE INTO remote_publication_origins VALUES(?,?,?,?,?,?)')
      .run(RemotePublicationKind.Session, id, route, space, owner.owner_user_id, owner.owner_scope_key);
  }
  inferLegacy(owner: RemoteOwner): void {
    if (!enabled(this.db)) return;
    for (const table of ['remote_sync_target_archives', 'remote_sync_admission_evidence']) if (exists(this.db, table))
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_publication_origin ON ${table}(CASE WHEN json_valid(row_json) THEN json_extract(row_json,'$.local_id') END) WHERE table_name='remote_sync'`);
    const damagedArchive = this.damagedArchive(owner);
    for (const row of this.db.prepare('SELECT session_id FROM cowork_session_ownership o WHERE owner_user_id=? AND owner_scope_key=? AND ownership_status=\'confirmed\' AND NOT EXISTS(SELECT 1 FROM remote_publication_origins p WHERE p.kind=\'session\' AND p.local_id=o.session_id)')
      .all(owner.userId, owner.scopeKey) as Array<{ session_id: string }>) this.inferSession(row.session_id, damagedArchive);
    if (!exists(this.db, 'agent_ownership')) return;
    const agents = this.db.prepare("SELECT agent_id FROM agent_ownership a WHERE owner_kind='owned' AND owner_user_id=? AND owner_scope_key=? AND NOT EXISTS(SELECT 1 FROM remote_publication_origins p WHERE p.kind='agent' AND p.local_id=a.agent_id)")
      .all(owner.userId, owner.scopeKey) as Array<{ agent_id: string }>;
    if (!agents.length) return;
    const agentSpaces = new Map<string, Set<string>>();
    let damagedCatalog = false;
    const unresolvedAgents = new Set<string>();
    for (const catalog of this.db.prepare("SELECT key,value FROM remote_state WHERE key>='agentCatalog:' AND key<'agentCatalog;'").all() as Array<{ key: string; value: string }>) {
      try {
        const scope = JSON.parse(catalog.key.slice('agentCatalog:'.length)) as string[];
        if (scope.length !== 4 || scope[1] !== owner.userId || scope[2] !== owner.scopeKey) continue;
        const space = remotePublicationTargetSpace(this.db, scope[0]);
        const value = JSON.parse(catalog.value) as { syncedItems?: Array<{ agentId: string }>; pending?: { items?: Array<{ agentId: string }> } };
        for (const item of [...(value.syncedItems || []), ...(value.pending?.items || [])]) {
          if (!space) { unresolvedAgents.add(item.agentId); continue; }
          const spaces = agentSpaces.get(item.agentId) || new Set<string>(); spaces.add(space); agentSpaces.set(item.agentId, spaces);
        }
      } catch { damagedCatalog = true; /* Missing evidence cannot establish a sole source. */ }
    }
    for (const { agent_id: id } of agents) {
      const spaces = agentSpaces.get(id) || new Set<string>();
      this.db.prepare('INSERT OR IGNORE INTO remote_publication_origins VALUES(?,?,?,?,?,?)')
        .run(RemotePublicationKind.Agent, id, damagedCatalog || unresolvedAgents.has(id) || spaces.size > 1 ? '' : null, !damagedCatalog && !unresolvedAgents.has(id) && spaces.size === 1 ? [...spaces][0] : null, owner.userId, owner.scopeKey);
    }
  }
  claimLegacyAgents(owner: RemoteOwner, deviceId: string, targetId: string, items: RemoteAgentCatalogItem[]): void {
    if (!enabled(this.db)) return;
    const space = remotePublicationTargetSpace(this.db, targetId);
    if (!space || space.startsWith('legacy-route:')) return;
    const pending = this.db.prepare("SELECT local_id,data_space_id FROM remote_publication_origins WHERE kind='agent' AND owner_user_id=? AND owner_scope_key=? AND substr(data_space_id,1,13)='legacy-route:'")
      .all(owner.userId, owner.scopeKey) as Array<{ local_id: string; data_space_id: string }>;
    if (!pending.length) return;
    const publications = this.db.prepare("SELECT key,value FROM remote_state WHERE key>='agentCatalog:' AND key<'agentCatalog;'").all() as Array<{ key: string; value: string }>;
    for (const origin of pending) {
      if (!this.spaces(owner, origin.data_space_id.slice('legacy-route:'.length)).includes(space)) continue;
      const current = items.find(item => item.agentId === origin.local_id); if (!current) continue;
      const proved = publications.some(publication => {
        try {
          const scope = JSON.parse(publication.key.slice('agentCatalog:'.length)) as string[];
          if (scope.length !== 4 || scope[1] !== owner.userId || scope[2] !== owner.scopeKey || scope[3] !== deviceId
            || remotePublicationTargetSpace(this.db, scope[0]) !== origin.data_space_id) return false;
          const saved = JSON.parse(publication.value) as { syncedItems?: RemoteAgentCatalogItem[]; pending?: { items?: RemoteAgentCatalogItem[] } };
          return [...(saved.syncedItems || []), ...(saved.pending?.items || [])].some(item => item.agentId === current.agentId && payloadHash(item) === payloadHash(current));
        } catch { return false; }
      });
      if (proved) this.db.prepare("UPDATE remote_publication_origins SET data_space_id=? WHERE kind='agent' AND local_id=? AND data_space_id=?")
        .run(space, origin.local_id, origin.data_space_id);
    }
  }
  claimSession(id: string, owner: RemoteOwner, targetId: string, verified: boolean): boolean {
    if (!enabled(this.db)) return true;
    if (remotePublicationAllowed(this.db, RemotePublicationKind.Session, id, owner, targetId)) return true;
    const origin = this.get(RemotePublicationKind.Session, id);
    const space = remotePublicationTargetSpace(this.db, targetId); if (!space) return false;
    const legacy = origin?.data_space_id?.startsWith('legacy-route:') && this.spaces(owner, origin.data_space_id.slice('legacy-route:'.length)).includes(space);
    if (verified && legacy && origin?.owner_user_id === owner.userId && origin.owner_scope_key === owner.scopeKey) {
      this.db.prepare('UPDATE remote_publication_origins SET data_space_id=? WHERE kind=? AND local_id=? AND data_space_id=?').run(space, RemotePublicationKind.Session, id, origin.data_space_id);
      return true;
    }
    if (!verified || origin?.data_space_id || origin && origin.route !== null) return false;
    this.db.prepare('INSERT OR IGNORE INTO remote_publication_origins VALUES(?,?,NULL,?,?,?)').run(RemotePublicationKind.Session, id, space, owner.userId, owner.scopeKey);
    this.db.prepare('UPDATE remote_publication_origins SET data_space_id=? WHERE kind=? AND local_id=? AND data_space_id IS NULL AND route IS NULL AND owner_user_id=? AND owner_scope_key=?')
      .run(space, RemotePublicationKind.Session, id, owner.userId, owner.scopeKey);
    return remotePublicationAllowed(this.db, RemotePublicationKind.Session, id, owner, targetId);
  }
}

export function remotePublicationAllowed(db: Database.Database, kind: Kind, id: string, owner: RemoteOwner, targetId: string): boolean {
  if (kind === RemotePublicationKind.Agent && id === AgentId.Main) return true;
  if (!enabled(db)) return true;
  const origin = db.prepare('SELECT * FROM remote_publication_origins WHERE kind=? AND local_id=?').get(kind, id) as Origin | undefined;
  const space = remotePublicationTargetSpace(db, targetId);
  return !!space && origin?.owner_user_id === owner.userId && origin.owner_scope_key === owner.scopeKey && origin.data_space_id === space;
}

export function remotePublicationForeign(db: Database.Database, id: string, owner: RemoteOwner, targetId: string): boolean {
  if (!enabled(db)) return false;
  const origin = db.prepare('SELECT * FROM remote_publication_origins WHERE kind=? AND local_id=?').get(RemotePublicationKind.Session, id) as Origin | undefined;
  const space = remotePublicationTargetSpace(db, targetId);
  if (origin?.data_space_id?.startsWith('legacy-route:') && space && db.prepare('SELECT 1 FROM remote_publication_routes WHERE owner_user_id=? AND owner_scope_key=? AND route=? AND data_space_id=?')
    .get(owner.userId, owner.scopeKey, origin.data_space_id.slice('legacy-route:'.length), space)) return false; // State lookup only; publication still requires claimSession proof.
  return !!origin && (origin.route !== null || !!origin.data_space_id) && !remotePublicationAllowed(db, RemotePublicationKind.Session, id, owner, targetId);
}

/** Indexed source filtering keeps foreign history out of the bounded admission page. */
export function remotePublicationPendingSql(db: Database.Database, owner: RemoteOwner, targetId: string, idSql: string): { sql: string; params: Array<string | null> } {
  if (!enabled(db)) return { sql: '1=1', params: [] };
  const space = remotePublicationTargetSpace(db, targetId);
  return { sql: `NOT EXISTS(SELECT 1 FROM remote_publication_origins origin WHERE origin.kind='session' AND origin.local_id=${idSql}
    AND (origin.route IS NOT NULL OR origin.data_space_id IS NOT NULL)
    AND NOT (origin.owner_user_id IS ? AND origin.owner_scope_key IS ? AND origin.data_space_id IS ?)
    AND NOT (substr(origin.data_space_id,1,13)='legacy-route:' AND EXISTS(SELECT 1 FROM remote_publication_routes r
      WHERE r.owner_user_id=? AND r.owner_scope_key=? AND r.route=substr(origin.data_space_id,14) AND r.data_space_id=?)))`,
    params: [owner.userId, owner.scopeKey, space, owner.userId, owner.scopeKey, space] };
}
