import Database from 'better-sqlite3';
import path from 'path';

import { OwnershipContentSyncReason as Reason, OwnershipContentSyncState as State, OwnershipSyncState } from '../../shared/ownership/constants';
import type { OwnershipContentSync, OwnershipTaskSync } from '../../shared/ownership/types';
import { payloadHash } from './canonical';
import type { RemoteDisplayHealthInput } from './remoteDisplayHealth';
import { readRemoteDisplayAdmission } from './remoteDisplayHealthAdmission';
import { displayTaskCanRetry, type TaskSyncRecord } from './remoteDisplayHealthTask';

export interface OwnershipContentSyncInput extends RemoteDisplayHealthInput { contentTaskId: string }
export interface OwnershipContentSyncSnapshot extends OwnershipTaskSync { observedAt: number }
export const unknownOwnershipContentSync = (): OwnershipTaskSync => ({ syncState: OwnershipSyncState.Pending,
  contentSync: { state: State.Unknown, reason: Reason.Unavailable, retryable: false } });
const waiting = (): OwnershipTaskSync => ({ syncState: OwnershipSyncState.Pending,
  contentSync: { state: State.Waiting, reason: Reason.Connection, retryable: false } });
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const decimal = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/u.test(value);
const number = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('CONTENT_DISPLAY_INVALID'); return Number(value); };
const get = <T = Record<string, any>>(db: Database.Database, sql: string, ...args: any[]): T | undefined => db.prepare(sql).get(...args) as T | undefined;
const exists = (db: Database.Database, table: string): boolean => !!get(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table);
function json(raw: unknown): Record<string, any> {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 65536) throw new Error('CONTENT_DISPLAY_INVALID');
  const value: unknown = JSON.parse(raw); if (!object(value)) throw new Error('CONTENT_DISPLAY_INVALID'); return value;
}
function result(contentSync: OwnershipContentSync, controlPending = false): OwnershipTaskSync {
  return { contentSync, syncState: contentSync.state === State.Failed ? OwnershipSyncState.Failed
    : controlPending ? OwnershipSyncState.Pending : contentSync.state === State.Synced ? OwnershipSyncState.Synced
      : contentSync.state === State.Partial ? OwnershipSyncState.Partial : contentSync.state === State.Local ? OwnershipSyncState.Local : OwnershipSyncState.Pending };
}

