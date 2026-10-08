import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';

import { payloadHash, stableJson } from './canonical';
import { advanceAvailabilityMigration, AvailabilityMigration } from './remoteAvailabilityMigration';
import { assertRemoteSidecarHeadroom } from './remoteSidecarHeadroom';
import { emitCommittedTelemetry, observeSyncCommit, SyncTelemetry } from './remoteSyncTelemetry';
import { captureRemoteTelemetry, remoteTelemetryEvent } from './remoteTelemetry';

export interface AvailabilitySession {
  scope: string; localId: string; sessionId: string; writerGeneration: string; controlEpoch: string;
  phase: 'activating' | 'bootstrap' | 'active'; operationId: string; pendingCommandIds: string[]; pendingRunIds: string[];
  pendingApprovalIds?: string[]; pendingQuestionIds?: string[]; streamEpoch?: string; historyGeneration?: string; historyResolvedSourceSeq?: string;
  requiredRunIds?: string[];
  controlRevision: string; factSeq: string; records: Record<string, string>;
}
export interface AvailabilityRequest {
  key: string; lane: 'control' | 'live'; scope: string; localId: string; method: string; pathname: string; version: number;
  body: Record<string, any>; lookup: string | null; lookupVersion: number; createdAt: number; attempted: boolean;
}
export const AvailabilityReadState = { Valid: 'valid', Corrupt: 'corrupt' } as const;
export type AvailabilityRequestRow = { key: string; localId: string; objectId: string | null; objectKind: string | null }
  & ({ state: typeof AvailabilityReadState.Valid; value: AvailabilityRequest } | { state: typeof AvailabilityReadState.Corrupt; reason: string });
