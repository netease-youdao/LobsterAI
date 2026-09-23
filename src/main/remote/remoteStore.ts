import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';

import { OWNERSHIP_MANUAL_SOURCE } from '../../shared/ownership/constants';
import { REMOTE_MESSAGE_BYTES, type RemoteAgentSummary, type RemoteOwner, type RemoteRunStatusValue } from '../../shared/remote/constants';
import { type DeletionGuard, RemoteDeletion } from '../../shared/remote/deletions';
import { RemoteFileReason } from '../../shared/remote/files';
import { type LocalQuestionState, RemoteQuestion, type RemoteQuestionState } from '../../shared/remote/questions';
import { RemoteReply, RemoteReplyBlockType, type RemoteReplyContentRef, type RemoteReplyFormat, type RemoteReplyUpload } from '../../shared/remote/reply';
import { RemoteRetention } from '../../shared/remote/retention';
import { payloadHash, remoteError, sameOwner, stableJson } from './canonical';
import type { DesktopInputRun } from './desktopInputMetadata';
import { remoteArtifactReasons } from './remoteArtifactProjection';
import { RemoteDatabaseHealth } from './remoteDatabaseHealth';
import { samePersistedRemoteEnvironment } from './remoteEnvironmentMigration';
import { acknowledgeRemoteSessionDeletion } from './remoteLocalGc';
import { RemoteProjectionCoordinator } from './remoteProjectionCoordinator';
import type { ProjectionWork } from './remoteProjectionWorker';
import { isPublicReplyMessage, redactReplyText,replyAppendDelta, replyBlockId, replyBlocks, replyChunks, replyToolState } from './remoteReplyProjection';
import { RemoteSyncStateError, retentionEventId, retentionSequence, safeSourceSequence } from './remoteRetention';
import { remoteSyncErrorMetadata } from './remoteSyncLog';
import { activeRemoteSyncTargetContext } from './remoteSyncTargetStore';
import { RemoteTaskDataError } from './remoteTaskSyncState';

export interface ProjectionRecord { eventType: string; payload: Record<string, any> }
export interface RemoteEvent extends ProjectionRecord { eventId: string; sourceSeq: string; occurredAt: string }
export interface SyncRow {
  local_id: string; session_id: string; device_id: string; source_seq: number; ack_seq: number;
  server_seq: string; needs_snapshot: number;
  sync_environment: string | null; sync_protocol_version: number; stream_epoch: string | null; source_purge_seq: string; event_purge_seq: string; migration_frozen: number;
}
export interface RemoteRun {
  runId: string; status: RemoteRunStatusValue; statusVersion: string;
  startedAt: string | null; finishedAt: string | null; error: ReturnType<typeof remoteError> | null;
}
export interface SessionOwnershipRecord {
  session_id: string; owner_user_id: string; owner_scope_key: string;
  ownership_status: string; source: string; created_at: number;
}
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const preview = (text: string): string => Buffer.from(text).subarray(0, 3000).toString('utf8').replace(/\uFFFD$/u, '');
const iso = (value: number): string => new Date(value).toISOString();
const publicMessage = (row: any): boolean => {
  if (!['user', 'assistant', 'tool_use', 'tool_result'].includes(row.type)) return false;
  try { return JSON.parse(row.metadata || '{}').isThinking !== true; } catch { return row.type === 'user'; }
};
const shortName = (value: unknown): string => String(value || '').slice(0, 128).replace(/[\uD800-\uDBFF]$/u, '');
const publicText = (value: unknown): string => String(value || '').replace(/<think(?:ing)?>[\s\S]*?(<\/think(?:ing)?>|$)/gi, '').replace(/(?:file|lobster-artifact):\/\/[^\s)]+/gi, '[desktop file]');

const desktopInputReason = (job: { reason?: unknown; snapshot?: unknown }, captureReason?: unknown): string => {
  for (const reason of [job.reason, captureReason]) {
    if (typeof reason !== 'string') continue;
    if (remoteArtifactReasons.has(reason)) return reason;
    if (reason === 'ASSET_MISSING') return 'FILE_MISSING';
    if (reason === 'ASSET_FILE_CHANGED') return RemoteFileReason.Source;
  }
  return job.snapshot ? RemoteFileReason.Transfer : RemoteFileReason.Source;
};

/** Native SQLite transactions commit synchronously; no deferred persistence is allowed here. */
export class RemoteStore {
  private controlAdmission: (() => boolean) | null = null;
  private taskAdmission: ((id: string) => boolean) | null = null;
  private taskProjectionEligibility: ((id: string) => boolean) | null = null;
  private projectionCandidateOffset = 0;
  setControlAdmission(check: () => boolean): void { this.controlAdmission = check; }
  areControlsAdmitted(): boolean { try { return this.controlAdmission?.() ?? true; } catch { return false; } }
  setTaskAdmission(check: (id: string) => boolean): void { this.taskAdmission = check; }
  isTaskAdmitted(id: string): boolean { try { return this.taskAdmission?.(id) ?? true; } catch { return false; } }
  setTaskProjectionEligibility(check: (id: string) => boolean): void { this.taskProjectionEligibility = check; }
  private canProjectTask(id: string): boolean {
    try { return this.isTaskAdmitted(id) && (this.taskProjectionEligibility?.(id) ?? true); } catch { return false; }
  }
  private securityRecoveryRequired = false;
  private ownershipSigner: ((sessionId: string, userId: string, scopeKey: string, operationId: string) => string) | null = null;
  setSecurityRecoveryRequired(required: boolean): void { this.securityRecoveryRequired = required || !!this.db.prepare("SELECT 1 FROM remote_corrupt_state WHERE key LIKE 'run:%' LIMIT 1").get(); }
  needsSecurityRecovery(): boolean { return this.securityRecoveryRequired; }
  setOwnershipSigner(signer: NonNullable<RemoteStore['ownershipSigner']>): void { this.ownershipSigner = signer; }
  private signOwnership(sessionId: string, owner: RemoteOwner): void {
    const operationId = randomUUID();
    if (!this.ownershipSigner) {
      this.db.prepare('INSERT OR REPLACE INTO remote_ownership_pending VALUES (?,?,?,?,?)').run(sessionId, owner.userId, owner.scopeKey, operationId, this.get<string>('databaseInstance'));
      return;
    }
    this.put(`ownershipProof:${sessionId}`, { operationId, signature: this.ownershipSigner(sessionId, owner.userId, owner.scopeKey, operationId) });
  }
  private recoveringRuns = false;
  private runRecovery: Promise<void> = Promise.resolve();
  private runtimeTouchedSessions = new Set<string>();
  private depth = 0;
  private changeVersion = 0;
  private publishing = false;
  private artifactTracking = false;
  private deletionProjectionSupported = false;
  private approvalProjectionSupported = false;
  private questionProjectionSupported = false;
  private inputProjectionSupported = false;
  private fileProjectionSupported = false;
  private replyProjectionSupported = false;
  private projectionIdentity: { key: string; environment: string; owner: RemoteOwner; deviceId: string } | null = null;
  private fileEnvironment: string | null = null;
  private fileTerminalBoundary: ((sessionId: string, runId: string) => void) | null = null;
  private artifactProjection: ((sessionId: string, messageId: string) => Array<{ localArtifactId: string; block: Record<string, unknown> }>) | null = null;
  private approvalLifecycle: { expire(now: number): void; close(sessionId: string, runId: string, status: string): void } | null = null;
  private advanceCheckpoint: (() => number) | null = null;
  private enabledOwner: RemoteOwner | null = null;
  private wake: (urgent?: boolean) => void = () => undefined;
  private urgentReplyChange = false;
  private agentSummary: ((sessionId: string, owner: RemoteOwner) => RemoteAgentSummary | null) | null = null;

