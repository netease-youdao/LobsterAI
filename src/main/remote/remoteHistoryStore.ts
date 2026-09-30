import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';

import type { RemoteOwner } from '../../shared/remote/constants';
import { payloadHash, sameOwner, stableJson } from './canonical';
import type { RemoteStore } from './remoteStore';
import { SyncTelemetry } from './remoteSyncTelemetry';
import { captureRemoteTelemetry, remoteTelemetryEvent } from './remoteTelemetry';

export interface HistoryContext {
  scope: string; localId: string; sessionId: string; writerGeneration: string; owner: RemoteOwner; deviceId: string;
}
export interface HistorySession extends HistoryContext {
  migrationId: string; legacyMetadataHash: string; historyGeneration: string; resolvedSourceSeq: string;
}
export interface HistoryOperation {
  id: string; context: HistoryContext; kind: 'batch' | 'recovery'; request: Record<string, unknown>; requestHash: string;
  state: 'pending' | 'complete'; receipt: Record<string, unknown> | null;
}
interface Migration { migration_id: string; manifest_json: string; manifest_hash: string; phase: 'prepared' | 'copied' | 'ready' }
export class RemoteHistoryUnavailable extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'RemoteHistoryUnavailable'; }
}
const contextKey = (context: HistoryContext): unknown[] => [context.scope, context.localId, context.writerGeneration];
const sequence = (value: string): boolean => /^(?:0|[1-9][0-9]*)$/u.test(value);

