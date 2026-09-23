import type { RemoteOwner } from '../../shared/remote/constants';
import { sameOwner, stableJson } from './canonical';
import { RemoteSyncStateError } from './remoteRetention';
import type { RemoteStore, SyncRow } from './remoteStore';

export class RemoteSyncAdmissionBudgetError extends RemoteSyncStateError {
  readonly reason = 'REMOTE_SYNC_ADMISSION_BUDGET';
  constructor(readonly targetId: string) { super('Legacy synchronization admission exceeds its local work budget'); }
}
const admissionBudget = { rows: 2000, bytes: 8 * 1024 * 1024, recordBytes: 1024 * 1024, durationMs: 100 } as const;
type Store = Pick<RemoteStore, 'db'>;
interface StateRow { key: string; value: string }
export const RemoteSessionAdmission = { Unverified: 'unverified', Verified: 'verified', Quarantined: 'quarantined' } as const;
export type RemoteSessionAdmission = typeof RemoteSessionAdmission[keyof typeof RemoteSessionAdmission];
const owned = "SELECT session_id FROM cowork_session_ownership WHERE owner_user_id=? AND owner_scope_key=? AND ownership_status='confirmed'";
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const parse = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return undefined; } };
const taskPrefixes = ['import', 'run', 'runHistory', 'inputFence', 'question', 'questionDecision', 'approval', 'deletionGuard', 'localGcDeleted', 'deletionClosed'];
const controlPrefixes = ['inbox:', 'syncRunTarget:', 'inputOperation:', 'sessionDeletion:', 'inputPreparation:', 'questionDecision:'];
const sharedPrefixes = [...controlPrefixes, 'desktopAsset:', 'fileOutput:'];
const matchesSession = (key: string, id: string): boolean => taskPrefixes.some(prefix => key === `${prefix}:${id}` || key.startsWith(`${prefix}:${id}:`));

