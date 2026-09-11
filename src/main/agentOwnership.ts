import type Database from 'better-sqlite3';

import { AgentAccessErrorCode, AgentId, AgentOwnerKind } from '../shared/agent/constants';
import type { RemoteOwner } from '../shared/remote/constants';
import { t } from './i18n';

export interface AgentOwnershipRecord {
  agentId: string;
  ownerKind: AgentOwnerKind;
  owner: RemoteOwner | null;
  version: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export class AgentAccessError extends Error {
  constructor(readonly code: AgentAccessErrorCode) {
    super(t(code));
    this.name = 'AgentAccessError';
  }
}

export const sameAgentOwner = (left: RemoteOwner | null, right: RemoteOwner | null): boolean =>
  left === null ? right === null : right !== null && left.userId === right.userId && left.scopeKey === right.scopeKey;

/** Undefined is reserved for internal raw reads; null is a genuinely anonymous actor. */
export function sessionVisibilitySql(actor: RemoteOwner | null | undefined, alias = 's'): {
  sql: string; parameters: string[];
} {
  if (actor === undefined) return { sql: '1=1', parameters: [] };
  const anonymous = `NOT EXISTS (SELECT 1 FROM cowork_session_ownership o WHERE o.session_id=${alias}.id)`;
  return actor === null ? { sql: anonymous, parameters: [] } : {
    sql: `(${anonymous} OR EXISTS (SELECT 1 FROM cowork_session_ownership o WHERE o.session_id=${alias}.id AND o.ownership_status='confirmed' AND o.owner_user_id=? AND o.owner_scope_key=?))`,
    parameters: [actor.userId, actor.scopeKey],
  };
}

/** Ownership survives Agent deletion. Runtime raw reads must not be used for UI authorization. */
export class AgentOwnerStore {
  private depth = 0;
  private readonly listeners = new Set<(agentId: string) => void>();

