import type Database from 'better-sqlite3';

import type { RemoteOwner } from '../../shared/remote/constants';
import { isUnpublishedDesktopInputJob } from './remoteDesktopInputAdmission';
import { remotePublicationAllowed, RemotePublicationKind } from './remotePublicationOrigins';
import { RemoteSyncStateError } from './remoteRetention';
import type { SyncRow } from './remoteStore';

export class RemoteSyncAdmissionBudgetError extends RemoteSyncStateError {
  readonly reason = 'REMOTE_SYNC_ADMISSION_BUDGET';
  constructor(readonly targetId: string) { super('Legacy synchronization admission exceeds its local work budget'); }
}
export const admissionBudget = { rows: 2000, bytes: 8 * 1024 * 1024, recordBytes: 1024 * 1024, durationMs: 100 } as const;
interface StateRow { key: string; value: string }
export const RemoteSessionAdmission = { Unverified: 'unverified', Verified: 'verified', Quarantined: 'quarantined' } as const;
export const AdmissionJobPhase = { Archiving: 'archiving', Validating: 'validating', Complete: 'complete' } as const;
export interface AdmissionJob { target_id: string; device_id: string; owner_user_id: string; owner_scope_key: string; phase: string; table_index: number; row_cursor: number; task_cursor: string; previous_target: string | null; epoch: number }
export type RemoteSessionAdmission = typeof RemoteSessionAdmission[keyof typeof RemoteSessionAdmission];
const owned = "SELECT session_id FROM cowork_session_ownership WHERE owner_user_id=? AND owner_scope_key=? AND ownership_status='confirmed'";
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const parse = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return undefined; } };
export const taskPrefixes = ['import', 'run', 'runHistory', 'inputFence', 'question', 'questionDecision', 'approval', 'deletionGuard', 'localGcDeleted', 'deletionClosed'];
export const controlPrefixes = ['inbox:', 'syncRunTarget:', 'inputOperation:', 'sessionDeletion:', 'inputPreparation:', 'questionDecision:'];
const sharedPrefixes = [...controlPrefixes, 'desktopAsset:', 'fileOutput:'];
export const stateIdentitySql = (field: string): string => `CASE WHEN json_valid(value) THEN CASE
  WHEN json_type(value,'$.${field}')='text' AND length(json_extract(value,'$.${field}'))<=256 THEN json_extract(value,'$.${field}') END END`;
export const invalidInboxSql = "CASE WHEN json_valid(value) THEN json_type(value)<>'object' ELSE 1 END";

