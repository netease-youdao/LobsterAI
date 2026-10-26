import type Database from 'better-sqlite3';

import { type RemoteOwner, type RemoteSyncTaskIssue, RemoteSyncTaskIssueStatus } from '../../shared/remote/constants';

export const TaskSyncPhase = {
  Ready: 'ready', Backoff: 'backoff', Cooldown: 'cooldown', Waiting: 'waiting_dependency',
  Reconciling: 'reconciling', Repairing: 'repairing', Isolated: 'isolated', Closed: 'closed',
} as const;
export type TaskSyncPhase = typeof TaskSyncPhase[keyof typeof TaskSyncPhase];
export const TaskSyncFailureReason = { RetryHintInvalid: 'REMOTE_RETRY_HINT_INVALID' } as const;
export interface TaskSyncHealth {
  failedSessions: number; retryingSessions: number; isolatedSessions: number; countsTruncated?: boolean;
  taskIssues: RemoteSyncTaskIssue[]; taskIssuesTruncated: boolean;
}
export interface TaskSyncContext { owner: RemoteOwner; target: string; deviceId: string }
export interface TaskSyncRecord {
  local_session_id: string; phase: TaskSyncPhase; next_retry_at: number; failure_count: number;
  reason: string; scope: string; fingerprint: string; last_served_at: number; last_progress_at: number;
  pending_since: number; repair_json: string; manual_retry_at: number; server_retry_at: number; recovery_probe_version: number;
}

const NEVER = Number.MAX_SAFE_INTEGER;
const identity = (context: TaskSyncContext): string[] => [context.owner.userId, context.owner.scopeKey, context.target, context.deviceId];
/** Display eligibility only. Mutation handlers must recheck their current admission evidence. */
export function displayTaskCanRetry(value: TaskSyncRecord, now: number): boolean {
  if (!(value.phase !== TaskSyncPhase.Closed && value.scope !== 'device' && value.reason !== TaskSyncFailureReason.RetryHintInvalid
    && value.server_retry_at <= now && (value.manual_retry_at < 0 || now - value.manual_retry_at >= 60_000))) return false;
  try {
    if (value.repair_json.length > 4096) return false;
    const ledger = JSON.parse(value.repair_json);
    return Array.isArray(ledger.attempts) && ledger.attempts.length <= 8
      && ledger.attempts.every((key: unknown) => typeof key === 'string' && /^[a-f0-9]{64}$/u.test(key))
      && Array.isArray(ledger.times) && ledger.times.length <= 2
      && ledger.times.every((time: unknown) => typeof time === 'number' && Number.isSafeInteger(time) && time >= 0);
  } catch { return false; }
}