  constructor(private readonly db: Database.Database) {
    db.transaction(() => {
      const migrated = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_ownership'").get());
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_ownership (
          agent_id TEXT PRIMARY KEY, owner_kind TEXT NOT NULL,
          owner_user_id TEXT, owner_scope_key TEXT, version INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
        CREATE INDEX IF NOT EXISTS idx_agent_ownership_owner ON agent_ownership(owner_kind,owner_user_id,owner_scope_key,agent_id);
        CREATE TABLE IF NOT EXISTS agent_write_context (id INTEGER PRIMARY KEY CHECK(id=1), trusted INTEGER NOT NULL);
        INSERT OR IGNORE INTO agent_write_context VALUES (1,0);
        CREATE TABLE IF NOT EXISTS agent_ownership_dirty (agent_id TEXT PRIMARY KEY);
      `);
      db.prepare(`INSERT OR IGNORE INTO agent_ownership
        SELECT id,CASE WHEN id='main' THEN 'default' ELSE ? END,NULL,NULL,1,created_at,updated_at,NULL FROM agents`)
        .run(migrated ? AgentOwnerKind.Quarantined : AgentOwnerKind.Anonymous);
      db.exec(`UPDATE agent_ownership SET owner_kind='quarantined'
        WHERE (owner_kind='owned' AND (owner_user_id IS NULL OR TRIM(owner_user_id)='' OR owner_scope_key IS NULL OR TRIM(owner_scope_key)=''))
          OR (owner_kind!='owned' AND (owner_user_id IS NOT NULL OR owner_scope_key IS NOT NULL))
          OR owner_kind NOT IN ('default','owned','anonymous','quarantined')
          OR (owner_kind='default' AND agent_id!='main');
        CREATE INDEX IF NOT EXISTS idx_cowork_sessions_agent ON cowork_sessions(agent_id);
        CREATE TRIGGER IF NOT EXISTS agent_identity_no_reuse BEFORE INSERT ON agents
        WHEN NEW.id!='main' AND EXISTS(SELECT 1 FROM agent_ownership WHERE agent_id=NEW.id)
        BEGIN SELECT RAISE(ABORT,'Agent identity cannot be reused'); END;
        CREATE TRIGGER IF NOT EXISTS agent_ownership_insert AFTER INSERT ON agents BEGIN
          INSERT OR IGNORE INTO agent_ownership VALUES(NEW.id,CASE WHEN NEW.id='main' THEN 'default' ELSE 'quarantined' END,NULL,NULL,1,NEW.created_at,NEW.updated_at,NULL);
          INSERT OR IGNORE INTO agent_ownership_dirty VALUES(NEW.id);
        END;
        CREATE TRIGGER IF NOT EXISTS agent_ownership_update AFTER UPDATE ON agents BEGIN
          UPDATE agent_ownership SET version=version+1,updated_at=NEW.updated_at,
            owner_kind=CASE WHEN owner_kind='owned' AND (SELECT trusted FROM agent_write_context WHERE id=1)=0 THEN 'quarantined' ELSE owner_kind END
            WHERE agent_id=NEW.id;
          INSERT OR IGNORE INTO agent_ownership_dirty VALUES(NEW.id);
          INSERT OR IGNORE INTO remote_dirty SELECT id FROM cowork_sessions WHERE agent_id=NEW.id;
        END;
        CREATE TRIGGER IF NOT EXISTS agent_ownership_delete AFTER DELETE ON agents BEGIN
          UPDATE agent_ownership SET version=version+1,updated_at=CAST(strftime('%s','now') AS INTEGER)*1000,
            deleted_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE agent_id=OLD.id;
          INSERT OR IGNORE INTO agent_ownership_dirty VALUES(OLD.id);
          INSERT OR IGNORE INTO remote_dirty SELECT id FROM cowork_sessions WHERE agent_id=OLD.id;
        END;
      `);
    })();
  }

  get(agentId: string): AgentOwnershipRecord | null {
    const row = this.db.prepare('SELECT * FROM agent_ownership WHERE agent_id=?').get(agentId) as {
      agent_id: string; owner_kind: AgentOwnerKind; owner_user_id: string | null; owner_scope_key: string | null;
      version: number; created_at: number; updated_at: number; deleted_at: number | null;
    } | undefined;
    if (!row) return null;
    return { agentId: row.agent_id, ownerKind: row.owner_kind,
      owner: row.owner_kind === AgentOwnerKind.Owned && row.owner_user_id && row.owner_scope_key
        ? { userId: row.owner_user_id, scopeKey: row.owner_scope_key } : null,
      version: String(row.version), createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at };
  }

  list(): AgentOwnershipRecord[] {
    return (this.db.prepare('SELECT agent_id FROM agent_ownership').all() as { agent_id: string }[])
      .map(row => this.get(row.agent_id)!);
  }

  canView(agentId: string, actor: RemoteOwner | null): boolean {
    const record = this.get(agentId);
    return Boolean(record && record.deletedAt === null && (record.ownerKind === AgentOwnerKind.Default
      || record.ownerKind === AgentOwnerKind.Anonymous
      || (record.ownerKind === AgentOwnerKind.Owned && record.owner !== null && sameAgentOwner(record.owner, actor))));
  }

  canPublish(agentId: string, actor: RemoteOwner | null): boolean {
    return actor !== null && this.canView(agentId, actor) && this.get(agentId)?.ownerKind !== AgentOwnerKind.Anonymous;
  }

  assertAccess(agentId: string, actor: RemoteOwner | null): AgentOwnershipRecord {
    if (!this.canView(agentId, actor)) throw new AgentAccessError(AgentAccessErrorCode.Unavailable);
    return this.get(agentId)!;
  }

  assignNew(agentId: string, actor: RemoteOwner | null): void {
    if (this.depth === 0 || agentId === AgentId.Main) throw new AgentAccessError(AgentAccessErrorCode.IdentityReused);
    const record = this.get(agentId);
    if (!record || record.deletedAt !== null || record.ownerKind !== AgentOwnerKind.Quarantined) {
      throw new AgentAccessError(AgentAccessErrorCode.IdentityReused);
    }
    this.db.prepare('UPDATE agent_ownership SET owner_kind=?,owner_user_id=?,owner_scope_key=? WHERE agent_id=?')
      .run(actor ? AgentOwnerKind.Owned : AgentOwnerKind.Anonymous, actor?.userId ?? null, actor?.scopeKey ?? null, agentId);
  }

  /** Historical association is intentionally separate from the creation-only assignNew. */
  associateHistorical(agentId: string, actor: RemoteOwner, associatedAt: number): string {
    const record = this.get(agentId);
    if (this.depth === 0 || !this.db.inTransaction || agentId === AgentId.Main
      || !record || record.deletedAt !== null || record.ownerKind !== AgentOwnerKind.Anonymous) {
      throw new AgentAccessError(AgentAccessErrorCode.IdentityReused);
    }
    this.db.prepare(`UPDATE agent_ownership SET owner_kind=?,owner_user_id=?,owner_scope_key=?,
      version=version+1,updated_at=? WHERE agent_id=?`)
      .run(AgentOwnerKind.Owned, actor.userId, actor.scopeKey, associatedAt, agentId);
    this.db.prepare('INSERT OR IGNORE INTO agent_ownership_dirty VALUES (?)').run(agentId);
    this.db.prepare('INSERT OR IGNORE INTO remote_dirty SELECT id FROM cowork_sessions WHERE agent_id=?').run(agentId);
    return this.get(agentId)!.version;
  }

  subscribe(listener: (agentId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  transaction<T>(operation: () => T): T {
    if (this.depth > 0) return operation();
    const result = this.db.transaction(() => {
      this.depth++;
      this.db.prepare('UPDATE agent_write_context SET trusted=1 WHERE id=1').run();
      try { return operation(); } finally {
        this.db.prepare('UPDATE agent_write_context SET trusted=0 WHERE id=1').run();
        this.depth--;
      }
    })();
    this.flushChanges();
    return result;
  }

  flushChanges(): void {
    if (this.db.inTransaction) return;
    const dirty = this.db.prepare('SELECT agent_id FROM agent_ownership_dirty').all() as { agent_id: string }[];
    this.db.prepare('DELETE FROM agent_ownership_dirty').run();
    for (const row of dirty) for (const listener of this.listeners) {
      try { listener(row.agent_id); } catch (error) { console.error('[AgentOwnership] Change listener failed:', error); }
    }
  }

  touch(agentId: string): void {
    this.transaction(() => {
      this.db.prepare('UPDATE agent_ownership SET version=version+1,updated_at=? WHERE agent_id=? AND deleted_at IS NULL').run(Date.now(), agentId);
      this.db.prepare('INSERT OR IGNORE INTO agent_ownership_dirty VALUES(?)').run(agentId);
      this.db.prepare('INSERT OR IGNORE INTO remote_dirty SELECT id FROM cowork_sessions WHERE agent_id=?').run(agentId);
    });
  }

  assertDeletable(agentId: string, actor: RemoteOwner | null): void {
    this.assertAccess(agentId, actor);
    if (agentId === AgentId.Main) throw new AgentAccessError(AgentAccessErrorCode.DefaultProtected);
    const access = sessionVisibilitySql(actor);
    const foreign = this.db.prepare(`SELECT 1 FROM cowork_sessions s WHERE s.agent_id=? AND NOT (${access.sql}) LIMIT 1`)
      .get(agentId, ...access.parameters);
    if (foreign) throw new AgentAccessError(AgentAccessErrorCode.ForeignSessions);
    const sessions = this.db.prepare('SELECT id,status FROM cowork_sessions WHERE agent_id=?').all(agentId) as { id: string; status: string }[];
    if (sessions.some(session => session.status === 'running')) throw new AgentAccessError(AgentAccessErrorCode.Busy);
    const ids = new Set(sessions.map(session => session.id));
    const evidence = this.db.prepare("SELECT key,value FROM remote_state WHERE key LIKE 'run:%' OR key LIKE 'inbox:%' OR key LIKE 'approval:%'").all() as { key: string; value: string }[];
    for (const row of evidence) {
      let value: Record<string, any>;
      try { value = JSON.parse(row.value); } catch { throw new AgentAccessError(AgentAccessErrorCode.Busy); }
      if (row.key.startsWith('run:') && ids.has(row.key.slice(4)) && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.status)) {
        throw new AgentAccessError(AgentAccessErrorCode.Busy);
      }
      if (row.key.startsWith('inbox:') && (ids.has(value.localSessionId)
        || value.command?.request?.payload?.agentId === agentId || value.executionTarget?.agentId === agentId)
        && (!['applied', 'rejected'].includes(value.state) || !['applied', 'rejected', 'expired'].includes(value.command?.status))) {
        throw new AgentAccessError(AgentAccessErrorCode.Busy);
      }
      if (row.key.startsWith('approval:') && value.status === 'pending'
        && sessions.some(session => row.key.startsWith(`approval:${session.id}:`))) {
        throw new AgentAccessError(AgentAccessErrorCode.Busy);
      }
    }
  }
}