export function readRemoteSessionAdmission(db: Database.Database, owner: RemoteOwner, deviceId: string, targetId: string, localSessionId: string): boolean {
  if (!remotePublicationAllowed(db, RemotePublicationKind.Session, localSessionId, owner, targetId)) return false;
  const saved = db.prepare('SELECT * FROM remote_sync_session_admissions WHERE target_id=? AND local_session_id=?')
    .get(targetId, localSessionId) as { owner_user_id: string; owner_scope_key: string; device_id: string; remote_session_id: string; admission: string } | undefined;
  const row = db.prepare(`SELECT * FROM remote_sync WHERE local_id=? AND local_id IN (${owned})`)
    .get(localSessionId, owner.userId, owner.scopeKey) as SyncRow | undefined;
  if (!row) return false;
  if (saved) return saved.owner_user_id === owner.userId && saved.owner_scope_key === owner.scopeKey
    && saved.device_id === deviceId && saved.remote_session_id === row.session_id && saved.admission === RemoteSessionAdmission.Verified
    && row.sync_environment === targetId && (!row.device_id || row.device_id === deviceId);
  if (db.prepare("SELECT 1 FROM remote_sync_admission_evidence WHERE archive_id=? AND table_name='remote_sync' AND row_key=?")
    .get(`admission:${targetId}`, localSessionId)) return false;
  // A completed incremental gate must have covered every row that existed before activation.
  // Fresh post-activation rows remain eligible for the ordinary pristine path.
  const job = db.prepare('SELECT phase FROM remote_sync_admission_jobs WHERE target_id=?').get(targetId) as { phase: string } | undefined;
  if (job && job.phase !== AdmissionJobPhase.Complete) return false;
  // Existing identified working sets retain their persisted identity; genuinely new local rows have no remote authority to transfer.
  return row.sync_environment === targetId && row.device_id === deviceId || readRemoteSessionPristine(db, row, targetId);
}
export function readRemoteSessionPristine(db: Database.Database, row: SyncRow, targetId?: string): boolean {
  if (row.device_id || row.ack_seq || row.server_seq !== '0' || row.sync_protocol_version !== 1 || row.stream_epoch || row.sync_environment && row.sync_environment !== targetId) return false;
  // Unknown execution evidence still prevents proving a task pristine. The
  // partial index makes this check independent of unrelated healthy history.
  if (db.prepare(`SELECT 1 FROM remote_state WHERE key>='inbox:' AND key<'inbox;' AND ${invalidInboxSql}=1 LIMIT 1`).get()) return false;
  for (const item of readRemoteAdmissionAssociatedStates(db, row, targetId || '')) {
    if (item.key === `import:${row.local_id}` || item.key === `localGcDeleted:${row.local_id}` || item.key === `deletionClosed:${row.local_id}`) return false;
    if (item.key === `runCommand:${row.local_id}` && parse(item.value) !== null) return false;
    if (item.key === `run:${row.local_id}` || item.key.startsWith(`runHistory:${row.local_id}:`)) {
      const run = parse(item.value);
      if (!record(run) || typeof run.runId !== 'string') return false;
      const saved = db.prepare('SELECT value FROM remote_state WHERE key=?').get(`syncRunTarget:${run.runId}`) as { value: string } | undefined;
      if (saved && parse(saved.value) !== targetId) return false;
    }
    if (!sharedPrefixes.some(prefix => item.key.startsWith(prefix))) continue;
    const value = parse(item.value);
    if (isUnpublishedDesktopInputJob(db, item.key, value, row)) continue;
    if (record(value) && (value.localSessionId === row.local_id || value.remoteSessionId === row.session_id || value.sessionId === row.session_id)) return false;
  }
  return true;
}
/** Bounded seeks for one task; never materialize every remote_state body per task. */
export function *readRemoteAdmissionAssociatedStates(db: Database.Database, row: SyncRow, targetId: string): Iterable<StateRow> {
  if (row.local_id.length > 256 || row.session_id.length > 256) throw new RemoteSyncAdmissionBudgetError(targetId);
  const selectors: Array<{ where: string; params: string[] }> = [];
  for (const prefix of [...taskPrefixes, 'runCommand']) {
    const key = `${prefix}:${row.local_id}`;
    selectors.push({ where: 'key=?', params: [key] }, { where: 'key>=? AND key<?', params: [`${key}:`, `${key};`] });
  }
  for (const field of ['localSessionId', 'remoteSessionId', 'sessionId']) selectors.push({
    where: `${stateIdentitySql(field)}=?`, params: [field === 'localSessionId' ? row.local_id : row.session_id],
  });
  const seen = new Set<string>(), started = performance.now(); let bytes = 0;
  for (const selector of selectors) {
    let cursor = '';
    while (true) {
      if (performance.now() - started > admissionBudget.durationMs) throw new RemoteSyncAdmissionBudgetError(targetId);
      const page = db.prepare(`SELECT key,octet_length(value) AS bytes,
        CASE WHEN octet_length(value)<=${admissionBudget.recordBytes} THEN value END AS value FROM remote_state
        WHERE ${selector.where} AND key>? ORDER BY key LIMIT 32`).all(...selector.params, cursor) as Array<{ key: string; bytes: number; value: string | null }>;
      if (!page.length) break;
      for (const item of page) {
        cursor = item.key;
        if (seen.has(item.key)) continue;
        seen.add(item.key); bytes += item.bytes;
        if (item.value === null || seen.size > admissionBudget.rows || bytes > admissionBudget.bytes) throw new RemoteSyncAdmissionBudgetError(targetId);
        yield { key: item.key, value: item.value };
      }
      if (page.length < 32) break;
    }
  }
}

/** Exact existing display admission checks, without initializing or changing any schema. */
export function readRemoteDisplayAdmission(db: Database.Database, owner: RemoteOwner, deviceId: string, targetId: string | null, id: string): boolean {
  if (db.prepare('SELECT 1 FROM remote_run_isolation WHERE session_id=?').get(id)) return false;
  if (!targetId) return true;
  if (db.prepare("SELECT 1 FROM remote_sync_admission_jobs WHERE owner_user_id=? AND owner_scope_key=? AND phase<>'complete' LIMIT 1").get(owner.userId, owner.scopeKey)) return false;
  const active = db.prepare(`SELECT t.target_id,t.device_id,t.sync_target_json FROM remote_sync_target_active a JOIN remote_sync_targets t ON t.target_id=a.target_id
    WHERE a.owner_user_id=? AND a.owner_scope_key=?`).get(owner.userId, owner.scopeKey) as { target_id: string; device_id: string; sync_target_json: string | null } | undefined;
  // active() also parses this persisted metadata before admitting a task.
  if (active?.sync_target_json) JSON.parse(active.sync_target_json);
  return active?.target_id === targetId && active.device_id === deviceId && readRemoteSessionAdmission(db, owner, deviceId, targetId, id);
}