/** Runs only in the existing readonly display worker. One target; no schema initialization or admission mutation. */
export function collectOwnershipContentSync(input: OwnershipContentSyncInput): OwnershipContentSyncSnapshot {
  const handles: Array<{ db: Database.Database; version: number }> = [], observedAt = Date.now();
  const open = (filename: string): Database.Database => {
    const db = new Database(filename, { readonly: true, fileMustExist: true, timeout: 50 });
    try {
      db.pragma('query_only=ON'); const version = Number(db.pragma('data_version', { simple: true }));
      db.exec('BEGIN'); db.prepare('SELECT name FROM sqlite_master LIMIT 1').get(); handles.push({ db, version }); return db;
    } catch (error) { db.close(); throw error; }
  };
  try {
    const read = (): OwnershipTaskSync => {
      const id = input.contentTaskId;
      if (typeof id !== 'string' || !id || id.length > 256) return unknownOwnershipContentSync();
      const core = open(input.database);
      const owned = get(core, `SELECT o.owner_user_id,o.owner_scope_key,o.ownership_status FROM cowork_sessions s
        LEFT JOIN cowork_session_ownership o ON o.session_id=s.id WHERE s.id=?`, id);
      if (!owned) return unknownOwnershipContentSync();
      if (owned.ownership_status === null) return result({ state: State.Local, retryable: false });
      if (owned.ownership_status !== 'confirmed' || owned.owner_user_id !== input.owner.userId || owned.owner_scope_key !== input.owner.scopeKey)
        return unknownOwnershipContentSync();
      if (!input.deviceId || !input.targetId || !input.availabilityScope) return waiting();
      const settings = get(core, 'SELECT CASE WHEN octet_length(value)<=65536 THEN value END AS value FROM remote_state WHERE key=?', input.settingsKey);
      if (!settings) return unknownOwnershipContentSync();
      if (json(settings.value).enabled !== true) return waiting();
      const binding = get(core, 'SELECT session_id,device_id,migration_frozen,sync_environment,needs_snapshot,source_seq,ack_seq FROM remote_sync WHERE local_id=?', id);
      if (!binding || binding.migration_frozen || binding.device_id !== input.deviceId || !binding.sync_environment
        || binding.sync_environment !== input.target && !get(core, 'SELECT 1 FROM remote_sync_target_aliases WHERE target_id=? AND environment=?', input.target, binding.sync_environment)) return waiting();
      if (get(core, 'SELECT 1 FROM remote_state WHERE key IN (?,?,?,?) LIMIT 1', `deletionClosed:${id}`, `sessionDeletion:${id}`, `localGcDeleted:${id}`, `deletionGuard:${id}`)
        || !readRemoteDisplayAdmission(core, input.owner, input.deviceId, input.targetId, id)) return waiting();
      const scope = `${input.targetId}:${input.owner.userId}:${input.owner.scopeKey}:${input.deviceId}`;
      if (input.availabilityScope !== scope) return unknownOwnershipContentSync();
      const locator = get(core, 'SELECT ledger_id,phase FROM remote_control_ledger_locator WHERE id=1');
      if (!locator || locator.phase !== 'ready') return unknownOwnershipContentSync();
      const control = open(path.join(path.dirname(input.database), 'remote-control.sqlite'));
      if (get(control, 'SELECT ledger_id FROM availability_identity WHERE id=1')?.ledger_id !== locator.ledger_id
        || get(control, 'SELECT phase FROM availability_migration WHERE id=1')?.phase !== 'ready') return unknownOwnershipContentSync();
      const availability = get(control, 'SELECT CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM availability_sessions WHERE scope=? AND local_id=?', scope, id);
      if (!availability) {
        const task = get<TaskSyncRecord>(core, `SELECT phase,scope,reason,server_retry_at,manual_retry_at,
          CASE WHEN octet_length(repair_json)<=4096 THEN repair_json ELSE 'null' END AS repair_json FROM remote_sync_task_state
          WHERE owner_user_id=? AND owner_scope_key=? AND target_key=? AND device_id=? AND local_session_id=?`, input.owner.userId, input.owner.scopeKey, input.target, input.deviceId, id);
        if (task?.phase === 'closed') return waiting();
        const projection = get(core, 'SELECT 1 FROM remote_projection_failures WHERE session_id=?', id);
        if (projection) {
          const retry = task ?? { phase: 'ready', scope: 'session', reason: '', server_retry_at: 0, manual_retry_at: -1, repair_json: '{"attempts":[],"times":[]}' } as TaskSyncRecord;
          const nextRetryAt = Math.max(number(retry.server_retry_at), retry.manual_retry_at < 0 ? 0 : number(retry.manual_retry_at) + 60000);
          return result({ state: State.Failed, reason: Reason.Content, retryable: displayTaskCanRetry(retry, observedAt), ...(nextRetryAt > observedAt ? { nextRetryAt } : {}) });
        }
        if (task && task.phase !== 'ready') return task.scope === 'service' || task.scope === 'owner_scope' ? waiting() : unknownOwnershipContentSync();
        if (get(core, 'SELECT 1 FROM remote_state WHERE key=?', `syncFailure:${id}`)) return unknownOwnershipContentSync();
        const pending = binding.needs_snapshot || number(binding.source_seq) !== number(binding.ack_seq)
          || get(core, 'SELECT 1 FROM remote_dirty WHERE session_id=?', id) || get(core, 'SELECT 1 FROM remote_state WHERE key=?', `import:${id}`);
        return result({ state: pending ? State.Pending : State.Synced, retryable: false });
      }
      const saved = json(availability.body);
      if (saved.scope !== scope || saved.localId !== id || saved.sessionId !== binding.session_id
        || typeof saved.writerGeneration !== 'string' || !saved.writerGeneration) return unknownOwnershipContentSync();
      if (saved.phase !== 'active') return waiting();
      const controlRevision = get(core, 'SELECT revision FROM remote_control_revisions WHERE session_id=?', id)?.revision;
      if (!Number.isSafeInteger(controlRevision) || !decimal(saved.controlRevision)) return unknownOwnershipContentSync();
      const controlPending = saved.controlRevision !== String(controlRevision)
        || !!get(control, "SELECT 1 FROM availability_requests WHERE scope=? AND local_id=? AND lane='control' AND resolution_receipt IS NULL LIMIT 1", scope, id);
      const liveFault = get(control, `SELECT MIN(CASE WHEN p.manual_retry_at IS NULL OR p.manual_retry_at<0 THEN 0 ELSE p.manual_retry_at+60000 END) AS retry_at
        FROM availability_faults f LEFT JOIN availability_encoding_probes p ON p.scope=f.scope AND p.local_id=f.local_id AND p.object_key=f.object_key
        WHERE f.scope=? AND f.local_id=? AND (substr(f.object_key,1,8)='message:' OR substr(f.object_key,1,5)='tool:')`, scope, id);
      if (liveFault?.retry_at !== null && liveFault?.retry_at !== undefined) {
        const nextRetryAt = number(liveFault.retry_at);
        return result({ state: State.Failed, reason: Reason.Content, retryable: nextRetryAt <= observedAt, ...(nextRetryAt > observedAt ? { nextRetryAt } : {}) }, controlPending);
      }
      const historyFault = get(control, "SELECT next_retry FROM availability_faults WHERE scope=? AND local_id=? AND object_key='history-recovery'", scope, id);
      if (historyFault) return result({ state: State.Failed, reason: Reason.History, retryable: false,
        ...(number(historyFault.next_retry) > observedAt ? { nextRetryAt: historyFault.next_retry } : {}) }, controlPending);
      const otherFault = get(control, 'SELECT 1 FROM availability_faults WHERE scope=? AND local_id=? LIMIT 1', scope, id);
      if (otherFault) return waiting();
      const hasAcks = exists(core, 'remote_availability_health_acks');
      const acks = hasAcks ? 'remote_availability_health_acks' : '(SELECT NULL scope,NULL session_id,NULL object_key,0 revision,NULL representation WHERE 0)';
      // Future ACKs and unsupported representations are uncertain evidence, even if another object is pending.
      const currentAcks = `SELECT a.representation,a.revision AS ack_revision,COALESCE(r.revision,1) AS source_revision FROM cowork_messages m
        LEFT JOIN remote_live_revisions r ON r.session_id=m.session_id AND r.object_id=m.id
        JOIN ${acks} a ON a.scope=? AND a.session_id=m.session_id AND a.object_key='message:'||m.id
        WHERE m.session_id=? AND m.type IN ('user','assistant','system','tool_use','tool_result') AND COALESCE(r.deleted,0)=0
          AND a.revision>=COALESCE(r.revision,1)
        UNION ALL SELECT a.representation,a.revision,r.revision FROM remote_live_tools r
        JOIN ${acks} a ON a.scope=? AND a.session_id=r.session_id AND a.object_key='tool:'||r.tool_id
        WHERE r.session_id=? AND a.revision>=r.revision`;
      if (get(core, `SELECT 1 FROM (${currentAcks}) WHERE ack_revision>source_revision OR representation IS NULL
        OR representation NOT IN ('complete','desktop_only','local_only') LIMIT 1`, scope, id, scope, id)) return unknownOwnershipContentSync();
      const partial = !!get(core, `SELECT 1 FROM (${currentAcks}) WHERE representation='desktop_only' LIMIT 1`, scope, id, scope, id);
      const pending = !!get(control, "SELECT 1 FROM availability_requests WHERE scope=? AND local_id=? AND lane='live' AND resolution_receipt IS NULL LIMIT 1", scope, id)
        || !!get(core, `SELECT 1 FROM cowork_messages m LEFT JOIN remote_live_revisions r ON r.session_id=m.session_id AND r.object_id=m.id
          LEFT JOIN ${acks} a ON a.scope=? AND a.session_id=m.session_id AND a.object_key='message:'||m.id
          WHERE m.session_id=? AND m.type IN ('user','assistant','system','tool_use','tool_result') AND COALESCE(r.deleted,0)=0 AND COALESCE(r.revision,1)>COALESCE(a.revision,0) LIMIT 1`, scope, id)
        || !!get(core, `SELECT 1 FROM remote_live_tools r LEFT JOIN ${acks} a ON a.scope=? AND a.session_id=r.session_id AND a.object_key='tool:'||r.tool_id
          WHERE r.session_id=? AND r.revision>COALESCE(a.revision,0) LIMIT 1`, scope, id);
      if (pending) return result({ state: State.Pending, retryable: false }, controlPending);
      if (input.historySupported) {
        const migration = get(core, 'SELECT phase,migration_id,manifest_hash,CASE WHEN octet_length(manifest_json)<=16384 THEN manifest_json END AS manifest_json FROM remote_history_migrations WHERE scope=? AND local_id=? AND writer_generation=?', scope, id, saved.writerGeneration);
        if (!migration || migration.phase !== 'ready') return unknownOwnershipContentSync();
        const manifest = json(migration.manifest_json), context = manifest.context;
        if (payloadHash(manifest) !== migration.manifest_hash || !object(context) || context.scope !== scope || context.localId !== id
          || context.sessionId !== binding.session_id || context.writerGeneration !== saved.writerGeneration || context.deviceId !== input.deviceId
          || context.owner?.userId !== input.owner.userId || context.owner?.scopeKey !== input.owner.scopeKey || !object(manifest.legacy)) return unknownOwnershipContentSync();
        const legacySource = number(manifest.legacy.source_seq), legacyAck = number(manifest.legacy.ack_seq);
        if (legacyAck > legacySource) return unknownOwnershipContentSync();
        const history = open(path.join(path.dirname(input.database), 'remote-sync.sqlite'));
        const profile = get(core, 'SELECT sidecar_id FROM remote_history_profile WHERE id=1');
        if (!profile || get(history, 'SELECT sidecar_id FROM history_identity WHERE id=1')?.sidecar_id !== profile.sidecar_id
          || !get(history, 'SELECT 1 FROM history_migration_copies WHERE migration_id=? AND manifest_hash=? AND manifest_json=?', migration.migration_id, migration.manifest_hash, migration.manifest_json)) return unknownOwnershipContentSync();
        const historyRow = get(history, 'SELECT CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM history_sessions WHERE scope=? AND local_id=? AND writer_generation=?', scope, id, saved.writerGeneration);
        if (!historyRow) return unknownOwnershipContentSync();
        const historyState = json(historyRow.body);
        if (historyState.scope !== scope || historyState.localId !== id || historyState.sessionId !== binding.session_id || historyState.writerGeneration !== saved.writerGeneration
          || historyState.owner?.userId !== input.owner.userId || historyState.owner?.scopeKey !== input.owner.scopeKey || historyState.deviceId !== input.deviceId
          || historyState.migrationId !== migration.migration_id || historyState.legacyMetadataHash !== migration.manifest_hash || !decimal(historyState.resolvedSourceSeq)) return unknownOwnershipContentSync();
        if (get(history, "SELECT 1 FROM history_operations WHERE scope=? AND local_id=? AND writer_generation=? AND state NOT IN ('pending','complete') LIMIT 1", scope, id, saved.writerGeneration)) return unknownOwnershipContentSync();
        if (BigInt(historyState.resolvedSourceSeq) < BigInt(legacySource)
          || get(history, "SELECT 1 FROM history_operations WHERE scope=? AND local_id=? AND writer_generation=? AND state='pending' LIMIT 1", scope, id, saved.writerGeneration))
          return result({ state: State.Pending, reason: Reason.History, retryable: false }, controlPending);
      }
      return result({ state: partial ? State.Partial : State.Synced, retryable: false }, controlPending);
    };
    const value = read();
    for (const { db, version } of handles) { db.exec('COMMIT'); if (Number(db.pragma('data_version', { simple: true })) !== version) throw new Error('CONTENT_DISPLAY_CHANGED'); }
    return { ...value, observedAt: Date.now() };
  } catch { return { ...unknownOwnershipContentSync(), observedAt: Date.now() }; }
  finally { for (const { db } of handles.reverse()) db.close(); }
}