  private readonly databaseHealth: RemoteDatabaseHealth | null;
  private readonly projector: RemoteProjectionCoordinator | null;
  private readonly projectionTargetContexts = new WeakMap<ProjectionWork, string>();
  constructor(readonly db: Database.Database, private readonly options: { deferredProjection?: boolean; restoreRuns?: boolean; projectionWorkerPath?: string } = {}) {
    this.databaseHealth = options.deferredProjection && db.name !== ':memory:' && options.restoreRuns !== false ? new RemoteDatabaseHealth(db.name) : null;
    this.projector = options.deferredProjection && options.restoreRuns !== false ? new RemoteProjectionCoordinator(this, options.projectionWorkerPath) : null;
    // Set outside transactions. FULL makes inbox receipts/outbox ACK cleanup durable at COMMIT.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS remote_corrupt_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,detected_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_session_revisions(session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, dirty_at INTEGER NOT NULL, clean_revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS remote_projection_publications(session_id TEXT PRIMARY KEY,path TEXT NOT NULL,source_seq INTEGER NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_projection_failures(session_id TEXT PRIMARY KEY,reason TEXT NOT NULL,retry_at INTEGER NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_object_state(session_id TEXT NOT NULL,object_key TEXT NOT NULL,revision INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(session_id,object_key));
      CREATE TABLE IF NOT EXISTS remote_ownership_pending(session_id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,owner_scope_key TEXT NOT NULL,operation_id TEXT NOT NULL,database_id TEXT);
      CREATE TABLE IF NOT EXISTS remote_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_write_context (id INTEGER PRIMARY KEY CHECK(id=1), trusted INTEGER NOT NULL);
      INSERT OR IGNORE INTO remote_write_context VALUES (1,0);
      CREATE TABLE IF NOT EXISTS cowork_session_ownership (
        session_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, owner_scope_key TEXT NOT NULL,
        ownership_status TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_dirty (session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS remote_content_dirty (session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS remote_sync (
        local_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, device_id TEXT NOT NULL DEFAULT '',
        source_seq INTEGER NOT NULL DEFAULT 0, ack_seq INTEGER NOT NULL DEFAULT 0,
        server_seq TEXT NOT NULL DEFAULT '0', needs_snapshot INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS remote_outbox (
        session_id TEXT NOT NULL, source_seq INTEGER NOT NULL, event_json TEXT NOT NULL,
        PRIMARY KEY(session_id,source_seq));
      CREATE TABLE IF NOT EXISTS remote_projection (
        session_id TEXT NOT NULL, object_key TEXT NOT NULL, hash TEXT NOT NULL,
        revision INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(session_id,object_key));
      CREATE TABLE IF NOT EXISTS remote_reply_contents (session_id TEXT NOT NULL, content_id TEXT NOT NULL, version INTEGER NOT NULL,
        message_id TEXT NOT NULL, block_id TEXT NOT NULL, format TEXT NOT NULL, sha256 TEXT NOT NULL, chunks_json TEXT NOT NULL, size_bytes INTEGER NOT NULL,
        PRIMARY KEY(session_id,content_id,version));
      CREATE TABLE IF NOT EXISTS remote_reply_chunks(session_id TEXT NOT NULL, sha256 TEXT NOT NULL, content TEXT NOT NULL, size_bytes INTEGER NOT NULL, PRIMARY KEY(session_id,sha256));
      CREATE TABLE IF NOT EXISTS remote_source_owner (source_id TEXT PRIMARY KEY, owner_json TEXT NOT NULL);
    `);
    if (!(db.prepare('PRAGMA table_info(remote_session_revisions)').all() as Array<{ name: string }>).some(column => column.name === 'clean_revision')) db.exec('ALTER TABLE remote_session_revisions ADD COLUMN clean_revision INTEGER NOT NULL DEFAULT 0');
    const syncColumns = new Set((db.prepare('PRAGMA table_info(remote_sync)').all() as Array<{ name: string }>).map(column => column.name));
    for (const [name, declaration] of Object.entries({ sync_environment: 'TEXT', sync_protocol_version: 'INTEGER NOT NULL DEFAULT 1', stream_epoch: 'TEXT',
      source_purge_seq: "TEXT NOT NULL DEFAULT '0'", event_purge_seq: "TEXT NOT NULL DEFAULT '0'", migration_frozen: 'INTEGER NOT NULL DEFAULT 0' })) {
      if (!syncColumns.has(name)) db.exec(`ALTER TABLE remote_sync ADD COLUMN ${name} ${declaration}`);
    }
    this.replyProjectionSupported = this.get<boolean>('replyProjectionMode') === true;
    this.questionProjectionSupported = this.get<boolean>('questionProjectionMode:default') === true;
    // Replace persisted dirty triggers; explicit UPSERT is not overridden by an outer UPSERT
    // conflict policy, which can turn INSERT OR IGNORE inside a trigger into an abort.
    for (const table of ['cowork_sessions', 'cowork_messages']) {
      const sid = table === 'cowork_sessions' ? 'id' : 'session_id';
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const ref = operation === 'DELETE' ? 'OLD' : 'NEW';
        db.transaction(() => db.exec(`CREATE TRIGGER IF NOT EXISTS remote_revision_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON ${table} BEGIN
          INSERT INTO remote_session_revisions(session_id,revision,dirty_at) VALUES (${ref}.${sid},1,CAST(strftime('%s','now') AS INTEGER)*1000)
          ON CONFLICT(session_id) DO UPDATE SET dirty_at=CASE WHEN revision=clean_revision THEN excluded.dirty_at ELSE dirty_at END,revision=revision+1; END;
          DROP TRIGGER IF EXISTS remote_content_${table}_${operation.toLowerCase()};
          CREATE TRIGGER remote_content_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON ${table} BEGIN INSERT INTO remote_content_dirty VALUES (${ref}.${sid}) ON CONFLICT(session_id) DO NOTHING; END;
          DROP TRIGGER IF EXISTS remote_${table}_${operation.toLowerCase()};
          CREATE TRIGGER remote_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON ${table} BEGIN
          INSERT INTO remote_dirty VALUES (${ref}.${sid}) ON CONFLICT(session_id) DO NOTHING;
          UPDATE cowork_session_ownership SET ownership_status='quarantined'
          WHERE session_id=${ref}.${sid} AND (SELECT trusted FROM remote_write_context WHERE id=1)=0;
          END;`))();
      }
    }
    this.artifactTracking = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='library_local_artifacts'").get();
    if (this.artifactTracking) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const ref = operation === 'DELETE' ? 'OLD' : 'NEW';
        db.transaction(() => db.exec(`DROP TRIGGER IF EXISTS remote_content_library_relation_${operation.toLowerCase()};
          CREATE TRIGGER remote_content_library_relation_${operation.toLowerCase()}
          AFTER ${operation} ON library_artifact_sessions BEGIN INSERT INTO remote_content_dirty VALUES (${ref}.session_id) ON CONFLICT(session_id) DO NOTHING; END;
          DROP TRIGGER IF EXISTS remote_content_library_artifact_${operation.toLowerCase()};
          CREATE TRIGGER remote_content_library_artifact_${operation.toLowerCase()}
          AFTER ${operation} ON library_local_artifacts BEGIN
          INSERT INTO remote_content_dirty SELECT session_id FROM library_artifact_sessions WHERE artifact_id=${ref}.id
          ON CONFLICT(session_id) DO NOTHING; END;
          DROP TRIGGER IF EXISTS remote_library_relation_${operation.toLowerCase()};
          CREATE TRIGGER remote_library_relation_${operation.toLowerCase()}
          AFTER ${operation} ON library_artifact_sessions BEGIN
          INSERT INTO remote_dirty SELECT ${ref}.session_id WHERE EXISTS
            (SELECT 1 FROM cowork_session_ownership WHERE session_id=${ref}.session_id AND ownership_status='confirmed') ON CONFLICT(session_id) DO NOTHING; END;
          DROP TRIGGER IF EXISTS remote_library_artifact_${operation.toLowerCase()};
          CREATE TRIGGER remote_library_artifact_${operation.toLowerCase()}
          AFTER ${operation} ON library_local_artifacts BEGIN
          INSERT INTO remote_dirty SELECT r.session_id FROM library_artifact_sessions r
            JOIN cowork_session_ownership o ON o.session_id=r.session_id
            WHERE r.artifact_id=${ref}.id AND o.ownership_status='confirmed' ON CONFLICT(session_id) DO NOTHING; END;`))();
      }
    }
    db.prepare('UPDATE remote_write_context SET trusted=0 WHERE id=1').run();
    // Large histories are reconciled in bounded pages after the shell can start.
    if (options.restoreRuns !== false) {
      if (options.deferredProjection) {
        this.recoveringRuns = true;
        this.runRecovery = new Promise(resolve => {
          let cursor = 'run:';
          const step = (): void => {
            if (!db.open) { this.recoveringRuns = false; resolve(); return; }
            try {
              const rows = db.prepare("SELECT key,value FROM remote_state WHERE key>? AND key<'run;' ORDER BY key LIMIT 50").all(cursor) as Array<{ key: string; value: string }>;
              this.recoverRunRows(rows);
              if (rows.length === 50) { cursor = rows.at(-1)!.key; setImmediate(step); return; }
            } catch { this.securityRecoveryRequired = true; }
            this.recoveringRuns = false; this.runtimeTouchedSessions.clear(); resolve();
          };
          setImmediate(step);
        });
      } else this.recoverRunRows(this.db.prepare("SELECT key,value FROM remote_state WHERE key LIKE 'run:%'").all() as Array<{ key: string; value: string }>);
    }
  }
  private recoverRunRows(rows: Array<{ key: string; value: string }>): void {
    for (const row of rows) {
      const sessionId = row.key.slice('run:'.length);
      if (this.runtimeTouchedSessions.has(sessionId)) continue;
      try {
        const run = JSON.parse(row.value) as RemoteRun;
        if (!run || typeof run.runId !== 'string' || typeof run.status !== 'string' || !/^[1-9][0-9]*$/u.test(run.statusVersion)) throw new Error('Invalid run evidence');
        if (!terminal.has(run.status)) this.updateRun(sessionId, 'reconciling');
      } catch {
        this.db.prepare('INSERT OR IGNORE INTO remote_corrupt_state VALUES (?,?,?)').run(row.key, row.value, Date.now());
        this.securityRecoveryRequired = true;
        console.warn('[RemoteSync] Invalid run evidence isolated from application startup', { key: row.key });
      }
    }
  }
  waitRunRecovery(): Promise<void> { return this.runRecovery; }

  private touchProjection(sessionId: string): void {
    this.db.prepare(`INSERT INTO remote_session_revisions(session_id,revision,dirty_at) VALUES (?,1,?)
      ON CONFLICT(session_id) DO UPDATE SET dirty_at=CASE WHEN revision=clean_revision THEN excluded.dirty_at ELSE dirty_at END,revision=revision+1`).run(sessionId, Date.now());
  }
  projectionRevision(sessionId: string): number {
    return (this.db.prepare('SELECT revision FROM remote_session_revisions WHERE session_id=?').get(sessionId) as { revision: number } | undefined)?.revision || 0;
  }
  projectionPublishing(sessionId: string): boolean { return !!this.db.prepare('SELECT 1 FROM remote_projection_publications WHERE session_id=?').get(sessionId); }
  retryProjections(): void { this.db.prepare('DELETE FROM remote_projection_failures').run(); }
  flushProjections(): Promise<void> { return this.projector?.flush() || Promise.resolve(); }
  /** A working set must not move while the worker is publishing it in bounded batches. */
  async pauseSyncTargetProjection(): Promise<void> {
    this.enabledOwner = null;
    await this.projector?.settled();
  }
  configureDetachedProjection(work: ProjectionWork): void {
    this.enabledOwner = work.owner; this.approvalProjectionSupported = work.approval; this.questionProjectionSupported = work.questions; this.inputProjectionSupported = work.input;
    this.fileProjectionSupported = work.files; this.replyProjectionSupported = work.reply; this.fileEnvironment = work.environment; this.deletionProjectionSupported = work.deletions === true;
  }
  private questionEvidenceHealthy(): boolean {
    const corrupt = this.db.prepare("SELECT 1 FROM remote_state WHERE key LIKE 'questionDecision:%' AND NOT json_valid(value) LIMIT 1").get();
    if (corrupt) this.securityRecoveryRequired = true;
    return !corrupt;
  }
  nextProjectionWork(): ProjectionWork | null {
    if (!this.questionEvidenceHealthy()) return null;
    if (!this.enabledOwner || !this.options.deferredProjection || this.securityRecoveryRequired) return null;
    const candidates = this.db.prepare(`SELECT d.session_id FROM (
      SELECT session_id FROM remote_dirty UNION SELECT session_id FROM remote_projection_publications
    ) d JOIN cowork_session_ownership o ON o.session_id=d.session_id
      JOIN remote_sync s ON s.local_id=d.session_id LEFT JOIN remote_projection_failures f ON f.session_id=d.session_id
      LEFT JOIN remote_session_revisions r ON r.session_id=d.session_id
      WHERE o.ownership_status='confirmed' AND o.owner_user_id=? AND o.owner_scope_key=? AND s.migration_frozen=0
        AND (f.session_id IS NULL OR (f.reason NOT IN ('REMOTE_PROJECTION_BUDGET','REMOTE_PROJECTION_PUBLICATION_INVALID') AND f.revision<>r.revision) OR f.retry_at<=?)
      ORDER BY r.dirty_at,d.session_id LIMIT 50 OFFSET ?`)
      .all(this.enabledOwner.userId, this.enabledOwner.scopeKey, Date.now(), this.projectionCandidateOffset) as Array<{ session_id: string }>;
    let skipped = 0;
    for (const { session_id: id } of candidates) {
      if (!this.canProjectTask(id)) { skipped++; continue; }
      const publication = this.db.prepare('SELECT * FROM remote_projection_publications WHERE session_id=?').get(id) as
        { path: string; source_seq: number; revision: number; digest: string } | undefined;
      try {
        if (this.isSyncClosed(id)) {
          this.db.prepare('DELETE FROM remote_dirty WHERE session_id=?').run(id);
          this.db.prepare('DELETE FROM remote_content_dirty WHERE session_id=?').run(id);
          if (publication) skipped++;
          continue;
        }
        const sync = this.sync(id)!;
        if (publication) {
          // Only this admitted task may reconcile an interrupted publication. A corrupt
          // epoch/evidence row must retain both its reserved sequences and original spool.
          const epoch = this.get<number>(`snapshotEpoch:${id}`) ?? 0;
          if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch >= Number.MAX_SAFE_INTEGER
            || !Number.isSafeInteger(publication.source_seq) || publication.source_seq < 0 || publication.source_seq > sync.source_seq
            || !Number.isSafeInteger(publication.revision) || publication.revision < 0
            || typeof publication.path !== 'string' || !publication.path || typeof publication.digest !== 'string' || !publication.digest) throw new Error('REMOTE_PROJECTION_PUBLICATION_INVALID');
          this.db.transaction(() => {
            this.requireSnapshot(id, 'publication_interrupted');
            this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(id);
            this.db.prepare('DELETE FROM remote_projection_publications WHERE session_id=?').run(id);
          })();
        }
        if (this.deletionProjectionSupported) this.deletionGuard(id);
        const work: ProjectionWork = { database: this.db.name, target: '', sessionId: id, owner: { ...this.enabledOwner },
          deviceId: this.projectionIdentity?.deviceId || sync.device_id, environment: this.fileEnvironment || this.projectionIdentity?.environment || null,
          agent: this.agentSummary?.(id, this.enabledOwner) || null, approval: this.approvalProjectionSupported, questions: this.questionProjectionSupported,
          input: this.inputProjectionSupported, files: this.fileProjectionSupported, reply: this.replyProjectionSupported, deletions: this.deletionProjectionSupported };
        this.projectionTargetContexts.set(work, stableJson(activeRemoteSyncTargetContext(this, work.owner)));
        this.projectionCandidateOffset = 0;
        return work;
      } catch (error) {
        if (typeof (error as { code?: unknown })?.code === 'string' && /^SQLITE_(?:CORRUPT|NOTADB|FULL|IOERR)/u.test(String((error as { code: string }).code))) throw error;
        const reason = publication ? 'REMOTE_PROJECTION_PUBLICATION_INVALID' : error instanceof Error ? error.message : 'REMOTE_PROJECTION_FAILED';
        this.recordProjectionFailure(id, reason);
        if (publication) this.db.prepare('UPDATE remote_projection_failures SET retry_at=? WHERE session_id=?').run(Number.MAX_SAFE_INTEGER, id);
        // The history lane reports the failure for this task, even if the interrupted
        // publisher crashed after removing its former dirty marker.
        this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(id);
        console.warn('[RemoteSync] Projection task selection isolated', { localSessionId: id, reason });
      }
    }
    this.projectionCandidateOffset = candidates.length < 50 ? 0 : this.projectionCandidateOffset + skipped;
    return null;
  }
  projectionWorkCurrent(work: ProjectionWork): boolean {
    return (!this.projectionTargetContexts.has(work) || this.projectionTargetContexts.get(work) === stableJson(activeRemoteSyncTargetContext(this, work.owner)))
      && !this.isSyncClosed(work.sessionId) && sameOwner(work.owner, this.enabledOwner) && sameOwner(this.owner(work.sessionId), work.owner)
      && work.approval === this.approvalProjectionSupported && work.questions === this.questionProjectionSupported && work.input === this.inputProjectionSupported
      && work.files === this.fileProjectionSupported && work.reply === this.replyProjectionSupported && (work.deletions === true) === this.deletionProjectionSupported
      && work.deviceId === (this.projectionIdentity?.deviceId || this.sync(work.sessionId)?.device_id)
      && work.environment === (this.fileEnvironment || this.projectionIdentity?.environment || null);
  }
  projectIsolatedForTest(sessionId: string): void {
    try {
      this.db.transaction(() => {
        this.project(sessionId); this.db.prepare('DELETE FROM remote_dirty WHERE session_id=?').run(sessionId);
        this.db.prepare('DELETE FROM remote_content_dirty WHERE session_id=?').run(sessionId);
      })();
    } catch (error) { this.recordProjectionFailure(sessionId, error instanceof Error ? error.message : 'REMOTE_PROJECTION_FAILED'); }
  }
  recordProjectionFailure(sessionId: string, reason: string): void {
    this.db.prepare('INSERT OR REPLACE INTO remote_projection_failures VALUES (?,?,?,?)')
      .run(sessionId, reason, reason === 'REMOTE_PROJECTION_BUDGET' ? Number.MAX_SAFE_INTEGER : Date.now() + 30_000, this.projectionRevision(sessionId));
  }
  retainObjectIdentity(sessionId: string, row: { object_key: string; revision: number; record_json: string }): void {
    const record = JSON.parse(row.record_json) as ProjectionRecord;
    if (record.eventType === RemoteQuestion.Event) return; // The private decision fact already owns question versions and content.
    if (record.payload.message) {
      const { messageId, ordinal, revision, runId, commandId } = record.payload.message;
      record.payload.message = { messageId, ordinal, revision, runId, commandId };
    }
    this.db.prepare(`INSERT INTO remote_object_state VALUES (?,?,?,?) ON CONFLICT(session_id,object_key)
      DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json WHERE excluded.revision>=remote_object_state.revision`)
      .run(sessionId, row.object_key, row.revision, stableJson(record));
  }
  setWake(listener: (urgent?: boolean) => void): void { this.wake = listener; }
  setFileTerminalBoundary(listener: (sessionId: string, runId: string) => void): void { this.fileTerminalBoundary = listener; }
  setFileEnvironment(environment: string): void { this.fileEnvironment = environment; }
  setArtifactProjectionResolver(resolver: NonNullable<RemoteStore['artifactProjection']>): void { this.artifactProjection = resolver; }
  markFilesDirty(sessionId: string): void {
    if (this.isSyncClosed(sessionId)) return;
    this.touchProjection(sessionId);
    this.db.prepare('INSERT OR IGNORE INTO remote_content_dirty VALUES (?)').run(sessionId);
    this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(sessionId);
  }
  /** Called only after negotiation and registration confirm the exact projection identity. */
  setProjectionIdentity(environment: string, owner: RemoteOwner, deviceId: string): void {
    const key = `projectionMode:${JSON.stringify([environment, owner.userId, owner.scopeKey, deviceId])}`;
    if (this.projectionIdentity?.key === key) return;
    this.projectionIdentity = { key, environment, owner: { ...owner }, deviceId };
    this.db.prepare(`UPDATE remote_sync SET sync_environment=? WHERE sync_environment IS NULL AND (device_id='' OR device_id=?)
      AND local_id IN (SELECT session_id FROM cowork_session_ownership WHERE owner_user_id=? AND owner_scope_key=?)`).run(environment, deviceId, owner.userId, owner.scopeKey);
    this.replyProjectionSupported = this.get<boolean>(key) ?? this.get<boolean>('replyProjectionMode') ?? false;
    this.questionProjectionSupported = this.get<boolean>(`questionProjectionMode:${key}`) ?? false;
  }
  private projectionSessions(): Array<{ session_id: string }> {
    const owner = this.projectionIdentity?.owner || this.enabledOwner;
    if (!owner) return [];
    const rows = this.db.prepare(`SELECT o.session_id FROM cowork_session_ownership o JOIN remote_sync s ON s.local_id=o.session_id
      WHERE o.ownership_status='confirmed' AND o.owner_user_id=? AND o.owner_scope_key=?
      AND (?='' OR s.device_id='' OR s.device_id=?) AND (? IS NULL OR s.sync_environment IS NULL OR s.sync_environment=?)`).all(owner.userId, owner.scopeKey,
      this.projectionIdentity?.deviceId || '', this.projectionIdentity?.deviceId || '', this.projectionIdentity?.environment || null, this.projectionIdentity?.environment || null) as Array<{ session_id: string }>;
    return rows.filter(row => !this.isSyncClosed(row.session_id));
  }
  setFileProjectionSupported(supported: boolean): void {
    if (supported === this.fileProjectionSupported) return;
    this.fileProjectionSupported = supported;
    for (const { session_id } of this.projectionSessions()) this.markFilesDirty(session_id);
  }
  /** Changing the wire projection requires an atomic snapshot, never mixed-version replay. */
  setReplyProjectionSupported(supported: boolean): void {
    const modeKey = this.projectionIdentity?.key || 'replyProjectionMode';
    if (supported === this.replyProjectionSupported) { this.put(modeKey, supported); return; }
    this.replyProjectionSupported = supported;
    this.transaction(() => {
      this.put(modeKey, supported);
      for (const { session_id } of this.projectionSessions()) {
        this.requireSnapshot(session_id, 'projection_changed');
        this.markFilesDirty(session_id);
      }
    });
  }
  private replyContent(sessionId: string, messageId: string, blockId: string, format: RemoteReplyFormat, text: string): RemoteReplyContentRef {
    const contentId = createHash('sha256').update(`${messageId}:${blockId}`).digest('hex');
    const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    const previous = this.db.prepare('SELECT version,sha256 FROM remote_reply_contents WHERE session_id=? AND content_id=? ORDER BY version DESC LIMIT 1').get(sessionId, contentId) as { version: number; sha256: string } | undefined;
    const versionKey = `replyContentVersion:${sessionId}:${contentId}`;
    const version = previous?.sha256 === sha256 ? previous.version : Math.max(previous?.version || 0, this.get<number>(versionKey) || 0) + 1;
    this.put(versionKey, Math.max(version, this.get<number>(versionKey) || 0));
    if (previous?.sha256 !== sha256) {
      const chunks = replyChunks(text);
      for (const chunk of chunks) this.db.prepare('INSERT OR IGNORE INTO remote_reply_chunks VALUES (?,?,?,?)').run(sessionId, chunk.sha256, chunk.text, Number(chunk.sizeBytes));
      this.db.prepare('INSERT INTO remote_reply_contents VALUES (?,?,?,?,?,?,?,?,?)').run(sessionId, contentId, version, messageId, blockId, format, sha256, stableJson(chunks.map(({ sha256, sizeBytes }) => ({ sha256, sizeBytes }))), Buffer.byteLength(text));
    }
    return { contentId, version: String(version), sizeBytes: String(Buffer.byteLength(text)), sha256, format };
  }
  /** Resolve only locally persisted references, never caller-provided file paths. */
  replyContentUploads(sessionId: string, records: ProjectionRecord[]): RemoteReplyUpload[] {
    const uploads = new Map<string, RemoteReplyUpload>();
    for (const record of records) for (const block of record.payload.message?.blocks || []) {
      const ref = block.contentRef as RemoteReplyContentRef | undefined;
      if (!ref) continue;
      const row = this.db.prepare('SELECT * FROM remote_reply_contents WHERE session_id=? AND content_id=? AND version=?').get(sessionId, ref.contentId, ref.version) as any;
      if (!row || row.message_id !== record.payload.message.messageId || row.block_id !== block.blockId || row.sha256 !== ref.sha256 || String(row.size_bytes) !== ref.sizeBytes || row.format !== ref.format) throw new Error('Reply content reference has no matching durable local content');
      const chunks = (JSON.parse(row.chunks_json) as Array<{ sha256: string; sizeBytes: string }>).map(chunk => {
        const data = this.db.prepare('SELECT content,size_bytes FROM remote_reply_chunks WHERE session_id=? AND sha256=?').get(sessionId, chunk.sha256) as { content: string; size_bytes: number } | undefined;
        if (!data || String(data.size_bytes) !== chunk.sizeBytes || createHash('sha256').update(data.content, 'utf8').digest('hex') !== chunk.sha256) throw new Error('Reply content chunk is missing or corrupt');
        return { ...chunk, text: data.content };
      });
      uploads.set(`${ref.contentId}:${ref.version}`, { ...ref, messageId: row.message_id, blockId: row.block_id, chunks });
    }
    return [...uploads.values()];
  }
  /** Retain exact references held by projections, immutable outbox events and resumable imports. */
  pruneReplyContents(sessionId: string): void {
    if (this.options.deferredProjection && this.options.restoreRuns !== false) return;
    if (this.projectionPublishing(sessionId)) return;
    // A disk-backed import holds immutable references outside this database; keep its content versions until its terminal ACK/abort.
    if (this.get<{ fileSet?: string }>(`import:${sessionId}`)?.fileSet) return;
    const refs = new Set<string>();
    const visit = (value: any): void => {
      if (!value || typeof value !== 'object') return;
      if (value.contentRef?.contentId && value.contentRef?.version) refs.add(`${value.contentRef.contentId}:${value.contentRef.version}`);
      for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
    };
    for (const row of this.db.prepare('SELECT record_json AS json FROM remote_projection WHERE session_id=? UNION ALL SELECT event_json AS json FROM remote_outbox WHERE session_id=?').all(sessionId, sessionId) as Array<{ json: string }>) visit(JSON.parse(row.json));
    visit(this.get(`import:${sessionId}`));
    const chunkRefs = new Set<string>();
    for (const row of this.db.prepare('SELECT content_id,version,chunks_json FROM remote_reply_contents WHERE session_id=?').all(sessionId) as Array<{ content_id: string; version: number; chunks_json: string }>) {
      if (refs.has(`${row.content_id}:${row.version}`)) for (const chunk of JSON.parse(row.chunks_json)) chunkRefs.add(chunk.sha256);
      else this.db.prepare('DELETE FROM remote_reply_contents WHERE session_id=? AND content_id=? AND version=?').run(sessionId, row.content_id, row.version);
    }
    for (const row of this.db.prepare('SELECT sha256 FROM remote_reply_chunks WHERE session_id=?').all(sessionId) as Array<{ sha256: string }>) {
      if (!chunkRefs.has(row.sha256)) this.db.prepare('DELETE FROM remote_reply_chunks WHERE session_id=? AND sha256=?').run(sessionId, row.sha256);
    }
  }
  setEnabledOwner(owner: RemoteOwner | null): void { this.enabledOwner = owner; }
  setApprovalProjectionSupported(supported: boolean): void { this.approvalProjectionSupported = supported; }
  setQuestionProjectionSupported(supported: boolean): void {
    const key = `questionProjectionMode:${this.projectionIdentity?.key || 'default'}`;
    if (supported === this.questionProjectionSupported) { this.put(key, supported); return; }
    this.questionProjectionSupported = supported;
    this.transaction(() => {
      this.put(key, supported);
      for (const { session_id } of this.projectionSessions()) {
        this.requireSnapshot(session_id, 'question_projection_changed');
        this.markFilesDirty(session_id);
      }
    });
  }
  /** Public projection is recoverable from the private decision fact after a cache write failure. */
  questionStates(sessionId: string): RemoteQuestionState[] {
    this.questionEvidenceHealthy();
    const values = new Map(this.entries<RemoteQuestionState>(`question:${sessionId}:`).map(row => [row.value.questionId, row.value]));
    const facts = this.db.prepare("SELECT value FROM remote_state WHERE key LIKE 'questionDecision:%' AND CASE WHEN json_valid(value) THEN json_extract(value,'$.state.sessionId') END=?").all(sessionId) as Array<{ value: string }>;
    for (const row of facts) {
      const { state, binding } = JSON.parse(row.value) as { state: LocalQuestionState; binding: { owner: RemoteOwner | null } };
      const owner = this.owner(sessionId);
      if (!binding || (binding.owner !== null || owner !== null) && !sameOwner(binding.owner, owner)) { values.delete(state.questionId); continue; }
      const { requestId: _requestId, sessionId: _sessionId, ...question } = state;
      const previous = values.get(question.questionId);
      if (!previous || BigInt(previous.questionVersion) <= BigInt(question.questionVersion)) values.set(question.questionId, question);
    }
    return [...values.values()];
  }
  updateQuestion(sessionId: string, question: RemoteQuestionState): void {
    this.transaction(() => {
      const key = `question:${sessionId}:${question.questionId}`;
      const previous = this.get<RemoteQuestionState>(key);
      if (previous && (BigInt(previous.questionVersion) >= BigInt(question.questionVersion)
        || previous.status !== 'pending' && question.status === 'pending')) return;
      this.put(key, question);
      if (!previous || previous.status !== question.status || previous.remoteAllowed !== question.remoteAllowed
        || previous.resolution.phase !== question.resolution.phase) this.bumpControl(sessionId);
      this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(sessionId);
      this.refreshApprovalRunState(sessionId);
    });
  }
  setApprovalLifecycle(lifecycle: { expire(now: number): void; close(sessionId: string, runId: string, status: string): void }): void { this.approvalLifecycle = lifecycle; }
  /** Private runtime decisions and their public event are committed in the same SQLite transaction. */
  updateApproval(sessionId: string, approval: Record<string, any>): void {
    this.transaction(() => {
      const key = `approval:${sessionId}:${approval.approvalId}`;
      const previous = this.get<any>(key);
      if (previous && (BigInt(previous.approvalVersion) >= BigInt(approval.approvalVersion))) return;
      if (previous && previous.status !== 'pending' && approval.status === 'pending') return;
      this.put(key, approval);
      const controlChanged = !previous || ['status', 'remoteAllowed', 'requiresLocalAction'].some(field => previous[field] !== approval[field])
        || previous.resolution?.phase !== approval.resolution?.phase;
      if (controlChanged) this.bumpControl(sessionId);
      this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(sessionId);
      this.refreshApprovalRunState(sessionId);
    });
  }
  updateLocalApprovalBlocker(sessionId: string, requestId: string, runId: string | null, pending: boolean): void {
    this.transaction(() => {
      const key = `localApprovalBlocker:${sessionId}:${requestId}`;
      if (pending) this.put(key, { runId, status: 'pending', requiresLocalAction: true });
      else this.remove(key);
      this.refreshApprovalRunState(sessionId);
    });
  }
  /** Approval completion alone never proves the engine has resumed its run. */
  refreshApprovalRunState(sessionId: string, engineRunning = false): void {
    const run = this.run(sessionId);
    if (!run || terminal.has(run.status)) return;
    const pending = [...this.entries<any>(`approval:${sessionId}:`), ...this.entries<any>(`localApprovalBlocker:${sessionId}:`)].map(row => row.value)
      .filter(approval => approval.runId === run.runId && approval.status === 'pending');
    const questions = this.questionStates(sessionId).filter(question => question.runId === run.runId && question.status === 'pending');
    const status = pending.some(approval => approval.resolution?.phase === 'unknown') || questions.some(question => question.resolution.phase === 'unknown') ? 'reconciling'
      : pending.some(approval => approval.requiresLocalAction && (!approval.resolution || approval.resolution.phase === 'idle')) ? 'waiting_local'
      : questions.length ? 'waiting_local' : pending.length ? 'waiting_approval' : engineRunning ? 'running' : null;
    if (status) this.updateRun(sessionId, status);
  }
  setAgentSummaryResolver(resolver: ((sessionId: string, owner: RemoteOwner) => RemoteAgentSummary | null) | null): void {
    if (Boolean(this.agentSummary) === Boolean(resolver)) { this.agentSummary = resolver; return; }
    this.agentSummary = resolver;
    if (resolver) for (const { session_id } of this.projectionSessions()) this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(session_id);
  }
  setInputProjectionSupported(supported: boolean): void {
    if (this.inputProjectionSupported === supported) return;
    this.inputProjectionSupported = supported;
    for (const { session_id } of this.projectionSessions()) this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(session_id);
  }
  inputVersion(sessionId: string): string {
    const row = this.db.prepare('SELECT model_override,thinking_level FROM cowork_sessions WHERE id=?').get(sessionId);
    if (!row) return '0';
    const signature = payloadHash(row);
    const previous = this.get<string>(`inputSignature:${sessionId}`);
    let version = this.get<string>(`inputVersion:${sessionId}`) || '0';
    if (previous !== signature) {
      if (previous !== null) { version = String(BigInt(version) + 1n); this.remove(`inputModel:${sessionId}`); }
      this.put(`inputSignature:${sessionId}`, signature); this.put(`inputVersion:${sessionId}`, version);
    }
    return version;
  }
  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM remote_state WHERE key=?').get(key) as { value: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.value) as T; }
    catch (error) {
      if (!/^(?:replyProjectionMode$|projectionMode:|questionProjectionMode:|syncFailure:|agentCatalogFailure:|lastSuccessfulSync:)/u.test(key)) throw error;
      // Only reconstructible/display-only keys have a fallback; run/approval/inbox/ownership facts never do.
      this.db.prepare('INSERT OR IGNORE INTO remote_corrupt_state VALUES (?,?,?)').run(key, row.value, Date.now());
      this.db.prepare('DELETE FROM remote_state WHERE key=?').run(key);
      if (key === 'replyProjectionMode' || key.startsWith('projectionMode:') || key.startsWith('questionProjectionMode:')) this.db.prepare('UPDATE remote_sync SET needs_snapshot=1').run();
      return null;
    }
  }
  put(key: string, value: unknown): void {
    const parts = key.split(':');
    if (parts[1] && ['deletionGuard', 'run', 'runHistory', 'control', 'approval', 'question', 'localApprovalBlocker', 'inputModel', 'inputVersion', 'inputSignature'].includes(parts[0])) this.touchProjection(parts[1]);
    if (this.depth === 0 && this.advanceCheckpoint) { this.transaction(() => this.put(key, value)); return; }
    this.db.prepare('INSERT INTO remote_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, stableJson(value));
    if (parts[0] === 'questionDecision') {
      const sessionId = (value as { state?: { sessionId?: string } }).state?.sessionId;
      if (sessionId) { this.touchProjection(sessionId); this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(sessionId); }
    }
  }
  remove(key: string): void { this.db.prepare('DELETE FROM remote_state WHERE key=?').run(key); }
  entries<T>(prefix: string, after?: string, limit?: number): Array<{ key: string; value: T }> {
    const rows = after !== undefined || limit !== undefined
      ? this.db.prepare('SELECT key,value FROM remote_state WHERE key LIKE ? AND key>? ORDER BY key LIMIT ?')
        .all(`${prefix}%`, after || '', Math.max(1, Math.min(200, Number.isFinite(limit) ? Math.floor(limit!) : 50)))
      : this.db.prepare('SELECT key,value FROM remote_state WHERE key LIKE ?').all(`${prefix}%`);
    return (rows as any[])
      .map(row => ({ key: row.key, value: JSON.parse(row.value) as T }));
  }
  transaction<T>(operation: () => T): T {
    if (this.depth > 0) return operation();
    const beforeChange = this.changeVersion;
    this.urgentReplyChange = false;
    const result = this.db.transaction(() => {
      this.depth++;
      this.db.prepare('UPDATE remote_write_context SET trusted=1 WHERE id=1').run();
      try {
        const value = operation();
        if (!this.publishing && !this.options.deferredProjection) this.captureDirty();
        if (this.advanceCheckpoint) this.put('databaseCheckpoint', this.advanceCheckpoint());
        return value;
      } finally {
        this.db.prepare('UPDATE remote_write_context SET trusted=0 WHERE id=1').run();
        this.depth--;
      }
    })();
    if (this.options.deferredProjection || this.changeVersion !== beforeChange) this.wake(this.urgentReplyChange);
    return result;
  }
  owner(sessionId: string): RemoteOwner | null {
    const row = this.db.prepare("SELECT owner_user_id,owner_scope_key FROM cowork_session_ownership WHERE session_id=? AND ownership_status='confirmed'").get(sessionId) as any;
    return row ? { userId: row.owner_user_id, scopeKey: row.owner_scope_key } : null;
  }
  /** Absence is anonymous; quarantined rows must never be treated as anonymous. */
  ownershipRecord(sessionId: string): SessionOwnershipRecord | null {
    return this.db.prepare('SELECT * FROM cowork_session_ownership WHERE session_id=?')
      .get(sessionId) as SessionOwnershipRecord | undefined ?? null;
  }
  associateHistorical(sessionId: string, owner: RemoteOwner, associatedAt: number): void {
    if (!this.db.inTransaction || this.depth === 0) throw new Error('Historical association requires a trusted session transaction');
    if (!this.db.prepare('SELECT 1 FROM cowork_sessions WHERE id=?').get(sessionId)
      || this.ownershipRecord(sessionId) || this.sync(sessionId)) {
      throw new Error('Only genuinely anonymous sessions can be associated');
    }
    this.db.prepare('INSERT INTO cowork_session_ownership VALUES (?,?,?,?,?,?)')
      .run(sessionId, owner.userId, owner.scopeKey, 'confirmed', OWNERSHIP_MANUAL_SOURCE, associatedAt);
    this.signOwnership(sessionId, owner);
    this.db.prepare('INSERT INTO remote_sync(local_id,session_id) VALUES (?,?)').run(sessionId, randomUUID());
    this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(sessionId);
  }
  assertActor(sessionId: string, actor: RemoteOwner | null): void {
    const row = this.db.prepare('SELECT ownership_status FROM cowork_session_ownership WHERE session_id=?').get(sessionId) as any;
    if (row && (row.ownership_status !== 'confirmed' || !sameOwner(this.owner(sessionId), actor))) throw new Error('Session belongs to another account or requires local recovery');
  }
  assignNew(sessionId: string, owner: RemoteOwner | null, source: string): void {
    if (!owner) return;
    if (!this.db.inTransaction || this.depth === 0) throw new Error('Ownership must be recorded in the creation transaction');
    this.db.prepare('INSERT INTO cowork_session_ownership VALUES (?,?,?,?,?,?)').run(sessionId, owner.userId, owner.scopeKey, 'confirmed', source, Date.now());
    this.signOwnership(sessionId, owner);
    this.db.prepare('INSERT INTO remote_sync(local_id,session_id) VALUES (?,?)').run(sessionId, randomUUID());
  }
  inheritNew(sessionId: string, parentId: string): void { this.assignNew(sessionId, this.owner(parentId), 'inherited_parent'); }
  bindSource(sourceId: string, owner: RemoteOwner | null): void {
    if (!owner) return;
    this.db.prepare('INSERT OR IGNORE INTO remote_source_owner VALUES (?,?)').run(sourceId, stableJson(owner));
  }
  sourceOwner(sourceId: string): RemoteOwner | null {
    const row = this.db.prepare('SELECT owner_json FROM remote_source_owner WHERE source_id=?').get(sourceId) as any;
    return row ? JSON.parse(row.owner_json) : null;
  }
  validateDatabaseInstance(instanceId: string, checkpoint = 0, advance?: () => number): void {
    const stored = this.get<string>('databaseInstance');
    if ((stored && stored !== instanceId) || (this.get<number>('databaseCheckpoint') || 0) !== checkpoint) {
      this.db.transaction(() => {
        this.db.prepare("UPDATE cowork_session_ownership SET ownership_status='quarantined'").run();
        this.db.prepare('DELETE FROM remote_outbox').run();
        this.db.prepare('DELETE FROM remote_source_owner').run();
        this.put('executionHistoryComplete', false);
        this.db.prepare("DELETE FROM remote_state WHERE key LIKE 'inbox:%' OR key LIKE 'import:%' OR key LIKE 'registration:%'").run();
      })();
    }
    this.put('databaseInstance', instanceId);
    this.put('databaseCheckpoint', checkpoint);
    this.advanceCheckpoint = advance || null;
  }
  async verifyExecutionDatabaseHealth(): Promise<boolean> {
    return this.databaseHealth ? this.databaseHealth.verify() : this.db.pragma('quick_check', { simple: true }) === 'ok';
  }
  hasCompleteExecutionHistory(): boolean {
    return !this.recoveringRuns && !this.securityRecoveryRequired && this.get<boolean>('executionHistoryComplete') !== false
      && (this.databaseHealth ? this.databaseHealth.current() : this.db.pragma('quick_check', { simple: true }) === 'ok');
  }
  markRunDispatched(sessionId: string): void {
    const run = this.run(sessionId);
    if (!run) return;
    this.transaction(() => {
      // Publishing a reserved run changes the summary from run=null to this run.
      // It must have a newer control version even if execution has not left starting yet.
      if (this.get<boolean>(`runPublished:${run.runId}`) === false) this.bumpControl(sessionId);
      this.put(`runPublished:${run.runId}`, true);
      this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(sessionId);
    });
  }
  quarantineAll(): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE cowork_session_ownership SET ownership_status='quarantined'").run();
      this.db.prepare('DELETE FROM remote_outbox').run();
    })();
  }
  sync(sessionId: string): SyncRow | null { return this.db.prepare('SELECT * FROM remote_sync WHERE local_id=?').get(sessionId) as SyncRow || null; }
  sessions(owner: RemoteOwner): SyncRow[] {
    return this.db.prepare(`SELECT s.* FROM remote_sync s JOIN cowork_session_ownership o ON o.session_id=s.local_id
      WHERE o.owner_user_id=? AND o.owner_scope_key=? AND o.ownership_status='confirmed'`).all(owner.userId, owner.scopeKey) as SyncRow[];
  }
  localSessionId(remoteSessionId: string): string | null {
    return (this.db.prepare('SELECT local_id FROM remote_sync WHERE session_id=?').get(remoteSessionId) as any)?.local_id || null;
  }
  bindRemote(sessionId: string, remoteId: string, deviceId: string): void {
    const row = this.sync(sessionId);
    if (row?.sync_protocol_version === RemoteRetention.Version && (row.session_id !== remoteId || row.device_id !== deviceId)) throw new RemoteSyncStateError('Cannot rebind an active synchronization stream');
    this.db.prepare('UPDATE remote_sync SET session_id=?,device_id=?,sync_environment=COALESCE(sync_environment,?) WHERE local_id=?')
      .run(remoteId, deviceId, this.projectionIdentity?.environment || null, sessionId);
  }
  setDeletionProjectionSupported(supported: boolean): void {
    if (this.deletionProjectionSupported === supported) return;
    this.deletionProjectionSupported = supported;
    for (const { session_id } of this.projectionSessions()) {
      if (supported) this.deletionGuard(session_id);
      this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(session_id);
    }
  }
  deletionGuard(sessionId: string): DeletionGuard {
    const key = `${RemoteDeletion.Guard}${sessionId}`;
    const saved = this.get<DeletionGuard>(key);
    if (saved) return saved;
    const guard = { version: '1', runId: this.run(sessionId)?.runId || null };
    this.put(key, guard);
    return guard;
  }
  assertNoDeletionEffect(sessionId: string): void {
    const fence = this.get<{ phase: string }>(`${RemoteDeletion.Fence}${sessionId}`);
    if (this.get(`${RemoteDeletion.Closed}${sessionId}`) || fence && [RemoteDeletion.EffectStarted, RemoteDeletion.Stopped, RemoteDeletion.Reconciling].some(phase => phase === fence.phase)) {
      throw new Error('REMOTE_SESSION_DELETION_IN_PROGRESS');
    }
  }
  /** Local deletion is global; its remote closure receipt closes only the original stream. */
  isSyncClosed(sessionId: string): boolean {
    if (!this.get(`${RemoteDeletion.Closed}${sessionId}`)) return false;
    const row = this.sync(sessionId), owner = this.owner(sessionId);
    const deleted = this.get<{ owner: RemoteOwner; sessionId: string; deviceId: string; environment: string | null; streamEpoch: string | null }>(`localGcDeleted:${sessionId}`);
    if (!row || !owner || !deleted || !sameOwner(owner, deleted.owner)
      || this.db.prepare('SELECT 1 FROM cowork_sessions WHERE id=?').get(sessionId)) return true;
    return row.session_id === deleted.sessionId && row.device_id === deleted.deviceId && row.stream_epoch === deleted.streamEpoch
      && (!row.sync_environment || !deleted.environment
        || samePersistedRemoteEnvironment(this, { owner, deviceId: row.device_id }, row.sync_environment, deleted.environment));
  }
  advanceDeletionGuard(sessionId: string, runId?: string | null): void {
    this.assertNoDeletionEffect(sessionId);
    const previous = this.deletionGuard(sessionId);
    this.put(`${RemoteDeletion.Guard}${sessionId}`, { version: String(BigInt(previous.version) + 1n), runId: runId === undefined ? previous.runId : runId });
  }
  run(sessionId: string): RemoteRun | null { return this.get<RemoteRun>(`run:${sessionId}`); }
  controlVersion(sessionId: string): string { return this.get<string>(`control:${sessionId}`) || '0'; }
  beginRun(sessionId: string, runId: string = randomUUID(), commandId: string | null = null): RemoteRun {
    if (this.recoveringRuns) this.runtimeTouchedSessions.add(sessionId);
    this.assertNoDeletionEffect(sessionId);
    const previous = this.run(sessionId);
    if (previous && !terminal.has(previous.status)) throw new Error('REMOTE_SESSION_BUSY');
    const run: RemoteRun = { runId, status: 'starting', statusVersion: '1', startedAt: iso(Date.now()), finishedAt: null, error: null };
    this.transaction(() => {
      this.advanceDeletionGuard(sessionId, runId);
      this.remove(`gatewayRun:${sessionId}`);
      const runOrdinal = String(BigInt(this.get<string>(`fileRunOrdinal:${sessionId}`) || '0') + 1n);
      this.put(`fileRunOrdinal:${sessionId}`, runOrdinal);
      this.put(`fileRunOrdinal:${sessionId}:${runId}`, runOrdinal);
      this.put(`run:${sessionId}`, run);
      this.put(`runHistory:${sessionId}:${runId}`, run);
      const owner = this.owner(sessionId);
      const target = owner ? activeRemoteSyncTargetContext(this, owner) : null;
      if (target) this.put(`syncRunTarget:${runId}`, target.targetId);
      this.put(`runCommand:${sessionId}`, commandId);
      this.put(`runPublished:${runId}`, commandId === null);
      this.bumpControl(sessionId);
      this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(sessionId);
    });
    return run;
  }
  updateRun(sessionId: string, status: RemoteRunStatusValue, error?: string): void {
    if (this.recoveringRuns) this.runtimeTouchedSessions.add(sessionId);
    const previous = this.run(sessionId);
    if (!previous || terminal.has(previous.status) || previous.status === status) return;
    this.transaction(() => {
      this.put(`run:${sessionId}`, { ...previous, status, statusVersion: String(BigInt(previous.statusVersion) + 1n),
        finishedAt: terminal.has(status) ? iso(Date.now()) : null,
        error: error ? remoteError(47019, 'EXECUTION_FAILED', error) : null });
      if (terminal.has(status)) {
        try { this.fileTerminalBoundary?.(sessionId, previous.runId); }
        catch { console.warn('[RemoteFiles] Final snapshot capture deferred'); }
        this.approvalLifecycle?.close(sessionId, previous.runId, status);
        // Legacy records have no private decision service; never invent a decision from resolution alone.
        for (const { key, value: approval } of this.entries<any>(`approval:${sessionId}:`)) {
          if (approval.runId === previous.runId && approval.status === 'pending' && !approval.resolution) this.put(key, { ...approval, remoteAllowed: false, status: 'cancelled', approvalVersion: String(BigInt(approval.approvalVersion) + 1n), resolvedAt: iso(Date.now()) });
        }
      }
      this.put(`runHistory:${sessionId}:${previous.runId}`, this.run(sessionId));
      this.bumpControl(sessionId);
      this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(sessionId);
    });
  }
  expireApprovals(now = Date.now()): void {
    this.approvalLifecycle?.expire(now);
    const expired = this.entries<any>('approval:').filter(row => row.value.status === 'pending' && !row.value.resolution && Date.parse(row.value.expiresAt) <= now);
    if (!expired.length) return;
    this.transaction(() => {
      for (const { key, value: approval } of expired) {
        const sessionId = key.slice('approval:'.length, key.indexOf(':', 'approval:'.length));
        this.put(key, { ...approval, remoteAllowed: false, status: 'expired', resolvedAt: iso(now), approvalVersion: String(BigInt(approval.approvalVersion) + 1n) });
        this.bumpControl(sessionId);
        this.refreshApprovalRunState(sessionId);
        this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(sessionId);
      }
    });
  }
  private bumpControl(sessionId: string): void { this.put(`control:${sessionId}`, String(BigInt(this.controlVersion(sessionId)) + 1n)); }

  requireSnapshot(sessionId: string, reason = 'local_change'): void {
    if (this.isSyncClosed(sessionId)) return;
    this.put(`snapshotReason:${sessionId}`, reason);
    this.db.prepare('UPDATE remote_sync SET needs_snapshot=1 WHERE local_id=?').run(sessionId);
    this.put(`snapshotEpoch:${sessionId}`, (this.get<number>(`snapshotEpoch:${sessionId}`) || 0) + 1);
  }
  /** Repair old run-publication events without rewriting their assigned source sequences. */
  requireRunMappingSnapshot(sessionId: string): void {
    this.transaction(() => {
      // A legacy null-run summary may already be committed at the current control version.
      this.bumpControl(sessionId);
      this.requireSnapshot(sessionId);
      this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(sessionId);
    });
  }
  private captureDirty(): void {
    this.publishing = true;
    try {
      const dirty = this.db.prepare('SELECT session_id FROM remote_dirty').all() as Array<{ session_id: string }>;
      let processed = false;
      for (const { session_id: id } of dirty) {
        if (!this.canProjectTask(id)) continue;
        if (this.isSyncClosed(id)) { this.db.prepare('DELETE FROM remote_dirty WHERE session_id=?').run(id); this.db.prepare('DELETE FROM remote_content_dirty WHERE session_id=?').run(id); continue; }
        if (this.sync(id)?.migration_frozen) continue;
        // Consume only this marker; frozen records survive commits and process restarts.
        const contentDirty = Boolean(this.db.prepare('SELECT 1 FROM remote_content_dirty WHERE session_id=?').get(id));
        this.db.prepare('DELETE FROM remote_dirty WHERE session_id=?').run(id);
        this.db.prepare('DELETE FROM remote_content_dirty WHERE session_id=?').run(id);
        processed = true;
        const owner = this.owner(id);
        if (!owner) {
          console.debug('[RemoteSync] Projection skipped', { localSessionId: id, reason: 'owner_not_confirmed' });
          continue;
        }
        if (!sameOwner(owner, this.enabledOwner)) {
          console.debug('[RemoteSync] Snapshot required while synchronization disabled', { localSessionId: id });
          this.requireSnapshot(id);
          continue;
        }
        const hasAgentChanges = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_ownership_dirty'").get();
        const summaryOnly = !contentDirty && Boolean(hasAgentChanges && this.db.prepare(`SELECT 1 FROM cowork_sessions s JOIN agent_ownership_dirty a ON a.agent_id=s.agent_id WHERE s.id=?`).get(id));
        const before = this.sync(id);
        try { this.project(id, summaryOnly); }
        catch (error) {
          console.warn('[RemoteSync] Local projection failed; transaction will roll back', { localSessionId: id, sessionId: before?.session_id ?? null,
            sourceSeq: before?.source_seq ?? null, ...remoteSyncErrorMetadata(error) });
          throw error;
        }
        const after = this.sync(id);
        if (after && after.source_seq !== before?.source_seq) console.debug('[RemoteSync] Local projection staged', {
          localSessionId: id, sessionId: after.session_id, sourceSeq: after.source_seq, previousSourceSeq: before?.source_seq ?? null,
          ackSourceSeq: after.ack_seq, serverSeq: after.server_seq, needsSnapshot: Boolean(after.needs_snapshot),
          controlVersion: this.controlVersion(id), runId: this.run(id)?.runId ?? null, runStatus: this.run(id)?.status ?? null, summaryOnly });
      }
      // Anonymous artifact triggers have no remote_dirty counterpart; they need no durable projection marker.
      this.db.prepare(`DELETE FROM remote_content_dirty WHERE NOT EXISTS (SELECT 1 FROM remote_dirty d WHERE d.session_id=remote_content_dirty.session_id)
        AND NOT EXISTS (SELECT 1 FROM cowork_session_ownership o WHERE o.session_id=remote_content_dirty.session_id AND o.ownership_status='confirmed')`).run();
      if (processed) this.changeVersion++;
    } finally { this.publishing = false; }
  }
  private record(sessionId: string, key: string, record: ProjectionRecord): void {
    const old = this.db.prepare('SELECT hash,revision,record_json FROM remote_projection WHERE session_id=? AND object_key=?').get(sessionId, key) as any;
    if (old && record.payload.message) {
      const previous = JSON.parse(old.record_json).payload.message;
      if (previous) {
        record.payload.message.ordinal = previous.ordinal;
        record.payload.message.runId = previous.runId;
        record.payload.message.commandId = previous.commandId;
      }
    }
    if (old && record.payload.tool) {
      const previous = JSON.parse(old.record_json).payload.tool;
      if (previous) { record.payload.tool.runId = previous.runId; record.payload.tool.startedAt = previous.startedAt; }
    }
    const hash = payloadHash(record);
    if (old?.hash === hash) return;
    const revision = (old?.revision || 0) + 1;
    const projected = JSON.parse(stableJson(record)) as ProjectionRecord;
    if (projected.payload.message) projected.payload.message.revision = String(revision);
    if (projected.payload.tool) projected.payload.tool.revision = String(revision);
    this.db.prepare(`INSERT INTO remote_projection VALUES (?,?,?,?,?) ON CONFLICT(session_id,object_key)
      DO UPDATE SET hash=excluded.hash,revision=excluded.revision,record_json=excluded.record_json`)
      .run(sessionId, key, hash, revision, stableJson(projected));
    const previousMessage = old ? JSON.parse(old.record_json).payload.message : undefined;
    const delta = this.replyProjectionSupported && projected.payload.message ? replyAppendDelta(previousMessage, projected.payload.message) : null;
    this.enqueue(sessionId, delta ? { eventType: RemoteReply.DeltaEvent, payload: delta } : projected);
  }
  private enqueue(sessionId: string, record: ProjectionRecord): void {
    const row = this.sync(sessionId);
    if (!row) return;
    if (this.replyProjectionSupported && ((record.eventType === 'run.updated' && terminal.has(record.payload.run?.status))
      || record.eventType === 'approval.updated' || record.eventType === RemoteQuestion.Event || (record.eventType === 'tool.upsert' && (record.payload.tool?.revision === '1' || terminal.has(record.payload.tool?.status))))) this.urgentReplyChange = true;
    if (row.migration_frozen) throw new Error('Remote migration projection is frozen');
    const sourceSeq = safeSourceSequence(String(row.source_seq + 1));
    const event: RemoteEvent = { ...record, eventId: row.sync_protocol_version === RemoteRetention.Version
      ? retentionEventId(row.device_id, row.session_id, row.stream_epoch || '', String(sourceSeq)) : randomUUID(), sourceSeq: String(sourceSeq), occurredAt: iso(Date.now()) };
    this.db.prepare('UPDATE remote_sync SET source_seq=? WHERE local_id=?').run(sourceSeq, sessionId);
    // A full snapshot supersedes unsent events only after its durable server commit.
    this.db.prepare('INSERT INTO remote_outbox VALUES (?,?,?)').run(sessionId, sourceSeq, stableJson(event));
    const size = this.db.prepare('SELECT count(*) AS n,sum(length(event_json)) AS bytes FROM remote_outbox WHERE session_id=?').get(sessionId) as any;
    if (size.n > 2000 || size.bytes > 16 * 1024 * 1024) {
      this.requireSnapshot(sessionId, 'outbox_limit');
      // Snapshot projection is durable; no assigned payload is rewritten or reused.
      this.db.prepare('DELETE FROM remote_outbox WHERE session_id=?').run(sessionId);
    }
  }
  private projectApproval(sessionId: string, approval: Record<string, any>): void {
    const { pendingDecision: _pending, resolution, ...legacy } = approval;
    let safe: Record<string, any> = this.approvalProjectionSupported ? { ...legacy, ...(resolution ? { resolution } : {}) } : { ...legacy, remoteAllowed: false };
    const prior = this.db.prepare('SELECT record_json FROM remote_projection WHERE session_id=? AND object_key=?').get(sessionId, `approval:${approval.approvalId}`) as { record_json: string } | undefined;
    const priorApproval = prior ? JSON.parse(prior.record_json).payload.approval : null;
    // Capability negotiation alone cannot change the immutable content of an already
    // published approval version (including a closed legacy item or an active reservation).
    if (priorApproval?.approvalVersion === approval.approvalVersion) safe = priorApproval;
    this.record(sessionId, `approval:${safe.approvalId}`, { eventType: 'approval.updated', payload: { approval: safe, controlVersion: this.controlVersion(sessionId) } });
  }
  private projectQuestion(sessionId: string, question: RemoteQuestionState): void {
    this.record(sessionId, `question:${question.questionId}`, { eventType: RemoteQuestion.Event, payload: { question, controlVersion: this.controlVersion(sessionId) } });
  }
  project(sessionId: string, summaryOnly = false): void {
    if (this.sync(sessionId)?.migration_frozen || this.isSyncClosed(sessionId)) return;
    const s = this.db.prepare('SELECT * FROM cowork_sessions WHERE id=?').get(sessionId) as any;
    if (!s) {
      if (!this.get<string>(`deletedAt:${sessionId}`)) this.requireSnapshot(sessionId);
      const deletedAt = this.get<string>(`deletedAt:${sessionId}`) || iso(Date.now());
      this.put(`deletedAt:${sessionId}`, deletedAt);
      this.db.prepare("DELETE FROM remote_projection WHERE session_id=? AND object_key<>'deleted'").run(sessionId);
      this.record(sessionId, 'deleted', { eventType: 'session.deleted', payload: { deletedAt } });
      return;
    }
    const targetHistory = this.get<{ targetId?: string; runIds: string[] }>(`syncTargetHistory:${sessionId}`);
    const foreignRuns = new Set(targetHistory?.runIds || []);
    const storedRun = this.run(sessionId);
    const run = storedRun && !foreignRuns.has(storedRun.runId) && this.get<boolean>(`runPublished:${storedRun.runId}`) !== false ? storedRun : null;
    const previous = summaryOnly ? this.db.prepare("SELECT record_json FROM remote_projection WHERE session_id=? AND object_key='session'").get(sessionId) as { record_json: string } | undefined : undefined;
    summaryOnly = summaryOnly && Boolean(previous);
    const messages = summaryOnly ? [] : this.db.prepare('SELECT * FROM cowork_messages WHERE session_id=? ORDER BY sequence,created_at,id').all(sessionId) as any[];
    const visible = messages.filter(row => this.replyProjectionSupported ? isPublicReplyMessage(row) : publicMessage(row));
    const latest = visible.filter(m => ['user', 'assistant'].includes(m.type) && publicMessage(m)).at(-1);
    let latestText = latest?.content || '';
    if (latest?.type === 'user') {
      try {
        const metadata = JSON.parse(latest.metadata || '{}');
        const prepared = this.get<{ input: { text: string } }>(`inputRun:${metadata.remoteRunId}`);
        if (prepared) latestText = prepared.input.text;
        const desktopInput = this.get<DesktopInputRun>(`desktopInputRun:${metadata.remoteRunId}`);
        if (desktopInput && sameOwner(desktopInput.owner, this.owner(sessionId))) latestText = desktopInput.text;
      } catch { /* Legacy malformed metadata has no trusted prepared input. */ }
    }
    const approvals = this.entries<any>(`approval:${sessionId}:`).map(row => row.value).filter(approval => !foreignRuns.has(approval.runId));
    const questions = this.questionProjectionSupported ? this.questionStates(sessionId).filter(question => !foreignRuns.has(question.runId)) : [];
    const questionKeys = new Set(questions.filter(question => this.get<boolean>(`runPublished:${question.runId}`) !== false).map(question => `question:${question.questionId}`));
    for (const row of this.db.prepare("SELECT object_key FROM remote_projection WHERE session_id=? AND object_key LIKE 'question:%'").all(sessionId) as Array<{ object_key: string }>) {
      if (questionKeys.has(row.object_key)) continue;
      this.db.prepare('DELETE FROM remote_projection WHERE session_id=? AND object_key=?').run(sessionId, row.object_key);
      this.requireSnapshot(sessionId, 'question_projection_changed');
    }
    const publishedRunIds = new Set((this.db.prepare("SELECT object_key FROM remote_projection WHERE session_id=? AND object_key LIKE 'run:%'").all(sessionId) as Array<{ object_key: string }>).map(row => row.object_key.slice(4)));
    // A run terminal event may be the last event in an HTTP batch. Publish the executor's
    // exact approval closure first, so the server does not invent a competing cancellation.
    // Initial projections still begin with session.upsert and introduce the run normally.
    for (const approval of approvals) if (approval.status !== 'pending' && publishedRunIds.has(approval.runId)) this.projectApproval(sessionId, approval);
    for (const question of questions) if (question.status !== 'pending' && publishedRunIds.has(question.runId)) this.projectQuestion(sessionId, question);
    const deferTerminal = this.replyProjectionSupported && !summaryOnly && run && terminal.has(run.status) && publishedRunIds.has(run.runId);
    const deferred: Array<{ key: string; record: ProjectionRecord }> = [];
    const recordState = (key: string, record: ProjectionRecord): void => { if (deferTerminal) deferred.push({ key, record }); else this.record(sessionId, key, record); };
    recordState('session', { eventType: 'session.upsert', payload: { session: {
      sessionId: this.sync(sessionId)?.session_id, title: shortName(publicText(s.title)), origin: this.get(`origin:${sessionId}`) || 'desktop',
      workspaceId: this.get(`workspace:${sessionId}`), preview: summaryOnly ? JSON.parse(previous!.record_json).payload.session.preview : preview(publicText(latestText)), createdAt: iso(s.created_at), updatedAt: iso(s.updated_at),
      ...(this.deletionProjectionSupported ? { deletionGuard: this.deletionGuard(sessionId) } : {}),
      localStatus: s.status, controlVersion: this.controlVersion(sessionId), run,
      ...(this.inputProjectionSupported ? { inputVersion: this.inputVersion(sessionId), inputModel: this.get(`inputModel:${sessionId}`) } : {}),
      ...(this.agentSummary && this.owner(sessionId) ? { agent: this.agentSummary(sessionId, this.owner(sessionId)!) } : {}),
    } } });
    for (const { value: historicalRun } of this.entries<RemoteRun>(`runHistory:${sessionId}:`)) {
      if (foreignRuns.has(historicalRun.runId)) continue;
      const projectedRun = historicalRun.runId === run?.runId ? run : historicalRun;
      if (this.get<boolean>(`runPublished:${historicalRun.runId}`) !== false) recordState(`run:${historicalRun.runId}`, { eventType: 'run.updated', payload: { run: projectedRun, controlVersion: this.controlVersion(sessionId) } });
    }
    for (const approval of approvals) this.projectApproval(sessionId, approval);
    for (const question of questions) if (this.get<boolean>(`runPublished:${question.runId}`) !== false) this.projectQuestion(sessionId, question);
    // Agent metadata changes reuse the committed preview and never scan/re-upload conversation messages.
    if (summaryOnly) return;
    const liveKeys = new Set<string>();
    const tools = new Map<string, ProjectionRecord>();
    // Read catalog metadata only; never enumerate files or select file_path/path_key.
    const artifacts = this.artifactTracking ? this.db.prepare(`SELECT a.id,a.file_name,a.extension,a.size_bytes,a.availability,r.last_message_id
      FROM library_local_artifacts a JOIN library_artifact_sessions r ON r.artifact_id=a.id
      WHERE r.session_id=? AND r.last_message_id IS NOT NULL ORDER BY a.id`).all(sessionId) as any[] : [];
    for (const [displayIndex, m] of visible.entries()) {
      let metadata: any = {};
      try { metadata = JSON.parse(m.metadata || '{}'); } catch { /* Legacy malformed metadata is not transmitted. */ }
      const command = targetHistory?.targetId && metadata.remoteCommandId && !metadata.remoteRunId
        ? this.get<{ targetId?: string }>(`inbox:${targetHistory.targetId}:${metadata.remoteCommandId}`) || this.get<{ targetId?: string }>(`inbox:${metadata.remoteCommandId}`) : null;
      const foreignHistory = foreignRuns.has(metadata.remoteRunId)
        || !!(targetHistory?.targetId && metadata.remoteCommandId && !metadata.remoteRunId && command?.targetId !== targetHistory.targetId);
      if (!foreignHistory && metadata.remoteRunId && this.get<boolean>(`runPublished:${metadata.remoteRunId}`) === false) continue;
      const isTool = m.type.startsWith('tool_');
      const toolId = String(metadata.toolUseId || metadata.toolCallId || m.id);
      const inputRun = this.get<{ input: { text: string; attachments: Array<{ assetId: string; version: string; fileName: string; mimeType: string; sizeBytes: string; intent: string }> }; inputModel: unknown }>(`inputRun:${metadata.remoteRunId}`);
      const desktopInput = this.get<DesktopInputRun & { inputModel?: unknown }>(`desktopInputRun:${metadata.remoteRunId}`);
      const ownDesktopInput = desktopInput && sameOwner(desktopInput.owner, this.owner(sessionId))
        && (foreignHistory || !desktopInput.attachments.some(source => source.preparedSource)) ? desktopInput : null;
      const rawContent = m.type === 'user' ? inputRun?.input.text ?? ownDesktopInput?.text ?? m.content : m.content;
      const content = this.replyProjectionSupported ? redactReplyText(rawContent || '') : publicText(rawContent);
      const previousTool = tools.get(toolId)?.payload.tool;
      const storedTool = this.db.prepare('SELECT record_json FROM remote_projection WHERE session_id=? AND object_key=?').get(sessionId, `tool:${toolId}`) as { record_json: string } | undefined;
      const knownTool = previousTool || (storedTool ? JSON.parse(storedTool.record_json).payload.tool : null);
      const toolName = shortName(metadata.toolName || knownTool?.name || 'tool');
      const blocks: any[] = this.replyProjectionSupported ? replyBlocks({ ...m, content }, metadata, isTool ? toolName : undefined)
        : isTool ? [{ type: 'tool', toolCallId: toolId }] : [{ type: m.type === 'user' ? 'text' : 'markdown', text: content }];
      if (m.type === 'user' && inputRun) {
        for (const [index, asset] of inputRun.input.attachments.entries()) {
          if (foreignHistory && ownDesktopInput?.attachments.some(source => source.preparedSource?.attachmentIndex === index)) continue;
          blocks.push(this.inputProjectionSupported && !foreignHistory
            ? { type: 'attachment', assetId: asset.assetId, version: asset.version, name: asset.fileName, mimeType: asset.mimeType,
              sizeBytes: asset.sizeBytes, availability: 'ready', intent: asset.intent }
            : { type: 'text', text: `[Attachment: ${shortName(asset.fileName)}]` });
        }
      }
      if (m.type === 'user' && ownDesktopInput) {
        for (const [index, source] of ownDesktopInput.attachments.entries()) {
          const key = `desktopAsset:${m.id}:${index}`;
          let job = this.get<any>(key);
          if (!job) {
            job = { ...source, owner: ownDesktopInput.owner, localSessionId: sessionId, sessionId: this.sync(sessionId)?.session_id,
              messageId: m.id, uploadRequestId: randomUUID(), availability: 'desktop_only' };
            this.put(key, job);
          }
          blocks.push(this.inputProjectionSupported && job.availability === 'ready' && job.uploadedAsset
            && (!this.fileEnvironment || job.environment === this.fileEnvironment)
            ? { type: 'attachment', assetId: job.uploadedAsset.assetId, version: job.uploadedAsset.version, name: job.uploadedAsset.fileName,
              mimeType: job.uploadedAsset.mimeType, sizeBytes: job.uploadedAsset.sizeBytes, availability: 'ready', intent: job.uploadedAsset.intent }
            : { type: 'artifact', artifactId: job.uploadRequestId, name: source.fileName, mimeType: source.mimeType,
              sizeBytes: source.sizeBytes, availability: 'desktop_only',
              ...(this.fileProjectionSupported ? { reason: desktopInputReason(job, source.captureReason) } : {}) });
        }
      }
      const remoteArtifacts = this.fileProjectionSupported ? this.artifactProjection?.(sessionId, m.id) || [] : [];
      for (const artifact of artifacts.filter(a => a.last_message_id === m.id && !remoteArtifacts.some(value => value.localArtifactId === a.id))) blocks.push({ type: 'artifact', artifactId: artifact.id,
        name: String(artifact.file_name).split(/[\\/]/).pop()!.slice(0, 128),
        mimeType: ({ pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', csv: 'text/csv', html: 'text/html' } as Record<string, string>)[String(artifact.extension).replace(/^\./, '').toLowerCase()] || 'application/octet-stream',
        sizeBytes: Number.isSafeInteger(artifact.size_bytes) && artifact.size_bytes >= 0 ? String(artifact.size_bytes) : null,
        availability: artifact.availability === 'missing' ? 'missing' : 'desktop_only',
      });
      blocks.push(...remoteArtifacts.map(value => value.block));
      if (this.replyProjectionSupported) for (const [index, block] of blocks.entries()) if (typeof block.text === 'string' && !block.blockId) block.blockId = replyBlockId(m.id, `text:${index}`);
      const message: any = { messageId: m.id, ordinal: String(Math.max(1, m.sequence || 1)), revision: '0',
        runId: foreignHistory ? null : metadata.remoteRunId || null, commandId: foreignHistory ? null : metadata.remoteCommandId || null,
        role: isTool ? 'tool' : this.replyProjectionSupported && m.type === 'system' ? 'notice' : m.type, status: metadata.isStreaming ? 'streaming' : 'complete', createdAt: iso(m.created_at),
        ...(this.replyProjectionSupported ? { projectionVersion: RemoteReply.ProjectionVersion, displayOrdinal: String(displayIndex + 1) } : {}),
        contentState: 'complete', preview: isTool ? '' : preview(content), originalContentBytes: String(Buffer.byteLength(stableJson(blocks))), blocks,
        ...(this.inputProjectionSupported && !foreignHistory && (inputRun || ownDesktopInput?.inputModel) ? { inputModel: inputRun?.inputModel ?? ownDesktopInput?.inputModel ?? null } : {}) };
      if (this.replyProjectionSupported) {
        for (const block of blocks) if (typeof block.text === 'string' && Buffer.byteLength(block.text) > RemoteReply.InlineBytes) {
          if (Buffer.byteLength(block.text) > RemoteReply.MaximumContentBytes) {
            // Keep the full source locally. The App receives an explicit overflow notice, never a silent truncation.
            message.contentState = 'desktop_only';
            message.contentUnavailableReason = 'CONTENT_LIMIT_EXCEEDED';
            // originalContentBytes and reason identify the omitted body; do not replace it with a summary.
          } else {
            block.contentRef = this.replyContent(sessionId, m.id, block.blockId, block.type === RemoteReplyBlockType.ToolInput ? 'json' : block.type === RemoteReplyBlockType.Markdown ? 'markdown' : 'text', block.text);
            delete block.text;
          }
        }
      }
      if (this.replyProjectionSupported) {
        if (message.contentState === 'desktop_only') message.blocks = [];
        else message.originalContentBytes = String(Buffer.byteLength(stableJson(blocks)));
      }
      if (Buffer.byteLength(stableJson(message)) > REMOTE_MESSAGE_BYTES - 128) { message.blocks = []; message.contentState = 'desktop_only'; if (this.replyProjectionSupported) message.contentUnavailableReason = 'CONTENT_LIMIT_EXCEEDED'; }
      this.record(sessionId, `message:${m.id}`, { eventType: 'message.upsert', payload: { message } });
      liveKeys.add(`message:${m.id}`);
      let toolStatus = this.replyProjectionSupported ? replyToolState(m.type, metadata) : m.type === 'tool_result' ? (metadata.isError ? 'failed' : 'succeeded') : 'running';
      if (this.replyProjectionSupported && knownTool && terminal.has(knownTool.status) && !terminal.has(toolStatus)) toolStatus = knownTool.status;
      if (isTool) tools.set(toolId, { eventType: 'tool.upsert', payload: { tool: {
        toolCallId: toolId, runId: foreignHistory ? null : metadata.remoteRunId || run?.runId || null, revision: '0', name: this.replyProjectionSupported ? toolName : shortName(metadata.toolName || 'tool'),
        status: toolStatus,
        summary: '', startedAt: knownTool?.startedAt || iso(m.created_at), finishedAt: ['succeeded', 'failed', 'cancelled'].includes(toolStatus) ? iso(m.created_at) : null, error: null,
      } } });
    }
    for (const [toolId, record] of tools) this.record(sessionId, `tool:${toolId}`, record);
    const existing = this.db.prepare("SELECT object_key,revision,record_json FROM remote_projection WHERE session_id=? AND object_key LIKE 'message:%'").all(sessionId) as any[];
    for (const p of existing) if (!liveKeys.has(p.object_key) && JSON.parse(p.record_json).eventType !== 'message.deleted') {
      const deleted = { eventType: 'message.deleted', payload: { messageId: p.object_key.slice(8), revision: String(p.revision + 1) } };
      this.enqueue(sessionId, deleted);
      this.db.prepare('UPDATE remote_projection SET hash=?,revision=?,record_json=? WHERE session_id=? AND object_key=?')
        .run(payloadHash(deleted), p.revision + 1, stableJson(deleted), sessionId, p.object_key);
    }
    for (const { key, record } of deferred) this.record(sessionId, key, record);
    if (this.replyProjectionSupported) {
      const cached = this.db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM remote_reply_chunks WHERE session_id=?').get(sessionId) as { bytes: number };
      const queued = this.db.prepare('SELECT COUNT(*) AS n FROM remote_outbox WHERE session_id=?').get(sessionId) as { n: number };
      if (cached.bytes > 64 * 1024 * 1024 && queued.n > 100) {
        this.requireSnapshot(sessionId, 'reply_cache_limit');
        this.db.prepare('DELETE FROM remote_outbox WHERE session_id=?').run(sessionId);
        this.pruneReplyContents(sessionId);
      }
    }
  }
  snapshot(sessionId: string): { baseSourceSeq: string; snapshotEpoch: number; records: ProjectionRecord[] } {
    return this.transaction(() => {
      if (this.projectionPublishing(sessionId)) throw new Error('REMOTE_PROJECTION_PUBLISHING');
      if (!this.options.deferredProjection) this.project(sessionId);
      let records = (this.db.prepare('SELECT record_json FROM remote_projection WHERE session_id=? ORDER BY object_key').all(sessionId) as any[]).map(row => JSON.parse(row.record_json));
      const deletion = records.find(record => record.eventType === 'session.deleted');
      if (deletion) records = [deletion];
      return { baseSourceSeq: String(this.sync(sessionId)!.source_seq), snapshotEpoch: this.get<number>(`snapshotEpoch:${sessionId}`) || 0, records };
    });
  }
  pending(sessionId: string): RemoteEvent[] {
    if (this.projectionPublishing(sessionId)) return [];
    const rows = this.db.prepare('SELECT event_json FROM remote_outbox WHERE session_id=? ORDER BY source_seq LIMIT 100').all(sessionId) as any[];
    const result: RemoteEvent[] = [];
    let bytes = 0;
    for (const row of rows) {
      const length = Buffer.byteLength(row.event_json);
      if (result.length && bytes + length > 240 * 1024) break;
      try { result.push(JSON.parse(row.event_json)); }
      catch { throw new RemoteTaskDataError('REMOTE_OUTBOX_JSON_INVALID'); }
      bytes += length;
    }
    return result;
  }
  freezeMigration(sessionId: string): void {
    this.db.prepare('UPDATE remote_sync SET migration_frozen=1 WHERE local_id=?').run(sessionId);
  }
  unfreezeMigration(sessionId: string): void {
    this.db.prepare('UPDATE remote_sync SET migration_frozen=0 WHERE local_id=?').run(sessionId);
  }
  applyRetentionAck(sessionId: string, result: { syncProtocolVersion: number; streamEpoch: string; sourcePurgeSeq: string; eventPurgeSeq: string }, activating = false): void {
    const row = this.sync(sessionId);
    if (!row || result.syncProtocolVersion !== RemoteRetention.Version || !result.streamEpoch
      || (!activating && (row.sync_protocol_version !== RemoteRetention.Version || row.stream_epoch !== result.streamEpoch))
      || (row.stream_epoch && row.stream_epoch !== result.streamEpoch)) throw new RemoteSyncStateError('Remote stream ACK identity mismatch');
    const sourceFloor = retentionSequence(result.sourcePurgeSeq);
    const eventFloor = retentionSequence(result.eventPurgeSeq);
    if (sourceFloor > BigInt(row.source_seq)) throw new RemoteSyncStateError('Remote retention ACK outside durable bounds');
    this.db.prepare(`UPDATE remote_sync SET sync_protocol_version=?,stream_epoch=?,source_purge_seq=?,event_purge_seq=? WHERE local_id=?`)
      .run(RemoteRetention.Version, result.streamEpoch, String(sourceFloor > retentionSequence(row.source_purge_seq) ? sourceFloor : retentionSequence(row.source_purge_seq)),
        String(eventFloor > retentionSequence(row.event_purge_seq) ? eventFloor : retentionSequence(row.event_purge_seq)), sessionId);
  }
  acknowledge(sessionId: string, deviceId: string, remoteId: string, committedSourceSeq: string, committedSeq: string, snapshot = false, snapshotEpoch?: number): void {
    this.transaction(() => {
      const row = this.sync(sessionId);
      const ack = BigInt(safeSourceSequence(committedSourceSeq));
      const server = retentionSequence(committedSeq);
      if (row && server < retentionSequence(row.server_seq)) throw new Error('Remote server ACK regressed');
      if (!row || row.session_id !== remoteId || row.device_id !== deviceId || ack < BigInt(row.ack_seq) || ack > BigInt(row.source_seq)) throw new Error('Remote ACK outside durable local bounds');
      this.db.prepare('UPDATE remote_sync SET ack_seq=?,server_seq=?,needs_snapshot=? WHERE local_id=?')
        .run(Number(ack), committedSeq, snapshot && (snapshotEpoch === undefined || snapshotEpoch === (this.get<number>(`snapshotEpoch:${sessionId}`) || 0)) ? 0 : row.needs_snapshot, sessionId);
      this.db.prepare('DELETE FROM remote_outbox WHERE session_id=? AND source_seq<=?').run(sessionId, Number(ack));
      this.pruneReplyContents(sessionId);
      if (Number(ack) === row.source_seq && !this.db.prepare('SELECT 1 FROM remote_dirty WHERE session_id=?').get(sessionId)) this.db.prepare('UPDATE remote_session_revisions SET clean_revision=revision WHERE session_id=?').run(sessionId);
      try { acknowledgeRemoteSessionDeletion(this, sessionId); }
      catch (error) { console.warn('[RemoteSync] Local deletion cleanup receipt deferred', error); }
    });
  }
}
