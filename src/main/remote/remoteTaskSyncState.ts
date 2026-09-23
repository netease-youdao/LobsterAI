import type Database from 'better-sqlite3';
import { createHash } from 'crypto';

import { type RemoteOwner, type RemoteSyncTaskIssue, RemoteSyncTaskIssueStatus } from '../../shared/remote/constants';
import type { SyncRow } from './remoteStore';

export const TaskSyncPhase = {
  Ready: 'ready', Backoff: 'backoff', Cooldown: 'cooldown', Waiting: 'waiting_dependency',
  Reconciling: 'reconciling', Repairing: 'repairing', Isolated: 'isolated', Closed: 'closed',
} as const;
export type TaskSyncPhase = typeof TaskSyncPhase[keyof typeof TaskSyncPhase];
export const TaskSyncFailureReason = { RetryHintInvalid: 'REMOTE_RETRY_HINT_INVALID' } as const;
export interface TaskSyncHealth {
  failedSessions: number; retryingSessions: number; isolatedSessions: number;
  taskIssues: RemoteSyncTaskIssue[]; taskIssuesTruncated: boolean;
}
export interface TaskSyncContext { owner: RemoteOwner; target: string; deviceId: string }
export interface TaskSyncFailure { phase: TaskSyncPhase; scope: string; reason: string; repairable?: boolean; retryAfterMs?: number }
export class RemoteTaskDataError extends Error {
  constructor(message: string, readonly repairable = false) { super(message); }
}
export interface TaskSyncRecord {
  local_session_id: string; phase: TaskSyncPhase; next_retry_at: number; failure_count: number;
  reason: string; scope: string; fingerprint: string; last_served_at: number; last_progress_at: number;
  pending_since: number; repair_json: string; manual_retry_at: number; server_retry_at: number;
}
interface RepairLedger { attempts: string[]; times: number[] }
const NEVER = Number.MAX_SAFE_INTEGER;
const DAY = 86400000;
const identity = (context: TaskSyncContext): string[] => [context.owner.userId, context.owner.scopeKey, context.target, context.deviceId];