/** Only v3 history lives here. Core identity, execution facts and original v1/v2 evidence never move. */
export class RemoteHistoryStore {
  private database: Database.Database | null = null;
  private unavailableUntil = 0;
  private lastFailure: string | null = null;
  readonly filename: string;
  constructor(private readonly store: RemoteStore) {
    this.filename = store.db.name === ':memory:' ? ':memory:' : path.join(path.dirname(store.db.name), 'remote-sync.sqlite');
  }
  static initializeCore(db: Database.Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS remote_history_profile(id INTEGER PRIMARY KEY CHECK(id=1),sidecar_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_history_migrations(scope TEXT NOT NULL,local_id TEXT NOT NULL,writer_generation TEXT NOT NULL,
        migration_id TEXT NOT NULL UNIQUE,manifest_json TEXT NOT NULL,manifest_hash TEXT NOT NULL,phase TEXT NOT NULL,
        PRIMARY KEY(scope,local_id,writer_generation));`);
  }
  status(): { available: boolean; reason: string | null } { return { available: !!this.database?.open && !this.lastFailure, reason: this.lastFailure }; }
  close(): void { this.database?.close(); this.database = null; }
  private fail(error: unknown): RemoteHistoryUnavailable {
    if (!this.lastFailure) remoteTelemetryEvent(SyncTelemetry.Event.Admission, { domain: 'history_storage', fromState: 'unknown',
      toState: 'blocked', reason: SyncTelemetry.Reason.StorageUnavailable });
    this.close(); this.unavailableUntil = Date.now() + 30_000;
    this.lastFailure = error instanceof RemoteHistoryUnavailable ? error.reason : 'REMOTE_HISTORY_STORAGE_UNAVAILABLE';
    return new RemoteHistoryUnavailable(this.lastFailure);
  }
  private databaseForHistory(): Database.Database {
    if (this.database?.open) return this.database;
    if (Date.now() < this.unavailableUntil) throw new RemoteHistoryUnavailable(this.lastFailure || 'REMOTE_HISTORY_STORAGE_UNAVAILABLE');
    const core = this.store.db;
    let profile = core.prepare('SELECT sidecar_id FROM remote_history_profile WHERE id=1').get() as { sidecar_id: string } | undefined;
    if (!profile) {
      core.prepare('INSERT OR IGNORE INTO remote_history_profile VALUES(1,?)').run(randomUUID());
      profile = core.prepare('SELECT sidecar_id FROM remote_history_profile WHERE id=1').get() as { sidecar_id: string };
    }
    // Losing an already adopted sidecar could lose unknown remote operations. Never recreate it as an empty cache.
    const adopted = !!core.prepare("SELECT 1 FROM remote_history_migrations WHERE phase IN ('copied','ready') LIMIT 1").get();
    let db: Database.Database | null = null;
    try {
      db = new Database(this.filename, { fileMustExist: adopted && this.filename !== ':memory:', timeout: 100 });
      db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL'); db.pragma('busy_timeout = 100');
      const pageSize = Number(db.pragma('page_size', { simple: true }));
      db.pragma(`max_page_count = ${Math.floor(128 * 1024 * 1024 / pageSize)}`);
      const identityTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_identity'").get();
      if (adopted && !identityTable) throw new RemoteHistoryUnavailable('REMOTE_HISTORY_LEDGER_MISSING');
      if (adopted && (db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('history_identity','history_migration_copies','history_sessions','history_operations')").get() as { count: number }).count !== 4) throw new RemoteHistoryUnavailable('REMOTE_HISTORY_LEDGER_SCHEMA_MISSING');
      db.exec(`CREATE TABLE IF NOT EXISTS history_identity(id INTEGER PRIMARY KEY CHECK(id=1),sidecar_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS history_migration_copies(migration_id TEXT PRIMARY KEY,manifest_json TEXT NOT NULL,manifest_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS history_sessions(scope TEXT NOT NULL,local_id TEXT NOT NULL,writer_generation TEXT NOT NULL,body TEXT NOT NULL,
          PRIMARY KEY(scope,local_id,writer_generation));
        CREATE TABLE IF NOT EXISTS history_operations(id TEXT PRIMARY KEY,scope TEXT NOT NULL,local_id TEXT NOT NULL,writer_generation TEXT NOT NULL,
          body TEXT NOT NULL,bytes INTEGER NOT NULL,state TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_history_operations_pending ON history_operations(scope,local_id,writer_generation,state);`);
      const identity = db.prepare('SELECT sidecar_id FROM history_identity WHERE id=1').get() as { sidecar_id: string } | undefined;
      if (identity && identity.sidecar_id !== profile.sidecar_id) throw new RemoteHistoryUnavailable('REMOTE_HISTORY_IDENTITY_MISMATCH');
      if (!identity && adopted) throw new RemoteHistoryUnavailable('REMOTE_HISTORY_IDENTITY_MISSING');
      db.prepare('INSERT OR IGNORE INTO history_identity VALUES(1,?)').run(profile.sidecar_id);
      this.database = db;
      if (this.lastFailure) remoteTelemetryEvent(SyncTelemetry.Event.Admission, { domain: 'history_storage', fromState: 'blocked',
        toState: 'ready', reason: SyncTelemetry.Reason.None });
      this.lastFailure = null; return db;
    } catch (error) { db?.close(); throw this.fail(error); }
  }
  private assertCurrent(context: HistoryContext): void {
    const binding = this.store.controlBinding(context.localId);
    if (!context.scope || !context.writerGeneration || !this.store.isIndependentControlReady(context.localId)
      || !binding || binding.session_id !== context.sessionId || binding.device_id !== context.deviceId || binding.migration_frozen
      || !sameOwner(this.store.owner(context.localId), context.owner) || this.store.isSyncClosed(context.localId)) {
      throw new RemoteHistoryUnavailable('REMOTE_HISTORY_CONTEXT_CHANGED');
    }
  }
  private migration(context: HistoryContext): Migration | undefined {
    return this.store.db.prepare('SELECT migration_id,manifest_json,manifest_hash,phase FROM remote_history_migrations WHERE scope=? AND local_id=? AND writer_generation=?')
      .get(...contextKey(context)) as Migration | undefined;
  }
  private withCoreBudget<T>(action: () => T): T {
    const core = this.store.db, previous = Number(core.pragma('busy_timeout', { simple: true }));
    if (previous > 100) core.pragma('busy_timeout = 100');
    try { return action(); }
    finally { if (core.open && previous > 100) core.pragma(`busy_timeout = ${previous}`); }
  }
  /** Best effort only: construction, local commits and control readiness never await this method. */
  prepare(context: HistoryContext): HistorySession | null {
    try { return this.withCoreBudget(() => {
      if (this.store.db.inTransaction) throw new RemoteHistoryUnavailable('REMOTE_HISTORY_CROSS_DATABASE_TRANSACTION');
      this.assertCurrent(context);
      let migration = this.migration(context);
      if (!migration) {
        this.store.db.transaction(() => {
          this.assertCurrent(context);
          const sync = this.store.sync(context.localId);
          // Capture bounded metadata only. Unknown outbox/import bytes stay immutable in the original core archive.
          const manifest = stableJson({ version: 1, context, legacy: sync, archive: 'core-read-only-after-writer-fence' });
          if (Buffer.byteLength(manifest) > 16 * 1024) throw new RemoteHistoryUnavailable('REMOTE_HISTORY_METADATA_BUDGET');
          this.store.db.prepare('INSERT INTO remote_history_migrations VALUES(?,?,?,?,?,?,?)')
            .run(...contextKey(context), randomUUID(), manifest, payloadHash(JSON.parse(manifest)), 'prepared');
        })();
        migration = this.migration(context)!;
      }
      const manifest = JSON.parse(migration.manifest_json) as { context: HistoryContext };
      if (payloadHash(manifest) !== migration.manifest_hash || stableJson(manifest.context) !== stableJson(context)) {
        throw new RemoteHistoryUnavailable('REMOTE_HISTORY_MIGRATION_INVALID');
      }
      const db = this.databaseForHistory();
      const copy = (): { manifest_json: string; manifest_hash: string } | undefined => db.prepare('SELECT manifest_json,manifest_hash FROM history_migration_copies WHERE migration_id=?')
        .get(migration!.migration_id) as { manifest_json: string; manifest_hash: string } | undefined;
      if (migration.phase === 'prepared') {
        db.prepare('INSERT OR IGNORE INTO history_migration_copies VALUES(?,?,?)').run(migration.migration_id,migration.manifest_json,migration.manifest_hash);
      }
      const copied = copy();
      if (!copied || copied.manifest_json !== migration.manifest_json || copied.manifest_hash !== migration.manifest_hash
        || payloadHash(JSON.parse(copied.manifest_json)) !== copied.manifest_hash) throw new RemoteHistoryUnavailable('REMOTE_HISTORY_MIGRATION_COPY_INVALID');
      this.assertCurrent(context);
      if (migration.phase === 'prepared') this.store.db.prepare("UPDATE remote_history_migrations SET phase='copied' WHERE migration_id=? AND phase='prepared'").run(migration.migration_id);
      let session = this.readSession(db, context);
      if (!session) {
        if (migration.phase === 'ready') throw new RemoteHistoryUnavailable('REMOTE_HISTORY_SESSION_MISSING');
        session = { ...context, migrationId: migration.migration_id, legacyMetadataHash: migration.manifest_hash,
          historyGeneration: '0', resolvedSourceSeq: '0' };
        db.prepare('INSERT INTO history_sessions VALUES(?,?,?,?)').run(...contextKey(context), stableJson(session));
      }
      if (session.migrationId !== migration.migration_id || session.legacyMetadataHash !== migration.manifest_hash
        || !sequence(session.historyGeneration) || !sequence(session.resolvedSourceSeq)) throw new RemoteHistoryUnavailable('REMOTE_HISTORY_SESSION_INVALID');
      this.assertCurrent(context);
      this.store.db.prepare("UPDATE remote_history_migrations SET phase='ready' WHERE migration_id=? AND phase='copied'").run(migration.migration_id);
      if (migration.phase !== 'ready') remoteTelemetryEvent(SyncTelemetry.Event.Stage, { stage: SyncTelemetry.Stage.HistoryMigration,
        outcome: SyncTelemetry.Outcome.Completed, localSessionId: context.localId, sessionId: context.sessionId,
        deviceId: context.deviceId, remoteOwnerId: context.owner.userId, ownerScopeId: context.owner.scopeKey,
        operationKind: SyncTelemetry.Kind.History, writerGeneration: context.writerGeneration });
      return session;
    }); } catch (error) { this.fail(error); return null; }
  }
  private readSession(db: Database.Database, context: HistoryContext): HistorySession | null {
    const row = db.prepare('SELECT body FROM history_sessions WHERE scope=? AND local_id=? AND writer_generation=?').get(...contextKey(context)) as { body: string } | undefined;
    if (!row) return null;
    const session = JSON.parse(row.body) as HistorySession;
    if (session.scope !== context.scope || session.localId !== context.localId || session.sessionId !== context.sessionId
      || session.writerGeneration !== context.writerGeneration || session.deviceId !== context.deviceId || !sameOwner(session.owner,context.owner)) {
      throw new RemoteHistoryUnavailable('REMOTE_HISTORY_SESSION_IDENTITY_INVALID');
    }
    return session;
  }
  session(context: HistoryContext): HistorySession | null {
    return this.access(context, db => this.readSession(db,context));
  }
  private access<T>(context: HistoryContext, action: (db: Database.Database) => T): T {
    try { return this.withCoreBudget(() => {
      if (this.store.db.inTransaction) throw new RemoteHistoryUnavailable('REMOTE_HISTORY_CROSS_DATABASE_TRANSACTION');
      this.assertCurrent(context);
      if (this.migration(context)?.phase !== 'ready') throw new RemoteHistoryUnavailable('REMOTE_HISTORY_MIGRATION_NOT_READY');
      return action(this.databaseForHistory());
    }); } catch (error) { throw this.fail(error); }
  }
  operation(context: HistoryContext, id: string): HistoryOperation | null {
    return this.access(context, db => this.readOperation(db,context,id));
  }
  private readOperation(db: Database.Database, context: HistoryContext, id: string): HistoryOperation | null {
    const row = db.prepare('SELECT body FROM history_operations WHERE id=? AND scope=? AND local_id=? AND writer_generation=?')
      .get(id,...contextKey(context)) as { body: string } | undefined;
    if (!row) return null;
    const value = JSON.parse(row.body) as HistoryOperation;
    if (value.id !== id || stableJson(value.context) !== stableJson(context) || payloadHash(value.request) !== value.requestHash) {
      throw new RemoteHistoryUnavailable('REMOTE_HISTORY_OPERATION_INVALID');
    }
    return value;
  }
  sealOperation(value: Omit<HistoryOperation,'requestHash' | 'state' | 'receipt'>): HistoryOperation {
    const telemetry = captureRemoteTelemetry({ localSessionId: value.context.localId, sessionId: value.context.sessionId,
      deviceId: value.context.deviceId, remoteOwnerId: value.context.owner.userId, ownerScopeId: value.context.owner.scopeKey,
      writerGeneration: value.context.writerGeneration, lane: 'history', operationId: value.id,
      operationKind: value.kind === 'recovery' ? SyncTelemetry.Kind.History : SyncTelemetry.Kind.HistoryBatch,
      publicationKind: value.kind === 'recovery' ? SyncTelemetry.Kind.History : SyncTelemetry.Kind.HistoryBatch });
    let inserted = false;
    const result = this.access(value.context, db => db.transaction(() => {
      const hash = payloadHash(value.request), existing = this.readOperation(db,value.context,value.id);
      if (existing) {
        if (existing.requestHash !== hash || existing.kind !== value.kind) throw new RemoteHistoryUnavailable('REMOTE_HISTORY_OPERATION_IMMUTABLE');
        return existing;
      }
      const operation: HistoryOperation = { ...value, requestHash: hash, state: 'pending', receipt: null };
      const body = stableJson(operation), bytes = Buffer.byteLength(body);
      const used = db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM history_operations').get() as { bytes: number };
      if (bytes > 1024 * 1024 || used.bytes + bytes > 32 * 1024 * 1024) throw new RemoteHistoryUnavailable('REMOTE_HISTORY_OPERATION_BUDGET');
      db.prepare('INSERT INTO history_operations VALUES(?,?,?,?,?,?,?)').run(value.id,...contextKey(value.context),body,bytes,'pending');
      inserted = true;
      return operation;
    })());
    if (inserted) telemetry.emit(SyncTelemetry.Event.HistoryStarted, { stage: SyncTelemetry.Stage.Sealed,
      phase: SyncTelemetry.Stage.Sealed, outcome: SyncTelemetry.Outcome.Completed, businessStatus: 'pending' });
    return result;
  }
  pending(context: HistoryContext): HistoryOperation[] {
    return this.access(context, db => (db.prepare("SELECT id FROM history_operations WHERE scope=? AND local_id=? AND writer_generation=? AND state='pending' ORDER BY id LIMIT 32")
      .all(...contextKey(context)) as Array<{ id: string }>).map(row => this.readOperation(db,context,row.id)!));
  }
  legacyMetadata(context: HistoryContext): { sourceSeq: string; exactAckSeq: string } {
    return this.access(context, () => {
      const migration = this.migration(context)!;
      const manifest = JSON.parse(migration.manifest_json) as { legacy: { source_seq: number; ack_seq: number } };
      const source = manifest.legacy.source_seq, acknowledged = manifest.legacy.ack_seq;
      if (!Number.isSafeInteger(source) || !Number.isSafeInteger(acknowledged) || acknowledged < 0 || source < acknowledged) {
        throw new RemoteHistoryUnavailable('REMOTE_HISTORY_LEGACY_POSITION_INVALID');
      }
      return { sourceSeq: String(source), exactAckSeq: String(acknowledged) };
    });
  }
  /** Read immutable pre-fence bytes in small pages; never reinterpret this as an exact source ACK. */
  legacySourcePage(context: HistoryContext, afterSourceSeq: string, throughSourceSeq: string, limit = 64): Array<{ sourceSeq: string; eventJson: string }> {
    return this.access(context, () => {
      if (!sequence(afterSourceSeq) || !sequence(throughSourceSeq) || BigInt(afterSourceSeq) > BigInt(throughSourceSeq)
        || BigInt(throughSourceSeq) > BigInt(this.legacyMetadata(context).sourceSeq)) throw new RemoteHistoryUnavailable('REMOTE_HISTORY_SOURCE_RANGE_INVALID');
      const rows = this.store.db.prepare(`SELECT source_seq,length(CAST(event_json AS BLOB)) AS bytes,
        CASE WHEN length(CAST(event_json AS BLOB))<=262144 THEN event_json ELSE NULL END AS event_json FROM remote_outbox
        WHERE session_id=? AND source_seq>? AND source_seq<=? ORDER BY source_seq LIMIT ?`)
        .all(context.localId,afterSourceSeq,throughSourceSeq,Math.min(64,Math.max(1,limit))) as Array<{ source_seq: number; bytes: number; event_json: string | null }>;
      let bytes = 0;
      const result: Array<{ sourceSeq: string; eventJson: string }> = [];
      for (const row of rows) {
        if (!Number.isSafeInteger(row.source_seq) || row.source_seq < 1 || row.event_json === null) throw new RemoteHistoryUnavailable('REMOTE_HISTORY_SOURCE_ROW_UNREADABLE');
        if (bytes + row.bytes > 512 * 1024) break;
        bytes += row.bytes; result.push({ sourceSeq: String(row.source_seq), eventJson: row.event_json });
      }
      return result;
    });
  }
  completeOperation(context: HistoryContext, id: string, receipt: Record<string, unknown>, position: { historyGeneration: string; resolvedSourceSeq: string }): void {
    const telemetry = captureRemoteTelemetry({ localSessionId: context.localId, sessionId: context.sessionId,
      deviceId: context.deviceId, remoteOwnerId: context.owner.userId, ownerScopeId: context.owner.scopeKey,
      writerGeneration: context.writerGeneration, lane: 'history', operationId: id });
    let completed = false;
    let kind: HistoryOperation['kind'] | undefined;
    this.access(context, db => db.transaction(() => {
      const operation = this.readOperation(db,context,id), session = this.readSession(db,context);
      if (!operation || !session || !sequence(position.historyGeneration) || !sequence(position.resolvedSourceSeq)) throw new RemoteHistoryUnavailable('REMOTE_HISTORY_RECEIPT_INVALID');
      if (operation.state === 'complete') {
        if (stableJson(operation.receipt) !== stableJson(receipt)) throw new RemoteHistoryUnavailable('REMOTE_HISTORY_RECEIPT_IMMUTABLE');
        return;
      }
      if (BigInt(position.historyGeneration) < BigInt(session.historyGeneration) || BigInt(position.resolvedSourceSeq) < BigInt(session.resolvedSourceSeq)) {
        throw new RemoteHistoryUnavailable('REMOTE_HISTORY_RECEIPT_REGRESSION');
      }
      operation.state = 'complete'; operation.receipt = receipt; kind = operation.kind;
      const body = stableJson(operation);
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new RemoteHistoryUnavailable('REMOTE_HISTORY_RECEIPT_BUDGET');
      Object.assign(session, position);
      db.prepare('UPDATE history_operations SET body=?,bytes=?,state=? WHERE id=?').run(body,Buffer.byteLength(body),'complete',id);
      db.prepare('UPDATE history_sessions SET body=? WHERE scope=? AND local_id=? AND writer_generation=?').run(stableJson(session),...contextKey(context));
      completed = true;
    })());
    if (completed) telemetry.emit(receipt.state === 'committed' ? SyncTelemetry.Event.HistoryCommitted : SyncTelemetry.Event.Reconciled,
      { stage: SyncTelemetry.Stage.LocalAck, phase: SyncTelemetry.Stage.LocalAck, outcome: SyncTelemetry.Outcome.Confirmed,
        operationKind: kind === 'recovery' ? SyncTelemetry.Kind.History : SyncTelemetry.Kind.HistoryBatch,
        publicationKind: kind === 'recovery' ? SyncTelemetry.Kind.History : SyncTelemetry.Kind.HistoryBatch,
        businessStatus: receipt.state, receiptState: receipt.state, persistOutcome: 'success',
        historyGeneration: position.historyGeneration, resolvedSourceSeq: position.resolvedSourceSeq,
        exactSourcePrefix: receipt.exactSourcePrefix, gapCount: Array.isArray(receipt.gaps) ? receipt.gaps.length : undefined });
  }
}