class AvailabilityRecordError extends Error {
  constructor() { super('REMOTE_AVAILABILITY_RECORD_INVALID'); }
}
// Archived evidence has its own bounded allowance; every admitted request reserves a terminal receipt.
const RECEIPT_RESERVE_BYTES = 64 * 1024;
const LEDGER_REQUEST_BYTES = 256 * 1024 * 1024;
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
function decode(body: string): Record<string, any> {
  if (Buffer.byteLength(body) > 1024 * 1024) throw new AvailabilityRecordError();
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new AvailabilityRecordError(); }
  if (!record(value)) throw new AvailabilityRecordError();
  return value;
}
/** Immutable business requests survive a lost response. This WAL is independent of the history/outbox WAL. */
export class RemoteAvailabilityStore {
  private database: Database.Database | null = null;
  private telemetryStorageBlocked = false;
  constructor(private readonly coreDatabase: string | Database.Database) {}
  private migrationReady = false;
  private migrationResume: ReturnType<typeof setImmediate> | null = null;
  private ready(database: Database.Database): Database.Database {
    if (this.migrationResume) throw new Error(AvailabilityMigration.Pending);
    if (!this.migrationReady) this.migrationReady = advanceAvailabilityMigration(database);
    if (!this.migrationReady) {
      this.migrationResume = setImmediate(() => { this.migrationResume = null; }); this.migrationResume.unref?.();
      throw new Error(AvailabilityMigration.Pending);
    }
    if (this.telemetryStorageBlocked) remoteTelemetryEvent(SyncTelemetry.Event.Admission,
      { domain: 'control', fromState: 'blocked', toState: 'ready', reason: SyncTelemetry.Reason.None });
    this.telemetryStorageBlocked = false;
    return database;
  }
  get db(): Database.Database {
    if (this.database?.open) return this.ready(this.database);
    let core: Database.Database | null = null, database: Database.Database | null = null;
    try {
      let locator: { ledger_id: string; phase: string } | undefined;
      const coreFilename = typeof this.coreDatabase === 'string' ? this.coreDatabase : this.coreDatabase.name;
      if (coreFilename !== ':memory:') {
        if (typeof this.coreDatabase !== 'string' && this.coreDatabase.inTransaction) throw new Error('REMOTE_CONTROL_LEDGER_CORE_TRANSACTION');
        core = typeof this.coreDatabase === 'string' ? new Database(coreFilename, { fileMustExist: true, timeout: 100 }) : this.coreDatabase;
        core.pragma('synchronous = FULL');
        core.exec(`CREATE TABLE IF NOT EXISTS remote_control_ledger_locator(id INTEGER PRIMARY KEY CHECK(id=1),ledger_id TEXT NOT NULL,phase TEXT NOT NULL)`);
        core.prepare("INSERT OR IGNORE INTO remote_control_ledger_locator VALUES(1,?,'prepared')").run(randomUUID());
        locator = core.prepare('SELECT ledger_id,phase FROM remote_control_ledger_locator WHERE id=1').get() as { ledger_id: string; phase: string };
      }
      const filename = coreFilename === ':memory:' ? ':memory:' : path.join(path.dirname(coreFilename), 'remote-control.sqlite');
      database = new Database(filename, { fileMustExist: locator?.phase === 'ready', timeout: 100 });
      database.pragma('journal_mode = WAL'); database.pragma('synchronous = FULL'); database.pragma('busy_timeout = 100');
      const identityTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='availability_identity'").get();
      if (locator?.phase === 'ready' && !identityTable) throw new Error('REMOTE_CONTROL_LEDGER_MISSING');
      if (locator?.phase === 'ready' && (database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('availability_identity','availability_sessions','availability_requests','availability_objects','availability_receipts','availability_faults')").get() as { count: number }).count !== 6) throw new Error('REMOTE_CONTROL_LEDGER_SCHEMA_MISSING');
      database.exec('CREATE TABLE IF NOT EXISTS availability_identity(id INTEGER PRIMARY KEY CHECK(id=1),ledger_id TEXT NOT NULL)');
      const identity = database.prepare('SELECT ledger_id FROM availability_identity WHERE id=1').get() as { ledger_id: string } | undefined;
      if (locator && identity && identity.ledger_id !== locator.ledger_id) throw new Error('REMOTE_CONTROL_LEDGER_IDENTITY_MISMATCH');
      if (locator?.phase === 'ready' && !identity) throw new Error('REMOTE_CONTROL_LEDGER_IDENTITY_MISSING');
      database.prepare('INSERT OR IGNORE INTO availability_identity VALUES(1,?)').run(locator?.ledger_id || randomUUID());
      database.exec(`CREATE TABLE IF NOT EXISTS availability_sessions(scope TEXT NOT NULL,local_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,local_id));
        CREATE TABLE IF NOT EXISTS availability_requests(key TEXT PRIMARY KEY,lane TEXT NOT NULL,scope TEXT NOT NULL,local_id TEXT NOT NULL,body TEXT NOT NULL,bytes INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_availability_requests_lane ON availability_requests(scope,lane,local_id);
        CREATE TABLE IF NOT EXISTS availability_objects(scope TEXT NOT NULL,local_id TEXT NOT NULL,object_id TEXT NOT NULL,
          source_revision TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,local_id,object_id));
        CREATE TABLE IF NOT EXISTS availability_receipts(operation_id TEXT PRIMARY KEY,result TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS availability_checkpoint_uploaded(operation_id TEXT NOT NULL,part_no INTEGER NOT NULL,payload_hash TEXT NOT NULL,
          PRIMARY KEY(operation_id,part_no));
        CREATE TABLE IF NOT EXISTS availability_faults(scope TEXT NOT NULL,local_id TEXT NOT NULL,object_key TEXT NOT NULL,
          fingerprint TEXT NOT NULL,attempts INTEGER NOT NULL,window_start INTEGER NOT NULL,next_retry INTEGER NOT NULL,
          PRIMARY KEY(scope,local_id,object_key));`);
      // Independent identity columns survive a damaged request body. Unknown legacy identity stays unknown.
      const columns = new Set((database.prepare('PRAGMA table_info(availability_requests)').all() as Array<{ name: string }>).map(row => row.name));
      for (const column of ['object_id', 'object_kind', 'request_hash', 'resolution_body', 'resolution_receipt']) {
        if (!columns.has(column)) database.exec(`ALTER TABLE availability_requests ADD COLUMN ${column} TEXT`);
      }
      database.exec('CREATE INDEX IF NOT EXISTS idx_availability_request_object ON availability_requests(scope,lane,local_id,object_kind,object_id)');
      // The locator commits before any caller can send a request sealed in this ledger.
      core?.prepare("UPDATE remote_control_ledger_locator SET phase='ready' WHERE id=1 AND phase='prepared'").run();
      this.database = database;
      return this.ready(database);
    } catch (error) {
      if (!this.telemetryStorageBlocked) remoteTelemetryEvent(SyncTelemetry.Event.Admission,
        { domain: 'control', fromState: 'unknown', toState: 'blocked', reason: SyncTelemetry.Reason.StorageUnavailable });
      this.telemetryStorageBlocked = true;
      if (!(error instanceof Error && error.message === AvailabilityMigration.Pending)) { database?.close(); this.database = null; }
      throw error;
    }
    finally { if (typeof this.coreDatabase === 'string') core?.close(); }
  }
  health(scope: string): { sessions: number; pendingSessions: number; degraded: boolean } {
    const sessions = this.db.prepare('SELECT COUNT(*) AS count FROM availability_sessions WHERE scope=?').get(scope) as { count: number };
    const pending = this.db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT local_id FROM availability_sessions WHERE scope=? AND
        CASE WHEN json_valid(body) THEN CASE WHEN json_extract(body,'$.phase')='active' THEN 0 ELSE 1 END ELSE 1 END
      UNION SELECT local_id FROM availability_requests WHERE scope=? AND resolution_receipt IS NULL)`).get(scope, scope) as { count: number };
    const faults = this.db.prepare('SELECT 1 FROM availability_faults WHERE scope=? LIMIT 1').get(scope);
    const corrupt = this.db.prepare('SELECT 1 FROM availability_sessions WHERE scope=? AND NOT json_valid(body) LIMIT 1').get(scope);
    return { sessions: sessions.count, pendingSessions: pending.count, degraded: !!faults || !!corrupt };
  }
  close(): void {
    if (this.migrationResume) clearImmediate(this.migrationResume); this.migrationResume = null;
    this.database?.close(); this.database = null; this.migrationReady = false;
  }
  session(scope: string, localId: string): AvailabilitySession | null {
    const row = this.db.prepare('SELECT body FROM availability_sessions WHERE scope=? AND local_id=?').get(scope, localId) as { body: string } | undefined;
    if (!row) return null;
    const value = decode(row.body);
    if (value.scope !== scope || value.localId !== localId || !identifier(value.sessionId) || !identifier(value.writerGeneration)
      || !identifier(value.operationId) || !identifier(value.controlEpoch) || !['activating','bootstrap','active'].includes(value.phase)
      || !/^\d{1,19}$/u.test(value.controlRevision) || !/^\d{1,19}$/u.test(value.factSeq) || !record(value.records)
      || !Array.isArray(value.pendingCommandIds) || !Array.isArray(value.pendingRunIds)
      || !value.pendingCommandIds.every(identifier) || !value.pendingRunIds.every(identifier)) throw new AvailabilityRecordError();
    return value as AvailabilitySession;
  }
  hasSession(scope: string, localId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM availability_sessions WHERE scope=? AND local_id=?').get(scope, localId);
  }
  saveSession(value: AvailabilitySession): void {
    if (!this.hasSession(value.scope, value.localId)) assertRemoteSidecarHeadroom(this.db.name, Buffer.byteLength(stableJson(value)), RECEIPT_RESERVE_BYTES);
    this.db.prepare('INSERT INTO availability_sessions VALUES(?,?,?) ON CONFLICT(scope,local_id) DO UPDATE SET body=excluded.body').run(value.scope, value.localId, stableJson(value));
  }
  private decodeRequest(row: { key: string; lane: string; scope: string; local_id: string; body: string; request_hash: string | null }): AvailabilityRequest {
    if (typeof row.body !== 'string') throw new AvailabilityRecordError();
    const value = decode(row.body);
    if (value.key !== row.key || value.lane !== row.lane || value.scope !== row.scope || value.localId !== row.local_id
      || !record(value.body) || typeof value.pathname !== 'string' || !['GET','POST','PUT'].includes(value.method)
      || !Number.isSafeInteger(value.version) || !Number.isSafeInteger(value.lookupVersion)
      || !(value.lookup === null || typeof value.lookup === 'string') || typeof value.attempted !== 'boolean'
      || !Number.isFinite(value.createdAt) || row.request_hash && payloadHash(value) !== row.request_hash) throw new AvailabilityRecordError();
    return value as AvailabilityRequest;
  }
  request(key: string): AvailabilityRequest | null {
    const row = this.db.prepare('SELECT * FROM availability_requests WHERE key=?').get(key) as any;
    return row ? this.decodeRequest(row) : null;
  }
  scanPending(scope: string, lane: 'control' | 'live', localId: string, after = '', limit = 32): { rows: AvailabilityRequestRow[]; nextCursor: string | null } {
    const size = Math.max(1, Math.min(100, limit));
    const raw = this.db.prepare('SELECT key,lane,scope,local_id,object_id,object_kind,request_hash,CASE WHEN octet_length(body)<=1048576 THEN body ELSE NULL END AS body FROM availability_requests WHERE scope=? AND lane=? AND local_id=? AND resolution_receipt IS NULL AND key>? ORDER BY key LIMIT ?')
      .all(scope, lane, localId, after, size) as any[];
    const rows: AvailabilityRequestRow[] = raw.map(row => {
      const identity = { key: row.key, localId: row.local_id, objectId: row.object_id, objectKind: row.object_kind };
      try { return { ...identity, state: AvailabilityReadState.Valid, value: this.decodeRequest(row) }; }
      catch (error) {
        if (!(error instanceof AvailabilityRecordError)) throw error;
        return { ...identity, state: AvailabilityReadState.Corrupt, reason: 'REMOTE_AVAILABILITY_RECORD_INVALID' };
      }
    });
    return { rows, nextCursor: raw.length === size ? raw.at(-1)!.key : null };
  }
  hasPendingObject(scope: string, localId: string, objectKind: string, objectId: string): boolean {
    // Unknown identity protects this task, never every task or a falsely inferred single object.
    return !!this.db.prepare(`SELECT 1 FROM availability_requests WHERE scope=? AND lane='live' AND local_id=?
      AND resolution_receipt IS NULL AND (object_id IS NULL OR object_kind IS NULL OR (object_kind=? AND object_id=?)) LIMIT 1`).get(scope, localId, objectKind, objectId);
  }
  sealResolution(scope: string, localId: string, key: string, body: Record<string, unknown>): Record<string, any> {
    if (!identifier(key)) throw new AvailabilityRecordError();
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT resolution_body FROM availability_requests WHERE key=? AND scope=? AND local_id=? AND lane='live' AND resolution_receipt IS NULL")
        .get(key, scope, localId) as { resolution_body: string | null } | undefined;
      if (!row) throw new AvailabilityRecordError();
      if (row.resolution_body) return decode(row.resolution_body);
      const saved = { ...body, resolutionId: randomUUID(), action: 'recover_or_seal' };
      if (Buffer.byteLength(stableJson(saved)) > RECEIPT_RESERVE_BYTES / 2) throw new AvailabilityRecordError();
      this.db.prepare('UPDATE availability_requests SET resolution_body=? WHERE key=? AND resolution_body IS NULL').run(stableJson(saved), key);
      return saved;
    })();
  }
  completeResolution(scope: string, localId: string, key: string, body: Record<string, unknown>, receipt: Record<string, unknown>): void {
    // Original bytes and unknown object identity remain archived in place. Only a verified terminal proof removes the scheduling barrier.
    const encoded = stableJson(receipt);
    if (Buffer.byteLength(encoded) > RECEIPT_RESERVE_BYTES / 2 || receipt.publicationId !== key
      || receipt.sessionId !== body.sessionId || receipt.writerGeneration !== body.writerGeneration
      || !['sealed_unpublished', 'original_terminal'].includes(String(receipt.state))) throw new AvailabilityRecordError();
    this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE availability_requests SET resolution_receipt=?
        WHERE key=? AND scope=? AND local_id=? AND lane='live' AND resolution_body=? AND resolution_receipt IS NULL`)
        .run(encoded, key, scope, localId, stableJson(body)).changes;
      if (!changed) throw new AvailabilityRecordError();
    })();
  }

  pending(scope: string, lane: 'control' | 'live', localId?: string): AvailabilityRequest[] {
    return (this.db.prepare(`SELECT * FROM availability_requests WHERE scope=? AND lane=? AND resolution_receipt IS NULL ${localId ? 'AND local_id=?' : ''} ORDER BY key LIMIT 32`)
      .all(scope, lane, ...(localId ? [localId] : [])) as any[]).map(row => this.decodeRequest(row));
  }
  saveRequest(value: AvailabilityRequest): AvailabilityRequest {
    const previous = this.request(value.key);
    if (previous) return previous;
    const body = stableJson(value), bytes = Buffer.byteLength(body);
    this.db.transaction(() => {
      const laneLimit = (value.lane === 'live' ? 32 : 16) * 1024 * 1024;
      const used = this.db.prepare(`SELECT COALESCE(SUM(active_bytes),0) AS active,
        COALESCE(SUM(CASE WHEN scope=? AND local_id=? THEN active_bytes ELSE 0 END),0) AS task
        FROM availability_usage WHERE lane=?`).get(value.scope, value.localId, value.lane) as { active: number; task: number };
      const total = this.db.prepare('SELECT COALESCE(SUM(active_bytes+archive_bytes+reserved_bytes),0) AS bytes FROM availability_usage').get() as { bytes: number };
      // Keep one maximum legal request available to another task, without increasing either lane limit.
      if (bytes > (value.pathname ? 256 : 1024) * 1024 || used.active + bytes > laneLimit
        || used.task + bytes > laneLimit - 1024 * 1024 || total.bytes + bytes + RECEIPT_RESERVE_BYTES > LEDGER_REQUEST_BYTES)
        throw new Error('REMOTE_AVAILABILITY_QUEUE_BUDGET');
      assertRemoteSidecarHeadroom(this.db.name, bytes, RECEIPT_RESERVE_BYTES);
      this.db.prepare('INSERT INTO availability_requests(key,lane,scope,local_id,body,bytes,object_id,object_kind,request_hash) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(value.key, value.lane, value.scope, value.localId, body, bytes, identifier(value.body.objectId) ? value.body.objectId : null,
          ['message','tool'].includes(value.body.objectKind) ? value.body.objectKind : null, payloadHash(value));
    })();
    const kind = value.lane === 'live' ? SyncTelemetry.Kind.Live
      : value.pathname === '/sync/mode-activations' ? SyncTelemetry.Kind.Activation
        : value.pathname === '/control/facts/batches' ? SyncTelemetry.Kind.Facts : SyncTelemetry.Kind.Bootstrap;
    const captured = captureRemoteTelemetry({ deviceId: value.body.deviceId, remoteOwnerId: value.body.owner?.userId,
      ownerScopeId: value.body.owner?.scopeKey, localSessionId: value.localId, sessionId: value.body.sessionId,
      operationId: value.body.publicationId || value.body.batchId || value.body.operationId || value.key.split(':')[0],
      operationKind: kind, publicationKind: kind, lane: value.lane, apiVersion: value.version });
    emitCommittedTelemetry(this.db, captured, value.pathname ? SyncTelemetry.Event.Sealed : SyncTelemetry.Event.Stage,
      { stage: SyncTelemetry.Stage.Sealed, outcome: SyncTelemetry.Outcome.Completed, phase: SyncTelemetry.Stage.Sealed, businessStatus: 'pending',
        objectId: value.body.objectId, objectRevision: value.body.sourceObjectRevision, writerGeneration: value.body.writerGeneration,
        controlEpoch: value.body.controlEpoch, representation: value.body.representation, requestBytes: bytes },
      () => true);
    return value;
  }
  attempted(value: AvailabilityRequest): void {
    value.attempted = true;
    this.updateRequest(value);
  }
  updateRequest(value: AvailabilityRequest): void {
    const body = stableJson(value), bytes = Buffer.byteLength(body);
    this.db.transaction(() => {
      const previous = this.request(value.key);
      if (!previous || previous.scope !== value.scope || previous.localId !== value.localId || previous.lane !== value.lane
        || previous.attempted && stableJson({ ...previous, attempted: value.attempted }) !== body) throw new AvailabilityRecordError();
      const delta = bytes - Buffer.byteLength(stableJson(previous));
      const laneLimit = (value.lane === 'live' ? 32 : 16) * 1024 * 1024;
      const usage = this.db.prepare(`SELECT COALESCE(SUM(active_bytes+archive_bytes+reserved_bytes),0) AS total,
        COALESCE(SUM(CASE WHEN lane=? THEN active_bytes ELSE 0 END),0) AS lane,
        COALESCE(SUM(CASE WHEN lane=? AND scope=? AND local_id=? THEN active_bytes ELSE 0 END),0) AS task FROM availability_usage`)
        .get(value.lane, value.lane, value.scope, value.localId) as { total: number; lane: number; task: number };
      if (bytes > (value.pathname ? 256 : 1024) * 1024 || delta > 0 && (usage.total + delta > LEDGER_REQUEST_BYTES
        || usage.lane + delta > laneLimit || usage.task + delta > laneLimit - 1024 * 1024)) throw new Error('REMOTE_AVAILABILITY_QUEUE_BUDGET');
      this.db.prepare('UPDATE availability_requests SET body=?,bytes=?,request_hash=? WHERE key=?').run(body, bytes, payloadHash(value), value.key);
    })();
  }
  archiveBootstrap(scope: string, localId: string, operationId: string, result: unknown): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO availability_receipts VALUES(?,?)').run(operationId, stableJson(result));
      this.db.prepare('DELETE FROM availability_requests WHERE scope=? AND local_id=? AND key LIKE ?').run(scope, localId, `${operationId}:%`);
    })();
  }
  objectRetryAllowed(scope: string, localId: string, objectKey: string, now = Date.now(), fingerprint?: string): boolean {
    const row = this.db.prepare('SELECT next_retry,fingerprint FROM availability_faults WHERE scope=? AND local_id=? AND object_key=?').get(scope, localId, objectKey) as { next_retry: number; fingerprint: string } | undefined;
    return !row || row.next_retry <= now || fingerprint !== undefined && row.fingerprint !== fingerprint;
  }
  objectFault(scope: string, localId: string, objectKey: string, fingerprint: string, now = Date.now()): void {
    const previous = this.db.prepare('SELECT * FROM availability_faults WHERE scope=? AND local_id=? AND object_key=?').get(scope, localId, objectKey) as any;
    if (!previous) assertRemoteSidecarHeadroom(this.db.name, Buffer.byteLength(objectKey) + 256, 0);
    const sameWindow = previous && previous.fingerprint === fingerprint && now - previous.window_start < 86400000;
    const attempts = sameWindow ? previous.attempts + 1 : 1, start = sameWindow ? previous.window_start : now;
    const next = attempts >= 2 ? start + 86400000 : now + 300000;
    this.db.prepare(`INSERT INTO availability_faults VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope,local_id,object_key)
      DO UPDATE SET fingerprint=excluded.fingerprint,attempts=excluded.attempts,window_start=excluded.window_start,next_retry=excluded.next_retry`)
      .run(scope, localId, objectKey, fingerprint, attempts, start, next);
  }
  complete(key: string): void { this.db.prepare('DELETE FROM availability_requests WHERE key=?').run(key); }
  object(scope: string, localId: string, objectId: string): { sourceRevision: string; result: Record<string, any> } | null {
    const row = this.db.prepare('SELECT source_revision,result FROM availability_objects WHERE scope=? AND local_id=? AND object_id=?').get(scope, localId, objectId) as { source_revision: string; result: string } | undefined;
    return row ? { sourceRevision: row.source_revision, result: JSON.parse(row.result) } : null;
  }
  skipObject(scope: string, localId: string, objectKey: string, sourceRevision: string): void {
    assertRemoteSidecarHeadroom(this.db.name, Buffer.byteLength(objectKey) + 256, RECEIPT_RESERVE_BYTES);
    this.db.prepare(`INSERT INTO availability_objects VALUES(?,?,?,?,?) ON CONFLICT(scope,local_id,object_id)
      DO UPDATE SET source_revision=excluded.source_revision,result=excluded.result`).run(scope, localId, objectKey, sourceRevision, stableJson({ state: 'local_only' }));
  }
  completeObject(request: AvailabilityRequest, result: Record<string, any>): void {
    const telemetry = captureRemoteTelemetry({ localSessionId: request.localId, sessionId: request.body.sessionId,
      deviceId: request.body.deviceId, remoteOwnerId: request.body.owner?.userId, ownerScopeId: request.body.owner?.scopeKey,
      operationId: request.body.publicationId, operationKind: SyncTelemetry.Kind.Live, publicationKind: SyncTelemetry.Kind.Live,
      objectId: request.body.objectId, objectRevision: request.body.sourceObjectRevision, lane: request.lane });
    observeSyncCommit(telemetry, () => this.db.transaction(() => {
      this.db.prepare(`INSERT INTO availability_objects VALUES(?,?,?,?,?) ON CONFLICT(scope,local_id,object_id)
        DO UPDATE SET source_revision=excluded.source_revision,result=excluded.result`).run(request.scope, request.localId,
          `${request.body.objectKind}:${request.body.objectId}`, request.body.sourceObjectRevision, stableJson(result));
      if (result.state === 'accepted' || result.state === 'superseded') this.db.prepare('DELETE FROM availability_faults WHERE scope=? AND local_id=? AND object_key=?')
        .run(request.scope, request.localId, `${request.body.objectKind}:${request.body.objectId}`);
      this.complete(request.key);
    })());
    emitCommittedTelemetry(this.db, telemetry, SyncTelemetry.Event.Acknowledged,
      { stage: SyncTelemetry.Stage.LocalAck, phase: SyncTelemetry.Stage.LocalAck, outcome: SyncTelemetry.Outcome.Completed,
        businessStatus: result.state, representation: request.body.representation, writerGeneration: request.body.writerGeneration },
      () => true);
  }
}
