import type Database from 'better-sqlite3';

import { RemoteDeletion } from '../../shared/remote/deletions';
import { readRemoteSessionPristine } from './remoteDisplayHealthAdmission';
import { LEGACY_IMPORT_TAKEOVER_ARCHIVE_PREFIX } from './remoteImportSnapshots';
import type { SyncRow } from './remoteStore';

const tableExists = (db: Database.Database, table: string): boolean => Boolean(db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));

/** Absence of delivery authority permits a new explicit destination choice, never a transfer. */
export function hasNoRemotePublicationAuthority(db: Database.Database, id: string): boolean {
  const saved = db.prepare('SELECT * FROM remote_sync WHERE local_id=?').get(id) as SyncRow | undefined;
  const row: SyncRow = saved ?? { local_id: id, session_id: id, device_id: '', source_seq: 0, ack_seq: 0,
    server_seq: '0', needs_snapshot: 1, sync_environment: null, sync_protocol_version: 1, stream_epoch: null,
    source_purge_seq: '0', event_purge_seq: '0', migration_frozen: 0 };
  if (row.sync_environment !== null || row.migration_frozen !== 0 || row.source_purge_seq !== '0'
    || row.event_purge_seq !== '0' || !readRemoteSessionPristine(db, row)) return false;
  for (const [table, field] of [
    ['remote_sync_session_admissions', 'local_session_id'], ['remote_history_migrations', 'local_id'], ['remote_run_isolation', 'session_id'],
    ['remote_session_deletion_sync', 'local_session_id'], ['remote_availability_health_acks', 'session_id'],
  ]) {
    if (tableExists(db, table) && db.prepare(`SELECT 1 FROM ${table} WHERE ${field}=? LIMIT 1`).get(id)) return false;
  }
  for (const prefix of [RemoteDeletion.Fence, RemoteDeletion.Closed, 'localGcDeleted:', 'inputFence:']) {
    if (db.prepare('SELECT 1 FROM remote_state WHERE key=?').get(`${prefix}${id}`)) return false;
  }
  // A received deletion is durable before its first task fence is installed.
  if (db.prepare(`SELECT 1 FROM remote_state WHERE key>=? AND key<? AND CASE WHEN json_valid(value) THEN
    json_type(value,'$.target.localSessionId') IS NOT 'text' OR json_type(value,'$.target.sessionId') IS NOT 'text'
    OR length(json_extract(value,'$.target.localSessionId'))=0 OR length(json_extract(value,'$.target.sessionId'))=0
    OR json_extract(value,'$.target.localSessionId')=? OR json_extract(value,'$.target.sessionId') IN (?,?) ELSE 1 END LIMIT 1`)
    .get(RemoteDeletion.Inbox, `${RemoteDeletion.Inbox}\uffff`, id, id, row.session_id)) return false;
  const takeover = LEGACY_IMPORT_TAKEOVER_ARCHIVE_PREFIX;
  if (db.prepare(`SELECT 1 FROM remote_state WHERE key>=? AND key<? AND CASE WHEN json_valid(value) THEN
    json_type(value,'$.localId') IS NOT 'text' OR length(json_extract(value,'$.localId'))=0 OR json_extract(value,'$.localId')=?
    ELSE 1 END LIMIT 1`).get(takeover, `${takeover}\uffff`, id)) return false;
  // Input preparations use a local sessionId; a null sessionId is an unrelated
  // new-task preparation. Missing/malformed attribution cannot prove absence.
  if (db.prepare(`SELECT 1 FROM remote_state WHERE key>='inputPreparation:' AND key<'inputPreparation;' AND
    CASE WHEN json_valid(value) THEN CASE json_type(value,'$.sessionId')
      WHEN 'null' THEN 0 WHEN 'text' THEN length(json_extract(value,'$.sessionId'))=0 OR json_extract(value,'$.sessionId') IN (?,?) ELSE 1 END ELSE 1 END LIMIT 1`)
    .get(id, row.session_id)) return false;
  // Archived working sets are authority even when disconnected. Malformed mapping
  // evidence cannot be assigned to a different task and therefore fails closed.
  for (const table of ['remote_sync_target_archives', 'remote_sync_admission_evidence']) {
    if (!tableExists(db, table)) continue;
    if (db.prepare(`SELECT 1 FROM ${table} WHERE table_name='remote_sync' AND (row_key=? OR
      CASE WHEN json_valid(row_json) AND json_type(row_json)='object' THEN
        json_type(row_json,'$.local_id') IS NOT 'text' OR json_type(row_json,'$.session_id') IS NOT 'text'
        OR length(json_extract(row_json,'$.local_id'))=0 OR length(json_extract(row_json,'$.session_id'))=0
        OR json_extract(row_json,'$.local_id')=? ELSE 1 END) LIMIT 1`).get(id, id)) return false;
    if (db.prepare(`SELECT 1 FROM ${table} WHERE table_name='remote_state' AND
      CASE WHEN json_valid(row_json) AND json_type(row_json)='object' THEN
        json_type(row_json,'$.key') IS NOT 'text' OR json_type(row_json,'$.value') IS NOT 'text'
        OR CASE WHEN json_valid(json_extract(row_json,'$.value')) THEN 0 ELSE 1 END
        OR instr(row_key,':'||?)>0 OR instr(json_extract(row_json,'$.value'),?)>0 OR instr(json_extract(row_json,'$.value'),?)>0 ELSE 1 END LIMIT 1`)
      .get(id, JSON.stringify(id), JSON.stringify(row.session_id))) return false;
  }
  return true;
}