/** Scheduling hints never replace source watermarks, immutable operations or admission evidence. */
export class RemoteTaskSyncState {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now, private readonly random: () => number = Math.random) {
    db.exec(`CREATE TABLE IF NOT EXISTS remote_sync_task_state (
      owner_user_id TEXT NOT NULL,owner_scope_key TEXT NOT NULL,target_key TEXT NOT NULL,device_id TEXT NOT NULL,local_session_id TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'ready',next_retry_at INTEGER NOT NULL DEFAULT 0,failure_count INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',scope TEXT NOT NULL DEFAULT 'session',fingerprint TEXT NOT NULL DEFAULT '',
      last_served_at INTEGER NOT NULL DEFAULT 0,last_progress_at INTEGER NOT NULL DEFAULT 0,pending_since INTEGER NOT NULL,
      repair_json TEXT NOT NULL DEFAULT '{"attempts":[],"times":[]}',manual_retry_at INTEGER NOT NULL DEFAULT -1,server_retry_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(owner_user_id,owner_scope_key,target_key,device_id,local_session_id));
      CREATE INDEX IF NOT EXISTS idx_remote_sync_task_due ON remote_sync_task_state(owner_user_id,owner_scope_key,target_key,device_id,phase,next_retry_at,last_served_at,local_session_id);`);
    const columns = db.prepare('PRAGMA table_info(remote_sync_task_state)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'server_retry_at')) db.transaction(() => {
      db.exec('ALTER TABLE remote_sync_task_state ADD COLUMN server_retry_at INTEGER NOT NULL DEFAULT 0');
      // An older scheduler did not distinguish server deadlines. Preserve its existing wait conservatively.
      db.exec(`UPDATE remote_sync_task_state SET server_retry_at=next_retry_at
        WHERE phase IN ('backoff','cooldown','waiting_dependency') AND next_retry_at>0;
        UPDATE remote_sync_task_state SET manual_retry_at=-1 WHERE manual_retry_at=0;`);
    })();
  }
  private args(context: TaskSyncContext, id: string): string[] { return [...identity(context), id]; }
  get(context: TaskSyncContext, id: string): TaskSyncRecord | null {
    return this.db.prepare('SELECT * FROM remote_sync_task_state WHERE owner_user_id=? AND owner_scope_key=? AND target_key=? AND device_id=? AND local_session_id=?').get(...this.args(context, id)) as TaskSyncRecord || null;
  }
  private ensure(context: TaskSyncContext, id: string): TaskSyncRecord {
    this.db.prepare('INSERT OR IGNORE INTO remote_sync_task_state(owner_user_id,owner_scope_key,target_key,device_id,local_session_id,pending_since,manual_retry_at) VALUES(?,?,?,?,?,?,-1)').run(...this.args(context, id), this.now());
    return this.get(context, id)!;
  }
  eligible(context: TaskSyncContext, id: string): boolean {
    const value = this.get(context, id);
    return !value || ![TaskSyncPhase.Isolated, TaskSyncPhase.Closed].some(phase => phase === value.phase)
      && value.next_retry_at <= this.now() && value.server_retry_at <= this.now();
  }
  served(context: TaskSyncContext, id: string): void {
    this.ensure(context, id);
    this.db.prepare('UPDATE remote_sync_task_state SET last_served_at=? WHERE owner_user_id=? AND owner_scope_key=? AND target_key=? AND device_id=? AND local_session_id=?').run(this.now(), ...this.args(context, id));
  }
  defer(context: TaskSyncContext, id: string, delayMs: number): void {
    this.ensure(context, id);
    this.db.prepare("UPDATE remote_sync_task_state SET next_retry_at=MAX(?,next_retry_at,server_retry_at) WHERE owner_user_id=? AND owner_scope_key=? AND target_key=? AND device_id=? AND local_session_id=? AND phase NOT IN ('isolated','closed')").run(this.now() + delayMs, ...this.args(context, id));
  }
  /** A successful state query is not a publication ACK and must not reset a failure or repair budget. */
  resumeAfterVerification(context: TaskSyncContext, id: string): void {
    this.ensure(context, id);
    this.db.prepare(`UPDATE remote_sync_task_state SET phase=CASE WHEN server_retry_at>? THEN 'backoff' ELSE 'ready' END,
      next_retry_at=server_retry_at WHERE owner_user_id=? AND owner_scope_key=? AND target_key=? AND device_id=? AND local_session_id=?
      AND phase='reconciling'`).run(this.now(), ...this.args(context, id));
  }
  progress(context: TaskSyncContext, id: string, complete = false): void {
    const value = this.ensure(context, id);
    if (value.phase === TaskSyncPhase.Closed) return;
    const ledger = this.ledger(value);
    // Only confirmed publication clears unresolved repair facts, not a heartbeat or a source edit.
    if (complete && ledger) ledger.attempts = [];
    this.db.prepare(`UPDATE remote_sync_task_state SET failure_count=0,last_progress_at=?,next_retry_at=server_retry_at,
      phase=?,reason=CASE WHEN ? THEN '' ELSE reason END,repair_json=? WHERE owner_user_id=? AND owner_scope_key=? AND target_key=? AND device_id=? AND local_session_id=?`)
      .run(this.now(), value.server_retry_at > this.now() ? TaskSyncPhase.Backoff
          : !complete && value.phase === TaskSyncPhase.Repairing ? TaskSyncPhase.Repairing : TaskSyncPhase.Ready, complete ? 1 : 0,
        ledger ? JSON.stringify(ledger) : value.repair_json, ...this.args(context, id));
  }
  fail(context: TaskSyncContext, id: string, failure: TaskSyncFailure): TaskSyncRecord {
    const value = this.ensure(context, id), now = this.now();
    if (value.phase === TaskSyncPhase.Closed) return value;
    const fingerprint = createHash('sha256').update(JSON.stringify([failure.scope, failure.reason])).digest('hex');
    const count = value.failure_count + 1;
    let phase = failure.phase;
    const invalidWait = failure.retryAfterMs !== undefined && (!Number.isSafeInteger(failure.retryAfterMs)
      || failure.retryAfterMs < 0 || failure.retryAfterMs > NEVER - now);
    if (invalidWait) phase = TaskSyncPhase.Isolated;
    const serverRetryAt = invalidWait ? NEVER : Math.max(value.server_retry_at, failure.retryAfterMs === undefined ? 0 : now + failure.retryAfterMs);
    if (phase === 'backoff' && count >= 5) phase = 'cooldown';
    const delay = phase === 'cooldown' || phase === 'waiting_dependency' ? 900000 + Math.floor(this.random() * 180000)
      : [30000, 60000, 120000, 300000][Math.min(3, count - 1)] * (0.8 + this.random() * 0.4);
    const retry = ['isolated', 'closed'].includes(phase) ? NEVER : Math.max(serverRetryAt, Math.min(NEVER, Math.ceil(now + delay)));
    this.db.prepare(`UPDATE remote_sync_task_state SET phase=?,next_retry_at=?,failure_count=?,reason=?,scope=?,fingerprint=?,server_retry_at=?
      WHERE owner_user_id=? AND owner_scope_key=? AND target_key=? AND device_id=? AND local_session_id=?`)
      .run(phase, retry, count, invalidWait ? TaskSyncFailureReason.RetryHintInvalid : failure.reason.slice(0, 160), failure.scope, fingerprint, serverRetryAt, ...this.args(context, id));
    return this.get(context, id)!;
  }
  private ledger(value: TaskSyncRecord): RepairLedger | null {
    try {
      if (value.repair_json.length > 4096) return null;
      const parsed = JSON.parse(value.repair_json);
      if (!Array.isArray(parsed.attempts) || parsed.attempts.length > 8 || !parsed.attempts.every((key: unknown) => typeof key === 'string' && /^[a-f0-9]{64}$/u.test(key))
        || !Array.isArray(parsed.times) || parsed.times.length > 2 || !parsed.times.every((time: unknown) => typeof time === 'number' && Number.isSafeInteger(time) && time >= 0)) return null;
      return { attempts: parsed.attempts, times: parsed.times.filter((time: number) => time > this.now() - DAY) };
    } catch { return null; }
  }
  reserveRepair(context: TaskSyncContext, id: string, reason: string): boolean {
    return this.db.transaction(() => {
      const value = this.ensure(context, id), ledger = this.ledger(value);
      const key = createHash('sha256').update(reason).digest('hex');
      if (!ledger || value.phase === TaskSyncPhase.Closed || value.scope === 'device' || value.server_retry_at > this.now() || ledger.attempts.includes(key) || ledger.attempts.length >= 8 || ledger.times.length >= 2) return false;
      ledger.attempts.push(key); ledger.times.push(this.now());
      this.db.prepare(`UPDATE remote_sync_task_state SET phase='repairing',next_retry_at=0,repair_json=?
        WHERE owner_user_id=? AND owner_scope_key=? AND target_key=? AND device_id=? AND local_session_id=?`)
        .run(JSON.stringify(ledger), ...this.args(context, id));
      return true;
    })();
  }
  private canRetry(value: TaskSyncRecord, now: number): boolean {
    return value.phase !== TaskSyncPhase.Closed && value.scope !== 'device' && value.reason !== TaskSyncFailureReason.RetryHintInvalid && value.server_retry_at <= now
      && (value.manual_retry_at < 0 || now - value.manual_retry_at >= 60_000) && this.ledger(value) !== null;
  }
  manualRetry(context: TaskSyncContext, id: string): boolean {
    return this.db.transaction(() => {
      const value = this.ensure(context, id), now = this.now();
      if (!this.canRetry(value, now)) return false;
      this.db.prepare(`UPDATE remote_sync_task_state SET phase='reconciling',next_retry_at=server_retry_at,manual_retry_at=?
        WHERE owner_user_id=? AND owner_scope_key=? AND target_key=? AND device_id=? AND local_session_id=?`).run(now, ...this.args(context, id));
      return true;
    })();
  }
  candidates(context: TaskSyncContext, limit = 50): SyncRow[] {
    const admissionTables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('remote_sync_session_admissions','remote_sync_admission_evidence','remote_sync_targets')").all();
    const needsAdmission = admissionTables.length === 3 ? `OR EXISTS(SELECT 1 FROM remote_sync_session_admissions a
      JOIN remote_sync_targets target ON target.target_id=a.target_id AND target.owner_user_id=o.owner_user_id AND target.owner_scope_key=o.owner_scope_key
      WHERE a.target_id=? AND a.local_session_id=s.local_id AND a.owner_user_id=o.owner_user_id AND a.owner_scope_key=o.owner_scope_key
        AND (a.admission<>'verified' OR a.device_id<>?))
      OR EXISTS(SELECT 1 FROM remote_sync_admission_evidence e JOIN remote_sync_targets target ON e.archive_id='admission:'||target.target_id
        AND target.owner_user_id=o.owner_user_id AND target.owner_scope_key=o.owner_scope_key
        WHERE e.archive_id=? AND e.table_name='remote_sync' AND e.row_key=s.local_id
        AND NOT EXISTS(SELECT 1 FROM remote_sync_session_admissions a WHERE a.target_id=? AND a.local_session_id=s.local_id
          AND a.owner_user_id=o.owner_user_id AND a.owner_scope_key=o.owner_scope_key AND a.device_id=? AND a.admission='verified'))` : '';
    const admissionArgs = needsAdmission ? [context.target, context.deviceId, `admission:${context.target}`, context.target, context.deviceId] : [];
    return this.db.prepare(`SELECT s.* FROM remote_sync s JOIN cowork_session_ownership o ON o.session_id=s.local_id
      LEFT JOIN remote_sync_task_state t ON t.owner_user_id=o.owner_user_id AND t.owner_scope_key=o.owner_scope_key
        AND t.target_key=? AND t.device_id=? AND t.local_session_id=s.local_id
      LEFT JOIN remote_session_revisions r ON r.session_id=s.local_id
      WHERE o.owner_user_id=? AND o.owner_scope_key=? AND o.ownership_status='confirmed'
        AND (t.phase IS NULL OR (t.phase NOT IN ('isolated','closed') AND t.next_retry_at<=? AND t.server_retry_at<=?))
        AND (s.needs_snapshot=1 OR s.source_seq>s.ack_seq OR EXISTS(SELECT 1 FROM remote_dirty d WHERE d.session_id=s.local_id)
          OR EXISTS(SELECT 1 FROM remote_state x WHERE x.key='import:'||s.local_id OR x.key='syncFailure:'||s.local_id)
          OR t.phase='reconciling' ${needsAdmission})
      ORDER BY COALESCE(t.last_served_at,0),COALESCE(r.dirty_at,0),s.local_id LIMIT ?`)
      .all(context.target, context.deviceId, context.owner.userId, context.owner.scopeKey, this.now(), this.now(), ...admissionArgs, Math.max(1, Math.min(50, Number.isFinite(limit) ? Math.floor(limit) : 50))) as SyncRow[];
  }
  health(context: TaskSyncContext, admitted: (sessionId: string) => boolean = () => true): TaskSyncHealth {
    const visible = `FROM remote_sync_task_state t JOIN cowork_session_ownership o ON o.session_id=t.local_session_id
      JOIN cowork_sessions s ON s.id=t.local_session_id
      WHERE t.owner_user_id=? AND t.owner_scope_key=? AND t.target_key=? AND t.device_id=?
        AND o.owner_user_id=t.owner_user_id AND o.owner_scope_key=t.owner_scope_key AND o.ownership_status='confirmed'
        AND t.phase NOT IN ('ready','closed')`;
    const counts = this.db.prepare(`SELECT COUNT(*) AS failedSessions,
      COUNT(CASE WHEN t.phase IN ('backoff','cooldown','waiting_dependency','reconciling','repairing') THEN 1 END) AS retryingSessions,
      COUNT(CASE WHEN t.phase='isolated' THEN 1 END) AS isolatedSessions ${visible}`)
      .get(...identity(context)) as Omit<TaskSyncHealth, 'taskIssues' | 'taskIssuesTruncated'>;
    const rows = this.db.prepare(`SELECT t.*,s.title ${visible}
      ORDER BY CASE WHEN t.phase='isolated' THEN 0 ELSE 1 END,t.next_retry_at,t.local_session_id LIMIT 21`)
      .all(...identity(context)) as Array<TaskSyncRecord & { title: string | null }>;
    const now = this.now();
    const retryable = (value: TaskSyncRecord): boolean => {
      try { return this.canRetry(value, now) && admitted(value.local_session_id); }
      catch { return false; }
    };
    return { ...counts, taskIssuesTruncated: rows.length > 20, taskIssues: rows.slice(0, 20).map(value => ({
      localSessionId: value.local_session_id, title: typeof value.title === 'string' ? value.title.slice(0, 256) : '',
      status: value.phase === TaskSyncPhase.Isolated ? RemoteSyncTaskIssueStatus.Isolated
        : value.phase === TaskSyncPhase.Waiting ? RemoteSyncTaskIssueStatus.WaitingDependency
          : value.phase === TaskSyncPhase.Repairing ? RemoteSyncTaskIssueStatus.Repairing : RemoteSyncTaskIssueStatus.Retrying,
      ...(value.phase !== TaskSyncPhase.Isolated && value.next_retry_at < NEVER ? { nextRetryAt: value.next_retry_at } : {}),
      retryable: retryable(value),
    })) };
  }
}
