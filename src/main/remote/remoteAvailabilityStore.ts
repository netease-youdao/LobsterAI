import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';

import { stableJson } from './canonical';

export interface AvailabilitySession {
  scope: string; localId: string; sessionId: string; writerGeneration: string; controlEpoch: string;
  phase: 'activating' | 'bootstrap' | 'active'; operationId: string; pendingCommandIds: string[]; pendingRunIds: string[];
  pendingApprovalIds?: string[]; pendingQuestionIds?: string[]; streamEpoch?: string; historyGeneration?: string; historyResolvedSourceSeq?: string;
  controlRevision: string; factSeq: string; records: Record<string, string>;
}
export interface AvailabilityRequest {
  key: string; lane: 'control' | 'live'; scope: string; localId: string; method: string; pathname: string; version: number;
  body: Record<string, any>; lookup: string | null; lookupVersion: number; createdAt: number; attempted: boolean;
}
/** Immutable business requests survive a lost response. This WAL is independent of the history/outbox WAL. */
export class RemoteAvailabilityStore {
  private database: Database.Database | null = null;
  constructor(private readonly coreDatabase: string) {}
  get db(): Database.Database {
    if (this.database?.open) return this.database;
    let core: Database.Database | null = null, database: Database.Database | null = null;
    try {
      let locator: { ledger_id: string; phase: string } | undefined;
      if (this.coreDatabase !== ':memory:') {
        core = new Database(this.coreDatabase, { fileMustExist: true, timeout: 100 });
        core.pragma('synchronous = FULL');
        core.exec(`CREATE TABLE IF NOT EXISTS remote_control_ledger_locator(id INTEGER PRIMARY KEY CHECK(id=1),ledger_id TEXT NOT NULL,phase TEXT NOT NULL)`);
        core.prepare("INSERT OR IGNORE INTO remote_control_ledger_locator VALUES(1,?,'prepared')").run(randomUUID());
        locator = core.prepare('SELECT ledger_id,phase FROM remote_control_ledger_locator WHERE id=1').get() as { ledger_id: string; phase: string };
      }
      const filename = this.coreDatabase === ':memory:' ? ':memory:' : path.join(path.dirname(this.coreDatabase), 'remote-control.sqlite');
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
        CREATE TABLE IF NOT EXISTS availability_faults(scope TEXT NOT NULL,local_id TEXT NOT NULL,object_key TEXT NOT NULL,
          fingerprint TEXT NOT NULL,attempts INTEGER NOT NULL,window_start INTEGER NOT NULL,next_retry INTEGER NOT NULL,
          PRIMARY KEY(scope,local_id,object_key));`);
      // The locator commits before any caller can send a request sealed in this ledger.
      core?.prepare("UPDATE remote_control_ledger_locator SET phase='ready' WHERE id=1 AND phase='prepared'").run();
      this.database = database; return database;
    } catch (error) { database?.close(); throw error; }
    finally { core?.close(); }
  }
  close(): void { this.database?.close(); this.database = null; }
  session(scope: string, localId: string): AvailabilitySession | null {
    const row = this.db.prepare('SELECT body FROM availability_sessions WHERE scope=? AND local_id=?').get(scope, localId) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }
  saveSession(value: AvailabilitySession): void {
    this.db.prepare('INSERT INTO availability_sessions VALUES(?,?,?) ON CONFLICT(scope,local_id) DO UPDATE SET body=excluded.body').run(value.scope, value.localId, stableJson(value));
  }
  request(key: string): AvailabilityRequest | null {
    const row = this.db.prepare('SELECT body FROM availability_requests WHERE key=?').get(key) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }
  pending(scope: string, lane: 'control' | 'live', localId?: string): AvailabilityRequest[] {
    return (this.db.prepare(`SELECT body FROM availability_requests WHERE scope=? AND lane=? ${localId ? 'AND local_id=?' : ''} ORDER BY key LIMIT 32`)
      .all(scope, lane, ...(localId ? [localId] : [])) as Array<{ body: string }>).map(row => JSON.parse(row.body));
  }
  saveRequest(value: AvailabilityRequest): AvailabilityRequest {
    const previous = this.request(value.key);
    if (previous) return previous;
    const body = stableJson(value), bytes = Buffer.byteLength(body);
    const used = this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM availability_requests WHERE lane=?').get(value.lane) as { bytes: number };
    if (bytes > 256 * 1024 || used.bytes + bytes > (value.lane === 'live' ? 32 : 16) * 1024 * 1024) throw new Error('REMOTE_AVAILABILITY_QUEUE_BUDGET');
    this.db.prepare('INSERT INTO availability_requests VALUES(?,?,?,?,?,?)').run(value.key, value.lane, value.scope, value.localId, body, bytes);
    return value;
  }
  attempted(value: AvailabilityRequest): void {
    value.attempted = true;
    this.db.prepare('UPDATE availability_requests SET body=? WHERE key=?').run(stableJson(value), value.key);
  }
  archiveBootstrap(scope: string, localId: string, operationId: string, result: unknown): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO availability_receipts VALUES(?,?)').run(operationId, stableJson(result));
      this.db.prepare('DELETE FROM availability_requests WHERE scope=? AND local_id=? AND key LIKE ?').run(scope, localId, `${operationId}:%`);
    })();
  }
  objectRetryAllowed(scope: string, localId: string, objectKey: string, now = Date.now()): boolean {
    const row = this.db.prepare('SELECT next_retry FROM availability_faults WHERE scope=? AND local_id=? AND object_key=?').get(scope, localId, objectKey) as { next_retry: number } | undefined;
    return !row || row.next_retry <= now;
  }
  objectFault(scope: string, localId: string, objectKey: string, fingerprint: string, now = Date.now()): void {
    const previous = this.db.prepare('SELECT * FROM availability_faults WHERE scope=? AND local_id=? AND object_key=?').get(scope, localId, objectKey) as any;
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
    this.db.prepare(`INSERT INTO availability_objects VALUES(?,?,?,?,?) ON CONFLICT(scope,local_id,object_id)
      DO UPDATE SET source_revision=excluded.source_revision,result=excluded.result`).run(scope, localId, objectKey, sourceRevision, stableJson({ state: 'local_only' }));
  }
  completeObject(request: AvailabilityRequest, result: Record<string, any>): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO availability_objects VALUES(?,?,?,?,?) ON CONFLICT(scope,local_id,object_id)
        DO UPDATE SET source_revision=excluded.source_revision,result=excluded.result`).run(request.scope, request.localId,
          `${request.body.objectKind}:${request.body.objectId}`, request.body.sourceObjectRevision, stableJson(result));
      this.complete(request.key);
    })();
  }
}