/** Durable admission is separate from delivery ACKs and retry state. Original evidence is never overwritten. */
export class RemoteSyncAdmissionStore {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS remote_sync_session_admissions(
      target_id TEXT NOT NULL,owner_user_id TEXT NOT NULL,owner_scope_key TEXT NOT NULL,device_id TEXT NOT NULL,
      local_session_id TEXT NOT NULL,remote_session_id TEXT NOT NULL,admission TEXT NOT NULL,
      origin_environment TEXT,archive_id TEXT NOT NULL,PRIMARY KEY(target_id,local_session_id));
      CREATE INDEX IF NOT EXISTS idx_remote_sync_admission_pending ON remote_sync_session_admissions(target_id,admission,local_session_id);
      CREATE TABLE IF NOT EXISTS remote_sync_admission_evidence(
      archive_id TEXT NOT NULL,table_name TEXT NOT NULL,row_key TEXT NOT NULL,row_json TEXT NOT NULL,
      PRIMARY KEY(archive_id,table_name,row_key));
      CREATE TABLE IF NOT EXISTS remote_sync_admission_control_barriers(
      target_id TEXT NOT NULL,state_key TEXT NOT NULL,PRIMARY KEY(target_id,state_key));`);
  }
  /** Check lengths in SQLite before transferring archived payloads into the main process. */
  budget(owner: RemoteOwner, targetId: string, tables: Readonly<Record<string, string>>): () => void {
    const started = performance.now();
    const check = (): void => { if (performance.now() - started > admissionBudget.durationMs) throw new RemoteSyncAdmissionBudgetError(targetId); };
    let rows = 0, bytes = 0;
    for (const [table, column] of [...Object.entries(tables), ['remote_state', ''], ['cowork_messages', 'session_id']]) {
      check();
      const fields = (this.store.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>)
        .filter(field => /TEXT|BLOB/iu.test(field.type) && (table !== 'cowork_messages' || field.name === 'metadata'));
      const size = fields.map(field => `COALESCE(octet_length(${field.name}),0)`).join('+') || '0';
      const page = this.store.db.prepare(`SELECT ${size} AS bytes FROM ${table}${column ? ` WHERE ${column} IN (${owned})` : ''} LIMIT ?`)
        .all(...(column ? [owner.userId, owner.scopeKey] : []), admissionBudget.rows - rows + 1) as Array<{ bytes: number }>;
      for (const row of page) {
        rows++; bytes += row.bytes;
        if (rows > admissionBudget.rows || row.bytes > admissionBudget.recordBytes || bytes > admissionBudget.bytes) throw new RemoteSyncAdmissionBudgetError(targetId);
      }
      check();
    }
    return check;
  }
  private *states(): Iterable<StateRow> {
    let cursor = '';
    while (true) {
      const page = this.store.db.prepare('SELECT key,value FROM remote_state WHERE key>? ORDER BY key LIMIT 64').all(cursor) as StateRow[];
      if (!page.length) return;
      yield* page;
      cursor = page[page.length - 1].key;
    }
  }
  private ownsTarget(owner: RemoteOwner, targetId: string): boolean {
    return !!this.store.db.prepare('SELECT 1 FROM remote_sync_targets WHERE target_id=? AND owner_user_id=? AND owner_scope_key=?')
      .get(targetId, owner.userId, owner.scopeKey);
  }
  pending(owner: RemoteOwner, targetId: string): boolean {
    if (!this.ownsTarget(owner, targetId)) return false;
    return !!this.store.db.prepare(`SELECT 1 FROM remote_sync_session_admissions WHERE target_id=? AND owner_user_id=?
      AND owner_scope_key=? AND admission<>? LIMIT 1`).get(targetId, owner.userId, owner.scopeKey, RemoteSessionAdmission.Verified)
      || !!this.store.db.prepare(`SELECT 1 FROM remote_sync_admission_evidence e WHERE archive_id=? AND table_name='remote_sync'
        AND NOT EXISTS(SELECT 1 FROM remote_sync_session_admissions a WHERE a.target_id=? AND a.local_session_id=e.row_key
          AND a.owner_user_id=? AND a.owner_scope_key=? AND a.admission=?) LIMIT 1`)
        .get(`admission:${targetId}`, targetId, owner.userId, owner.scopeKey, RemoteSessionAdmission.Verified);
  }
  pendingIds(owner: RemoteOwner, targetId: string, after = '', limit = 50): string[] {
    if (!this.ownsTarget(owner, targetId)) return [];
    const size = Number.isFinite(limit) ? Math.min(50, Math.max(1, Math.floor(limit))) : 50;
    return (this.store.db.prepare(`SELECT local_session_id FROM remote_sync_session_admissions
      WHERE target_id=? AND owner_user_id=? AND owner_scope_key=? AND admission<>? AND local_session_id>?
      UNION SELECT e.row_key AS local_session_id FROM remote_sync_admission_evidence e
      WHERE archive_id=? AND table_name='remote_sync' AND row_key>?
        AND NOT EXISTS(SELECT 1 FROM remote_sync_session_admissions a WHERE a.target_id=? AND a.local_session_id=e.row_key
          AND a.owner_user_id=? AND a.owner_scope_key=? AND a.admission=?)
      ORDER BY local_session_id LIMIT ?`).all(targetId, owner.userId, owner.scopeKey, RemoteSessionAdmission.Verified, after,
      `admission:${targetId}`, after, targetId, owner.userId, owner.scopeKey, RemoteSessionAdmission.Verified, size) as Array<{ local_session_id: string }>)
      .map(row => row.local_session_id);
  }
  admitted(owner: RemoteOwner, deviceId: string, targetId: string, localSessionId: string): boolean {
    const saved = this.store.db.prepare('SELECT * FROM remote_sync_session_admissions WHERE target_id=? AND local_session_id=?')
      .get(targetId, localSessionId) as { owner_user_id: string; owner_scope_key: string; device_id: string; remote_session_id: string; admission: string } | undefined;
    const row = this.store.db.prepare(`SELECT * FROM remote_sync WHERE local_id=? AND local_id IN (${owned})`)
      .get(localSessionId, owner.userId, owner.scopeKey) as SyncRow | undefined;
    if (!row) return false;
    if (saved) return saved.owner_user_id === owner.userId && saved.owner_scope_key === owner.scopeKey
      && saved.device_id === deviceId && saved.remote_session_id === row.session_id && saved.admission === RemoteSessionAdmission.Verified
      && row.sync_environment === targetId && (!row.device_id || row.device_id === deviceId);
    if (this.store.db.prepare("SELECT 1 FROM remote_sync_admission_evidence WHERE archive_id=? AND table_name='remote_sync' AND row_key=?")
      .get(`admission:${targetId}`, localSessionId)) return false;
    // Existing identified working sets retain their persisted identity; genuinely new local rows have no remote authority to transfer.
    return row.sync_environment === targetId && row.device_id === deviceId || this.isPristine(row, targetId);
  }
  isPristine(row: SyncRow, targetId?: string): boolean {
    if (row.device_id || row.ack_seq || row.server_seq !== '0' || row.sync_protocol_version !== 1 || row.stream_epoch || row.sync_environment && row.sync_environment !== targetId) return false;
    for (const item of this.states()) {
      if (item.key === `import:${row.local_id}` || item.key === `localGcDeleted:${row.local_id}` || item.key === `deletionClosed:${row.local_id}`) return false;
      if (item.key === `runCommand:${row.local_id}` && parse(item.value) !== null) return false;
      if (item.key === `run:${row.local_id}` || item.key.startsWith(`runHistory:${row.local_id}:`)) {
        const run = parse(item.value);
        if (!record(run) || typeof run.runId !== 'string') return false;
        const saved = this.store.db.prepare('SELECT value FROM remote_state WHERE key=?').get(`syncRunTarget:${run.runId}`) as { value: string } | undefined;
        if (saved && parse(saved.value) !== targetId) return false;
      }
      if (!sharedPrefixes.some(prefix => item.key.startsWith(prefix))) continue;
      const value = parse(item.value);
      // Unattributable execution evidence cannot establish that a local row was never remotely controlled.
      if (!record(value)) { if (item.key.startsWith('inbox:')) return false; continue; }
      if (value.localSessionId === row.local_id || value.remoteSessionId === row.session_id || value.sessionId === row.session_id) return false;
    }
    return true;
  }
  controlBlocked(targetId: string): boolean {
    return !!this.store.db.prepare('SELECT 1 FROM remote_sync_admission_control_barriers WHERE target_id=? LIMIT 1').get(targetId);
  }
  archive(owner: RemoteOwner, targetId: string, deviceId: string, rows: SyncRow[], tables: Readonly<Record<string, string>>): void {
    const archiveId = `admission:${targetId}`;
    const insert = this.store.db.prepare('INSERT OR IGNORE INTO remote_sync_admission_evidence VALUES (?,?,?,?)');
    for (const [table, column] of Object.entries(tables)) {
      let cursor = 0;
      while (true) {
        const page = this.store.db.prepare(`SELECT rowid AS evidence_rowid,* FROM ${table} WHERE ${column} IN (${owned}) AND rowid>? ORDER BY rowid LIMIT 64`)
          .all(owner.userId, owner.scopeKey, cursor) as Array<Record<string, unknown> & { evidence_rowid: number }>;
        if (!page.length) break;
        for (const { evidence_rowid, ...original } of page) {
          insert.run(archiveId, table, table === 'remote_sync' ? String(original.local_id) : String(evidence_rowid), stableJson(original)); cursor = evidence_rowid;
        }
      }
    }
    const ids = new Set(rows.flatMap(row => [row.local_id, row.session_id]));
    const ownRuns = new Set<string>();
    for (const row of this.states()) {
      if (!rows.some(session => row.key === `run:${session.local_id}` || row.key.startsWith(`runHistory:${session.local_id}:`))) continue;
      const value = parse(row.value); if (record(value) && typeof value.runId === 'string') ownRuns.add(value.runId);
    }
    const allIds = [...ids, ...ownRuns];
    const knownTargets = this.store.db.prepare('SELECT target_id,owner_user_id,owner_scope_key FROM remote_sync_targets').all() as Array<{ target_id: string; owner_user_id: string; owner_scope_key: string }>;
    const keyHas = (key: string, id: string): boolean => key.endsWith(`:${id}`) || key.includes(`:${id}:`);
    // Preserve the owner's opaque safety records verbatim. Unattributable security facts remain guarded, never reassigned.
    for (const row of this.states()) {
      const value = parse(row.value);
      const assetMessage = row.key.startsWith('desktopAsset:') ? row.key.slice('desktopAsset:'.length).split(':')[0] : null;
      const direct = allIds.some(id => keyHas(row.key, id)) || !!assetMessage && !!this.store.db.prepare(`SELECT 1 FROM cowork_messages
        WHERE id=? AND session_id IN (${owned})`).get(assetMessage, owner.userId, owner.scopeKey);
      const scopedTarget = knownTargets.find(target => keyHas(row.key, target.target_id));
      if (!direct && (record(value) && record(value.owner) && !sameOwner(value.owner as unknown as RemoteOwner, owner)
        || scopedTarget && (scopedTarget.owner_user_id !== owner.userId || scopedTarget.owner_scope_key !== owner.scopeKey))) continue;
      const associated = record(value) && (record(value.owner) && sameOwner(value.owner as unknown as RemoteOwner, owner)
        || typeof value.localSessionId === 'string' && ids.has(value.localSessionId)
        || typeof value.remoteSessionId === 'string' && ids.has(value.remoteSessionId));
      const accountKey = row.key.includes(`${owner.userId}:${owner.scopeKey}`)
        || row.key.includes(`${JSON.stringify(owner.userId)},${JSON.stringify(owner.scopeKey)}`);
      if (!direct && !associated && !accountKey && !controlPrefixes.some(prefix => row.key.startsWith(prefix))) continue;
      insert.run(archiveId, 'remote_state', row.key, stableJson(row));
      if (!controlPrefixes.some(prefix => row.key.startsWith(prefix))) continue;
      if (value === undefined || row.key.startsWith('inbox:') && (!record(value) || !record(value.owner)) || row.key.startsWith('inbox:') && record(value) && record(value.owner) && sameOwner(value.owner as unknown as RemoteOwner, owner)
        && (!rows.some(session => session.local_id === value.localSessionId && session.session_id === (value.remoteSessionId || (record(value.command) && value.command.sessionId))))) {
        this.store.db.prepare('INSERT OR IGNORE INTO remote_sync_admission_control_barriers VALUES (?,?)').run(targetId, row.key);
      }
    }
    for (const row of rows) this.store.db.prepare('INSERT OR IGNORE INTO remote_sync_session_admissions VALUES (?,?,?,?,?,?,?,?,?)')
      .run(targetId, owner.userId, owner.scopeKey, deviceId, row.local_id, row.session_id, RemoteSessionAdmission.Unverified, row.sync_environment, archiveId);
  }
  set(owner: RemoteOwner, targetId: string, deviceId: string, row: SyncRow, admission: RemoteSessionAdmission): void {
    const changed = this.store.db.prepare(`UPDATE remote_sync_session_admissions SET admission=? WHERE target_id=? AND local_session_id=?
      AND owner_user_id=? AND owner_scope_key=? AND device_id=? AND remote_session_id=?`)
      .run(admission, targetId, row.local_id, owner.userId, owner.scopeKey, deviceId, row.session_id).changes;
    if (changed !== 1) throw new RemoteSyncStateError('Synchronization admission identity changed');
  }
  validateAssociated(owner: RemoteOwner, deviceId: string, targetId: string, row: SyncRow, previousId?: string): void {
    const runIds = new Set<string>();
    for (const item of this.states()) {
      const direct = matchesSession(item.key, row.local_id);
      const value = parse(item.value);
      if (direct && !record(value)) throw new RemoteSyncStateError('Task synchronization evidence is malformed');
      const associated = direct || record(value) && (value.localSessionId === row.local_id || value.remoteSessionId === row.session_id);
      if (!associated || !record(value)) continue;
      if (item.key.startsWith('inbox:') && !record(value.owner)) throw new RemoteSyncStateError('Task synchronization command owner is missing');
      if (value.owner && !sameOwner(value.owner as RemoteOwner, owner) || value.deviceId && value.deviceId !== deviceId
        || value.remoteSessionId && value.remoteSessionId !== row.session_id || value.sessionId && value.sessionId !== row.session_id) {
        throw new RemoteSyncStateError('Task synchronization evidence identity conflicts');
      }
      if (value.targetId && value.targetId !== targetId && value.targetId !== previousId) throw new RemoteSyncStateError('Task synchronization execution target conflicts');
      if ((item.key === `run:${row.local_id}` || item.key.startsWith(`runHistory:${row.local_id}:`)) && typeof value.runId === 'string') runIds.add(value.runId);
    }
    for (const runId of runIds) {
      const saved = this.store.db.prepare('SELECT value FROM remote_state WHERE key=?').get(`syncRunTarget:${runId}`) as { value: string } | undefined;
      if (saved && parse(saved.value) !== targetId && parse(saved.value) !== previousId) throw new RemoteSyncStateError('Task synchronization run target conflicts');
    }
  }
}
