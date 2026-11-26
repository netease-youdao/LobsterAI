import type Database from 'better-sqlite3';

import type { RemoteAvailabilityStore } from './remoteAvailabilityStore';
import type { RemoteLiveCandidate } from './remoteLiveCandidates';
import { RemoteLiveEncoderVersion } from './remoteLiveMetadata';
import type { LiveToolSource } from './remoteLiveProjection';
import { assertRemoteSidecarHeadroom } from './remoteSidecarHeadroom';

const PageSize = 4;
const ManualRetryMs = 60_000;
// Only the fixed statements in this module enter this per-connection cache.
const statements = new WeakMap<Database.Database, Map<string, Database.Statement>>();
function prepare(db: Database.Database, sql: string): Database.Statement {
  let cached = statements.get(db);
  if (!cached) { cached = new Map(); statements.set(db, cached); }
  let statement = cached.get(sql);
  if (!statement) {
    if (cached.size >= 32) throw new Error('REMOTE_LIVE_RECOVERY_STATEMENT_BUDGET');
    statement = db.prepare(sql); cached.set(sql, statement);
  }
  return statement;
}
type Probe = { fingerprint: string; encoder_version: number; manual_retry_at: number };
export type RecoveryCandidate = RemoteLiveCandidate & { repair?: boolean; annotationCheck?: boolean };

/** Persistent, bounded recovery admission; source revisions and sealed publications are never rewritten. */
export class RemoteLiveRecovery {
  private readonly cursors = new Map<string, string>();
  private readonly retryCursors = new Map<string, { localId: string; objectKey: string }>();
  constructor(private readonly ledger: RemoteAvailabilityStore) {}
  reset(): void { this.cursors.clear(); }