/** Pure read path shared by the scheduler display and the isolated health collector. */
export function readRemoteDisplayTaskHealth(db: Database.Database, context: TaskSyncContext,
  admitted: (sessionId: string) => boolean = () => true, visible: (sessionId: string) => boolean = () => true,
  now = Date.now()): TaskSyncHealth {
  const hasProjection = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_projection_failures'").get();
  const ownerFilter = "o.owner_user_id=? AND o.owner_scope_key=? AND o.ownership_status='confirmed'";
  const notDeleted = "NOT EXISTS(SELECT 1 FROM remote_state closed WHERE closed.key='deletionClosed:'||o.session_id)";
  const projectionIds = hasProjection ? `SELECT f.session_id AS id FROM cowork_session_ownership o
    JOIN remote_projection_failures f ON f.session_id=o.session_id JOIN cowork_sessions s ON s.id=o.session_id
    LEFT JOIN remote_sync_task_state t ON t.local_session_id=f.session_id AND t.owner_user_id=? AND t.owner_scope_key=? AND t.target_key=? AND t.device_id=?
    WHERE ${ownerFilter} AND ${notDeleted} AND COALESCE(t.phase,'ready')<>'closed' ORDER BY f.session_id LIMIT 65`
    : 'SELECT NULL AS id WHERE 0';
  const projectionJoin = hasProjection ? 'LEFT JOIN remote_projection_failures f ON f.session_id=ids.id' : '';
  const projectionReason = hasProjection ? 'f.reason' : 'NULL';
  const projectionRetry = hasProjection ? 'f.retry_at' : 'NULL';
  const projectionVisible = hasProjection ? "f.session_id IS NOT NULL AND COALESCE(t.phase,'ready')<>'closed'" : '0';
  // Both the summary and issue list derive from this same task set, including failures
  // discovered by the local worker before a network synchronization turn has run.
  const rows = db.prepare(`WITH task_ids AS (
    SELECT t.local_session_id AS id FROM remote_sync_task_state t
    JOIN cowork_session_ownership o ON o.session_id=t.local_session_id JOIN cowork_sessions s ON s.id=o.session_id
    WHERE t.owner_user_id=? AND t.owner_scope_key=? AND t.target_key=? AND t.device_id=?
      AND ${ownerFilter} AND ${notDeleted} AND t.phase NOT IN ('ready','closed') ORDER BY t.local_session_id LIMIT 65
  ), projection_ids AS (${projectionIds}), ids(id) AS (SELECT id FROM task_ids UNION SELECT id FROM projection_ids)
  SELECT ids.id AS local_session_id,substr(s.title,1,256) AS title,
    CASE WHEN t.phase NOT IN ('ready','closed') THEN t.phase
      WHEN ${projectionReason} IN ('REMOTE_PROJECTION_BUDGET','REMOTE_PROJECTION_PUBLICATION_INVALID') THEN 'isolated' ELSE 'backoff' END AS phase,
    substr(CASE WHEN t.phase NOT IN ('ready','closed') THEN t.reason ELSE ${projectionReason} END,1,160) AS reason,
    COALESCE(t.scope,'session') AS scope,COALESCE(t.next_retry_at,${projectionRetry},0) AS next_retry_at,
    COALESCE(t.server_retry_at,0) AS server_retry_at,COALESCE(t.manual_retry_at,-1) AS manual_retry_at,
    CASE WHEN t.local_session_id IS NULL THEN '{"attempts":[],"times":[]}'
      WHEN octet_length(t.repair_json)<=4096 THEN t.repair_json ELSE 'null' END AS repair_json
    FROM ids JOIN cowork_session_ownership o ON o.session_id=ids.id JOIN cowork_sessions s ON s.id=ids.id
    LEFT JOIN remote_sync_task_state t ON t.local_session_id=ids.id AND t.owner_user_id=? AND t.owner_scope_key=? AND t.target_key=? AND t.device_id=?
    ${projectionJoin}
    WHERE o.owner_user_id=? AND o.owner_scope_key=? AND o.ownership_status='confirmed'
      AND (t.phase NOT IN ('ready','closed') OR (${projectionVisible}))
      AND NOT EXISTS(SELECT 1 FROM remote_state closed WHERE closed.key='deletionClosed:'||ids.id)
    ORDER BY CASE WHEN phase='isolated' THEN 0 ELSE 1 END,next_retry_at,ids.id LIMIT 65`)
    .iterate(...identity(context), context.owner.userId, context.owner.scopeKey,
      ...(hasProjection ? [...identity(context), context.owner.userId, context.owner.scopeKey] : []),
      ...identity(context), context.owner.userId, context.owner.scopeKey) as Iterable<TaskSyncRecord & { title: string | null }>;
  const result: TaskSyncHealth = { failedSessions: 0, retryingSessions: 0, isolatedSessions: 0, taskIssues: [], taskIssuesTruncated: false };
  let scanned = 0;
  for (const value of rows) {
    if (scanned++ >= 64) { result.countsTruncated = true; result.taskIssuesTruncated = true; break; }
    if (!visible(value.local_session_id)) continue;
    result.failedSessions++;
    if (value.phase === TaskSyncPhase.Isolated) result.isolatedSessions++; else result.retryingSessions++;
    if (result.taskIssues.length >= 20) { result.taskIssuesTruncated = true; continue; }
    let retryable = false;
    try { retryable = displayTaskCanRetry(value, now) && admitted(value.local_session_id); } catch { /* A failed admission check cannot grant retry. */ }
    result.taskIssues.push({ localSessionId: value.local_session_id, title: typeof value.title === 'string' ? value.title : '',
      status: value.phase === TaskSyncPhase.Isolated ? RemoteSyncTaskIssueStatus.Isolated
        : value.phase === TaskSyncPhase.Waiting ? RemoteSyncTaskIssueStatus.WaitingDependency
          : value.phase === TaskSyncPhase.Repairing ? RemoteSyncTaskIssueStatus.Repairing : RemoteSyncTaskIssueStatus.Retrying,
      ...(value.phase !== TaskSyncPhase.Isolated && value.next_retry_at < NEVER ? { nextRetryAt: value.next_retry_at } : {}), retryable });
  }
  return result;
}