  candidates(core: Database.Database, scope: string, localId: string): RecoveryCandidate[] {
    const key = `${scope}:${localId}`, cursor = this.cursors.get(key) || '';
    const rows = prepare(this.ledger.db, `SELECT object_key FROM availability_faults
      WHERE scope=? AND local_id=? AND object_key>? AND (object_key LIKE 'message:%' OR object_key LIKE 'tool:%')
      ORDER BY object_key LIMIT ?`).all(scope, localId, cursor, PageSize) as Array<{ object_key: string }>;
    if (this.cursors.size >= 1024 && !this.cursors.has(key)) this.cursors.delete(this.cursors.keys().next().value!);
    if (rows.length === PageSize) this.cursors.set(key, rows.at(-1)!.object_key); else this.cursors.delete(key);
    const toolKey = `${key}:tools`, toolCursor = this.cursors.get(toolKey) || '';
    const tools = prepare(this.ledger.db, 'SELECT tool_id FROM availability_tool_refresh WHERE scope=? AND local_id=? AND tool_id>? ORDER BY tool_id LIMIT ?')
      .all(scope, localId, toolCursor, PageSize) as Array<{ tool_id: string }>;
    if (this.cursors.size >= 1024 && !this.cursors.has(toolKey)) this.cursors.delete(this.cursors.keys().next().value!);
    if (tools.length === PageSize) this.cursors.set(toolKey, tools.at(-1)!.tool_id); else this.cursors.delete(toolKey);
    const result: RecoveryCandidate[] = [];
    for (const row of [...rows, ...tools.map(tool => ({ object_key: `tool:${tool.tool_id}`, repair: true }))]) {
      const colon = row.object_key.indexOf(':'), kind = row.object_key.slice(0, colon), id = row.object_key.slice(colon + 1);
      if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id)) continue;
      if (kind === 'message') {
        const source = prepare(core, `SELECT r.revision,m.sequence AS position FROM remote_live_revisions r
          JOIN cowork_messages m ON m.session_id=r.session_id AND m.id=r.object_id
          WHERE r.session_id=? AND r.object_id=? AND r.deleted=0`).get(localId, id) as { revision: number; position: number } | undefined;
        if (source) result.push({ object_id: id, kind, ...source });
      } else if (kind === 'tool') {
        const source = prepare(core, 'SELECT revision FROM remote_live_tools WHERE session_id=? AND tool_id=?')
          .get(localId, id) as { revision: number } | undefined;
        if (source) result.push({ object_id: id, kind, revision: source.revision, position: 0, ...('repair' in row ? { repair: true } : {}) });
      }
    }
    const merged = new Map<string, RecoveryCandidate>();
    for (const candidate of result) {
      const key = `${candidate.kind}:${candidate.object_id}`, previous = merged.get(key);
      merged.set(key, { ...candidate, ...(previous?.repair || candidate.repair ? { repair: true } : {}) });
    }
    return [...merged.values()];
  }

  canAttempt(scope: string, localId: string, objectKey: string, fingerprint: string): boolean {
    if (this.ledger.objectRetryAllowed(scope, localId, objectKey, Date.now(), fingerprint)) return true;
    const probe = this.probe(scope, localId, objectKey);
    return !probe || probe.encoder_version < RemoteLiveEncoderVersion || probe.fingerprint !== fingerprint;
  }
  /** Consume the upgrade opportunity before dispatch, including when the process exits mid-encoding. */
  claim(scope: string, localId: string, objectKey: string, fingerprint: string): boolean {
    return this.ledger.db.transaction(() => {
      if (!this.canAttempt(scope, localId, objectKey, fingerprint)) return false;
      if (prepare(this.ledger.db, 'SELECT 1 FROM availability_faults WHERE scope=? AND local_id=? AND object_key=?').get(scope, localId, objectKey))
        this.remember(scope, localId, objectKey, fingerprint);
      return true;
    })();
  }
  fault(scope: string, localId: string, objectKey: string, fingerprint: string): void {
    this.ledger.db.transaction(() => {
      this.ledger.objectFault(scope, localId, objectKey, fingerprint);
      this.remember(scope, localId, objectKey, fingerprint);
    })();
  }
  private probe(scope: string, localId: string, objectKey: string): Probe | undefined {
    return prepare(this.ledger.db, 'SELECT fingerprint,encoder_version,manual_retry_at FROM availability_encoding_probes WHERE scope=? AND local_id=? AND object_key=?')
      .get(scope, localId, objectKey) as Probe | undefined;
  }
  private remember(scope: string, localId: string, objectKey: string, fingerprint: string): void {
    assertRemoteSidecarHeadroom(this.ledger.db.name, 512, 0);
    prepare(this.ledger.db, `INSERT INTO availability_encoding_probes(scope,local_id,object_key,fingerprint,encoder_version,manual_retry_at)
      VALUES(?,?,?,?,?,-1) ON CONFLICT(scope,local_id,object_key) DO UPDATE SET fingerprint=excluded.fingerprint,encoder_version=excluded.encoder_version`)
      .run(scope, localId, objectKey, fingerprint, RemoteLiveEncoderVersion);
  }
  retry(scope: string, allowed: (localId: string) => boolean, localId?: string): number {
    const now = Date.now(), key = `${scope}:${localId || ''}`, cursor = this.retryCursors.get(key);
    return this.ledger.db.transaction(() => {
      const rows = prepare(this.ledger.db, `SELECT f.local_id,f.object_key,f.fingerprint FROM availability_faults f
        LEFT JOIN availability_encoding_probes p ON p.scope=f.scope AND p.local_id=f.local_id AND p.object_key=f.object_key
        WHERE f.scope=? ${localId ? 'AND f.local_id=?' : ''} AND (f.object_key LIKE 'message:%' OR f.object_key LIKE 'tool:%')
        AND (f.local_id>? OR (f.local_id=? AND f.object_key>?))
        AND (p.manual_retry_at IS NULL OR p.manual_retry_at<0 OR p.manual_retry_at<=?) ORDER BY f.local_id,f.object_key LIMIT ?`)
        .all(...[scope, ...(localId ? [localId] : []), cursor?.localId || '', cursor?.localId || '', cursor?.objectKey || '', now - ManualRetryMs, PageSize]) as Array<{ local_id: string; object_key: string; fingerprint: string }>;
      if (this.retryCursors.size >= 1024 && !this.retryCursors.has(key)) this.retryCursors.delete(this.retryCursors.keys().next().value!);
      if (rows.length === PageSize) this.retryCursors.set(key, { localId: rows.at(-1)!.local_id, objectKey: rows.at(-1)!.object_key });
      else this.retryCursors.delete(key);
      let count = 0;
      for (const row of rows) {
        if (!allowed(row.local_id)) continue;
        this.remember(scope, row.local_id, row.object_key, row.fingerprint);
        prepare(this.ledger.db, 'UPDATE availability_encoding_probes SET manual_retry_at=? WHERE scope=? AND local_id=? AND object_key=?')
          .run(now, scope, row.local_id, row.object_key);
        prepare(this.ledger.db, 'UPDATE availability_faults SET next_retry=? WHERE scope=? AND local_id=? AND object_key=?')
          .run(now, scope, row.local_id, row.object_key);
        count++;
      }
      return count;
    })();
  }
  recordToolSource(core: Database.Database, scope: string, localId: string, evidence: LiveToolSource): void {
    assertRemoteSidecarHeadroom(this.ledger.db.name, 512, 0);
    core.transaction(() => {
      const source = prepare(core, `SELECT r.revision,r.deleted,m.type FROM remote_live_revisions r
        JOIN cowork_messages m ON m.session_id=r.session_id AND m.id=r.object_id WHERE r.session_id=? AND r.object_id=?`)
        .get(localId, evidence.messageId) as { revision: number; deleted: number; type: string } | undefined;
      if (!source || source.deleted || !['tool_use','tool_result'].includes(source.type) || String(source.revision) !== evidence.sourceRevision || !/^[A-Za-z0-9_-]{1,64}$/u.test(evidence.toolId))
        throw new Error('REMOTE_LIVE_ENCODER_CONTEXT_CHANGED');
      // Triggers already maintain the authoritative tool revision, including large metadata.
      if (!prepare(core, 'SELECT 1 FROM remote_live_tools WHERE session_id=? AND tool_id=?').get(localId, evidence.toolId))
        throw new Error('REMOTE_LIVE_TOOL_IDENTITY_MISSING');
      // This runs before sealing the message publication. A crash before queuing leaves the message
      // unacknowledged, so encoding repeats; a queued tool must always see its repaired source index.
      prepare(core, `INSERT INTO remote_live_tool_sources VALUES(?,?,?) ON CONFLICT(session_id,message_id)
        DO UPDATE SET tool_id=excluded.tool_id WHERE tool_id<>excluded.tool_id`).run(localId, evidence.messageId, evidence.toolId);
    })();
    prepare(this.ledger.db, 'INSERT OR IGNORE INTO availability_tool_refresh VALUES(?,?,?)').run(scope, localId, evidence.toolId);
  }
}
