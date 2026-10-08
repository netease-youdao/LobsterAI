import type Database from 'better-sqlite3';
import { createHash } from 'crypto';

import { type RemoteOwner, type RemoteSyncTaskIssue, RemoteSyncTaskIssueStatus } from '../../shared/remote/constants';
import { RemoteInputReason } from '../../shared/remote/input';
import { projectionFault, projectionProbeEligible } from './remoteProjectionFaults';
import type { SyncRow } from './remoteStore';
import { emitCommittedTelemetry, SyncTelemetry } from './remoteSyncTelemetry';
import { captureRemoteTelemetry } from './remoteTelemetry';

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
export interface TaskSyncFailure { phase: TaskSyncPhase; scope: string; reason: string; repairable?: boolean; retryAfterMs?: number; deferMs?: number }
export class RemoteTaskDataError extends Error {
  constructor(message: string, readonly repairable = false) { super(message); }
}
export interface TaskSyncRecord {
  local_session_id: string; phase: TaskSyncPhase; next_retry_at: number; failure_count: number;
  reason: string; scope: string; fingerprint: string; last_served_at: number; last_progress_at: number;
  pending_since: number; repair_json: string; manual_retry_at: number; server_retry_at: number; recovery_probe_version: number;
}
interface RepairLedger { attempts: string[]; times: number[] }
const NEVER = Number.MAX_SAFE_INTEGER;
const DAY = 86400000;
const RECOVERY_PROBE_VERSION = 1;
const INPUT_MODEL_RECOVERY_PROBE_VERSION = 3;
const legacyProbeReasons = new Set([TaskSyncFailureReason.RetryHintInvalid, 'REMOTE_TASK_SYNC_FAILED', 'REMOTE_IMPORT_CONTEXT_CHANGED', 'REMOTE_PROJECTION_CONTEXT_CHANGED', RemoteInputReason.Version]);
const identity = (context: TaskSyncContext): string[] => [context.owner.userId, context.owner.scopeKey, context.target, context.deviceId];

/** Scheduling hints never replace source watermarks, immutable operations or admission evidence. */
export class RemoteTaskSyncState {
  private projectionReconcileCursor = { context: '', id: '' };
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now, private readonly random: () => number = Math.random, private readonly afterCommit?: (observer: () => void) => void) {
    db.exec(`CREATE TABLE IF NOT EXISTS remote_sync_task_state (
      owner_user_id TEXT NOT NULL,owner_scope_key TEXT NOT NULL,target_key TEXT NOT NULL,device_id TEXT NOT NULL,local_session_id TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'ready',next_retry_at INTEGER NOT NULL DEFAULT 0,failure_count INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',scope TEXT NOT NULL DEFAULT 'session',fingerprint TEXT NOT NULL DEFAULT '',
      last_served_at INTEGER NOT NULL DEFAULT 0,last_progress_at INTEGER NOT NULL DEFAULT 0,pending_since INTEGER NOT NULL,
      repair_json TEXT NOT NULL DEFAULT '{"attempts":[],"times":[]}',manual_retry_at INTEGER NOT NULL DEFAULT -1,server_retry_at INTEGER NOT NULL DEFAULT 0,
      recovery_probe_version INTEGER NOT NULL DEFAULT 0,
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
    if (!columns.some(column => column.name === 'recovery_probe_version')) {
      db.exec('ALTER TABLE remote_sync_task_state ADD COLUMN recovery_probe_version INTEGER NOT NULL DEFAULT 0');
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_remote_sync_task_recovery
      ON remote_sync_task_state(owner_user_id,owner_scope_key,target_key,device_id,recovery_probe_version,local_session_id);
      CREATE INDEX IF NOT EXISTS idx_remote_sync_task_retry_deadline
      ON remote_sync_task_state(owner_user_id,owner_scope_key,target_key,device_id,MAX(next_retry_at,server_retry_at),local_session_id)
      WHERE phase NOT IN ('isolated','closed');`);
  }
  private report(context: TaskSyncContext, id: string, stage: string, outcome: string, reason?: string): void {
    try {
      const value = this.get(context, id);
      if (!value) return;
      const expected = JSON.stringify(value);
      const telemetry = captureRemoteTelemetry({ localSessionId: id, deviceId: context.deviceId, remoteOwnerId: context.owner.userId,
        ownerScopeId: context.owner.scopeKey, operationKind: SyncTelemetry.Kind.Repair, lane: 'history' });
      emitCommittedTelemetry(this.db, telemetry, SyncTelemetry.Event.Stage, { stage, outcome, phase: value.phase,
        reason, failureScope: value.scope, failureCount: value.failure_count, retryAfterMs: Math.max(0, value.next_retry_at - this.now()) },
        () => JSON.stringify(this.get(context, id)) === expected, this.afterCommit);
    } catch { /* A diagnostic cannot affect scheduling or its transaction. */ }
  }
  private args(context: TaskSyncContext, id: string): string[] { return [...identity(context), id]; }
  get(context: TaskSyncContext, id: string): TaskSyncRecord | null {
    return this.db.prepare('SELECT * FROM remote_sync_task_state WHERE owner_user_id=? AND owner_scope_key=? AND target_key=? AND device_id=? AND local_session_id=?').get(...this.args(context, id)) as TaskSyncRecord || null;
  }
  private ensure(context: TaskSyncContext, id: string): TaskSyncRecord {
    this.db.prepare('INSERT OR IGNORE INTO remote_sync_task_state(owner_user_id,owner_scope_key,target_key,device_id,local_session_id,pending_since,manual_retry_at,recovery_probe_version) VALUES(?,?,?,?,?,?,-1,?)').run(...this.args(context, id), this.now(), RECOVERY_PROBE_VERSION);
    return this.get(context, id)!;
  }
  eligible(context: TaskSyncContext, id: string): boolean {
    const value = this.get(context, id);
    return !value || ![TaskSyncPhase.Isolated, TaskSyncPhase.Closed].some(phase => phase === value.phase)
      && value.next_retry_at <= this.now() && value.server_retry_at <= this.now();
  }
  /** Network retry deadlines must not prevent local projection of healthy new events. */
  projectionEligible(context: TaskSyncContext, id: string): boolean {
    const value = this.get(context, id);
    if (!value || value.phase !== TaskSyncPhase.Isolated && value.phase !== TaskSyncPhase.Closed) return true;
    if (value.phase !== TaskSyncPhase.Isolated || !['REMOTE_PROJECTION_BUDGET','REMOTE_PROJECTION_PUBLICATION_INVALID'].includes(value.reason)) return false;
    // A grant is bound to the exact failure and target epoch, never inferred from a retry timestamp.
    return projectionProbeEligible(this.db, id, value.reason);
  }
  reconcileProjectionFailures(context: TaskSyncContext, canReconcile: (id: string) => boolean): void {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_projection_faults'").get()) return;
    const contextKey = JSON.stringify(identity(context));
    const cursor = this.projectionReconcileCursor.context === contextKey ? this.projectionReconcileCursor.id : '';
    const rows = this.db.prepare(`SELECT s.local_session_id,s.reason FROM remote_sync_task_state s
      JOIN remote_projection_faults p ON p.session_id=s.local_session_id AND p.probe_epoch=p.epoch
      JOIN remote_session_revisions r ON r.session_id=s.local_session_id AND p.published_revision=r.revision
      WHERE owner_user_id=? AND owner_scope_key=? AND target_key=? AND device_id=? AND phase='isolated'
        AND s.reason IN ('REMOTE_PROJECTION_BUDGET','REMOTE_PROJECTION_PUBLICATION_INVALID')
        AND NOT EXISTS(SELECT 1 FROM remote_projection_failures f WHERE f.session_id=s.local_session_id)
        AND s.local_session_id>? ORDER BY s.local_session_id LIMIT 16`)
      .all(...identity(context), cursor) as Array<{ local_session_id: string; reason: string }>;
    this.projectionReconcileCursor = { context: contextKey, id: rows.length === 16 ? rows.at(-1)!.local_session_id : '' };
    for (const row of rows) {
      try {
        const fault = projectionFault(this.db, row.local_session_id);
        if (!fault || fault.reason !== row.reason || fault.probe_epoch !== fault.epoch || !canReconcile(row.local_session_id)) continue;
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (typeof code === 'string' && /^SQLITE_(?:CORRUPT|NOTADB|FULL|IOERR)(?:_|$)/u.test(code)) throw error;
        continue; // A task-local admission failure must not monopolize the first recovery page.
      }
      // Local publication permits remote reconciliation. Only a later cloud ACK marks the revision clean.
      this.db.prepare(`UPDATE remote_sync_task_state SET phase='reconciling',next_retry_at=server_retry_at
        WHERE owner_user_id=? AND owner_scope_key=? AND target_key=? AND device_id=? AND local_session_id=? AND phase='isolated'`)
        .run(...this.args(context,row.local_session_id));
    }
  }
  /** One compatibility probe for old, ambiguous isolation. This grants scheduling only:
   * the bridge must reconcile original operations and verify the exact remote stream. */
  reconcileLegacyFailures(context: TaskSyncContext, canReconcile: (row: SyncRow) => boolean, limit = 50): {
    promotedIds: string[]; scanned: number; hasMore: boolean;
  } {
    const size = Math.max(1, Math.min(50, Number.isSafeInteger(limit) ? limit : 50));
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM remote_sync_task_state WHERE owner_user_id=? AND owner_scope_key=?
        AND target_key=? AND device_id=? AND (recovery_probe_version=0 OR recovery_probe_version=1 AND reason='REMOTE_RETRY_HINT_INVALID'
          OR recovery_probe_version>=0 AND recovery_probe_version<? AND reason=?) AND phase<>'ready'
        ORDER BY local_session_id LIMIT ?`).all(...identity(context), INPUT_MODEL_RECOVERY_PROBE_VERSION, RemoteInputReason.Version, size + 1) as TaskSyncRecord[];
      const promotedIds: string[] = [];
      for (const value of rows.slice(0, size)) {
        const id = value.local_session_id;
        // Mark every evaluated legacy row, including permanent/corrupt failures. A later
        // failure or restart cannot silently grant another automatic compatibility attempt.
        const probeVersion = value.reason === RemoteInputReason.Version ? INPUT_MODEL_RECOVERY_PROBE_VERSION
          : value.reason === TaskSyncFailureReason.RetryHintInvalid ? 2 : RECOVERY_PROBE_VERSION;
        const marked = this.db.prepare(`UPDATE remote_sync_task_state SET recovery_probe_version=?
          WHERE owner_user_id=? AND owner_scope_key=? AND target_key=? AND device_id=? AND local_session_id=?
            AND recovery_probe_version=?`).run(probeVersion, ...this.args(context, id), value.recovery_probe_version);
        if (marked.changes !== 1 || value.phase !== TaskSyncPhase.Isolated || value.scope !== 'session'
          || !legacyProbeReasons.has(value.reason) || this.ledger(value) === null
          || !Number.isSafeInteger(value.server_retry_at) || value.server_retry_at < 0 || value.server_retry_at === NEVER
          || value.fingerprint !== createHash('sha256').update(JSON.stringify([value.scope, value.reason])).digest('hex')) continue;
        const row = this.db.prepare(`SELECT s.* FROM remote_sync s JOIN cowork_sessions c ON c.id=s.local_id
          JOIN cowork_session_ownership o ON o.session_id=s.local_id
          WHERE s.local_id=? AND s.device_id=? AND o.owner_user_id=? AND o.owner_scope_key=?
            AND o.ownership_status='confirmed'`).get(id, context.deviceId, context.owner.userId, context.owner.scopeKey) as SyncRow | undefined;
        if (!row) continue;
        try {
          if (!canReconcile(row)) continue;
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (typeof code === 'string' && /^SQLITE_(?:CORRUPT|NOTADB|FULL|IOERR)(?:_|$)/u.test(code)) throw error;
          // Opaque task-local evidence must remain isolated, without preventing the
          // next task's independent verification or granting repeated restart probes.
          continue;
        }
        this.db.prepare(`UPDATE remote_sync_task_state SET phase='reconciling',next_retry_at=server_retry_at
          WHERE owner_user_id=? AND owner_scope_key=? AND target_key=? AND device_id=? AND local_session_id=?
            AND phase='isolated' AND scope='session' AND reason=? AND fingerprint=? AND recovery_probe_version=?`)
          .run(...this.args(context, id), value.reason, value.fingerprint, probeVersion);
        promotedIds.push(id);
      }
      return { promotedIds, scanned: Math.min(size, rows.length), hasMore: rows.length > size };
    })();
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
    this.report(context, id, SyncTelemetry.Stage.Reconcile, SyncTelemetry.Outcome.Completed);
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
    const recovered = complete && (value.failure_count > 0 || value.phase !== TaskSyncPhase.Ready || Boolean(value.reason));
    this.report(context, id, SyncTelemetry.Stage.TaskState, recovered ? SyncTelemetry.Outcome.Recovered : SyncTelemetry.Outcome.Completed);
  }
  fail(context: TaskSyncContext, id: string, failure: TaskSyncFailure): TaskSyncRecord {
    const value = this.ensure(context, id), now = this.now();
    if (value.phase === TaskSyncPhase.Closed) return value;
    const fingerprint = createHash('sha256').update(JSON.stringify([failure.scope, failure.reason])).digest('hex');
    const count = value.failure_count + 1;
    let phase = failure.phase;
    const validWait = failure.retryAfterMs !== undefined && Number.isSafeInteger(failure.retryAfterMs) && failure.retryAfterMs >= 0;
    const serverRetryAt = Math.max(value.server_retry_at, validWait ? Math.min(NEVER, now + failure.retryAfterMs!) : 0);
    if (phase === 'backoff' && count >= 5) phase = 'cooldown';
    const delay = phase === 'cooldown' || phase === 'waiting_dependency' ? 900000 + Math.floor(this.random() * 180000)
      : [30000, 60000, 120000, 300000][Math.min(3, count - 1)] * (0.8 + this.random() * 0.4);
    const retry = ['isolated', 'closed'].includes(phase) ? NEVER : Math.max(serverRetryAt, Math.min(NEVER, Math.ceil(now + delay)));
    this.db.prepare(`UPDATE remote_sync_task_state SET phase=?,next_retry_at=?,failure_count=?,reason=?,scope=?,fingerprint=?,server_retry_at=?,recovery_probe_version=?
      WHERE owner_user_id=? AND owner_scope_key=? AND target_key=? AND device_id=? AND local_session_id=?`)
      .run(phase, retry, count, failure.reason.slice(0, 160), failure.scope, fingerprint, serverRetryAt,
        failure.reason === RemoteInputReason.Version ? INPUT_MODEL_RECOVERY_PROBE_VERSION : RECOVERY_PROBE_VERSION, ...this.args(context, id));
    this.report(context, id, SyncTelemetry.Stage.TaskState,
      phase === TaskSyncPhase.Isolated ? SyncTelemetry.Outcome.Blocked : SyncTelemetry.Outcome.Deferred,
      failure.reason);
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
    const reserved = this.db.transaction(() => {
      const value = this.ensure(context, id), ledger = this.ledger(value);
      const key = createHash('sha256').update(reason).digest('hex');
      if (!ledger || value.phase === TaskSyncPhase.Closed || value.scope === 'device' || value.server_retry_at > this.now() || ledger.attempts.includes(key) || ledger.attempts.length >= 8 || ledger.times.length >= 2) {
        return false;
      }
      ledger.attempts.push(key); ledger.times.push(this.now());
      this.db.prepare(`UPDATE remote_sync_task_state SET phase='repairing',next_retry_at=0,repair_json=?
        WHERE owner_user_id=? AND owner_scope_key=? AND target_key=? AND device_id=? AND local_session_id=?`)
        .run(JSON.stringify(ledger), ...this.args(context, id));
      return true;
    })();
    this.report(context, id, SyncTelemetry.Stage.Repair, reserved ? SyncTelemetry.Outcome.Started : SyncTelemetry.Outcome.Blocked,
      reserved ? reason : SyncTelemetry.Reason.RetryBudget);
    return reserved;
  }
  private canRetry(value: TaskSyncRecord, now: number): boolean {
    return value.phase !== TaskSyncPhase.Closed && value.scope !== 'device' && value.reason !== TaskSyncFailureReason.RetryHintInvalid && value.server_retry_at <= now
      && (value.manual_retry_at < 0 || now - value.manual_retry_at >= 60_000) && this.ledger(value) !== null;
  }
  manualRetry(context: TaskSyncContext, id: string): boolean {
    const admitted = this.db.transaction(() => {
      const value = this.ensure(context, id), now = this.now();
      if (!this.canRetry(value, now)) {
        return false;
      }
      this.db.prepare(`UPDATE remote_sync_task_state SET phase='reconciling',next_retry_at=server_retry_at,manual_retry_at=?
        WHERE owner_user_id=? AND owner_scope_key=? AND target_key=? AND device_id=? AND local_session_id=?`).run(now, ...this.args(context, id));
      return true;
    })();
    this.report(context, id, SyncTelemetry.Stage.ManualRetry, admitted ? SyncTelemetry.Outcome.Started : SyncTelemetry.Outcome.Blocked,
      admitted ? undefined : SyncTelemetry.Reason.Guard);
    return admitted;
  }
  candidates(context: TaskSyncContext, limit = 50): SyncRow[] {
    return this.pendingCandidates(context, limit, false);
  }
  /** A future deadline uses the same pending/admission scope without granting early eligibility. */
  nextRetryAt(context: TaskSyncContext): number | null {
    return this.pendingCandidates(context, 1, true)[0]?.retry_at ?? null;
  }
  private pendingCandidates(context: TaskSyncContext, limit: number, future: boolean): Array<SyncRow & { retry_at: number }> {
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
    const deadline = 'MAX(t.next_retry_at,t.server_retry_at)';
    const source = future ? `remote_sync_task_state t INDEXED BY idx_remote_sync_task_retry_deadline
      JOIN remote_sync s ON s.local_id=t.local_session_id
      JOIN cowork_session_ownership o ON o.session_id=s.local_id AND o.owner_user_id=t.owner_user_id AND o.owner_scope_key=t.owner_scope_key`
      : `remote_sync s JOIN cowork_session_ownership o ON o.session_id=s.local_id
      LEFT JOIN remote_sync_task_state t ON t.owner_user_id=o.owner_user_id AND t.owner_scope_key=o.owner_scope_key
        AND t.target_key=? AND t.device_id=? AND t.local_session_id=s.local_id
      LEFT JOIN remote_session_revisions r ON r.session_id=s.local_id`;
    const scope = future ? 't.target_key=? AND t.device_id=? AND t.owner_user_id=? AND t.owner_scope_key=?'
      : 'o.owner_user_id=? AND o.owner_scope_key=?';
    const eligibility = future ? `t.phase NOT IN ('isolated','closed') AND ${deadline}>? AND ${deadline}<?
      AND NOT EXISTS(SELECT 1 FROM remote_state closed WHERE closed.key='deletionClosed:'||s.local_id)`
      : "t.phase IS NULL OR (t.phase NOT IN ('isolated','closed') AND t.next_retry_at<=? AND t.server_retry_at<=?)";
    return this.db.prepare(`SELECT s.*,${deadline} AS retry_at FROM ${source}
      WHERE ${scope} AND o.ownership_status='confirmed' AND (${eligibility})
        AND (s.needs_snapshot=1 OR s.source_seq>s.ack_seq OR EXISTS(SELECT 1 FROM remote_dirty d WHERE d.session_id=s.local_id)
          OR EXISTS(SELECT 1 FROM remote_state x WHERE x.key='import:'||s.local_id OR x.key='syncFailure:'||s.local_id)
          OR t.phase='reconciling' ${needsAdmission})
      ORDER BY ${future ? `${deadline},t.local_session_id` : 'COALESCE(t.last_served_at,0),COALESCE(r.dirty_at,0),s.local_id'} LIMIT ?`)
      .all(context.target, context.deviceId, context.owner.userId, context.owner.scopeKey, this.now(), future ? NEVER : this.now(), ...admissionArgs, Math.max(1, Math.min(50, Number.isFinite(limit) ? Math.floor(limit) : 50))) as Array<SyncRow & { retry_at: number }>;
  }
  health(context: TaskSyncContext, admitted: (sessionId: string) => boolean = () => true,
    visible: (sessionId: string) => boolean = () => true): TaskSyncHealth {
    const hasProjection = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_projection_failures'").get();
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
    const rows = this.db.prepare(`WITH task_ids AS (
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
    const now = this.now(); let scanned = 0;
    for (const value of rows) {
      if (scanned++ >= 64) { result.countsTruncated = true; result.taskIssuesTruncated = true; break; }
      if (!visible(value.local_session_id)) continue;
      result.failedSessions++;
      if (value.phase === TaskSyncPhase.Isolated) result.isolatedSessions++; else result.retryingSessions++;
      if (result.taskIssues.length >= 20) { result.taskIssuesTruncated = true; continue; }
      let retryable = false;
      try { retryable = this.canRetry(value, now) && admitted(value.local_session_id); } catch { /* A failed admission check cannot grant retry. */ }
      result.taskIssues.push({ localSessionId: value.local_session_id, title: typeof value.title === 'string' ? value.title : '',
        status: value.phase === TaskSyncPhase.Isolated ? RemoteSyncTaskIssueStatus.Isolated
          : value.phase === TaskSyncPhase.Waiting ? RemoteSyncTaskIssueStatus.WaitingDependency
            : value.phase === TaskSyncPhase.Repairing ? RemoteSyncTaskIssueStatus.Repairing : RemoteSyncTaskIssueStatus.Retrying,
        ...(value.phase !== TaskSyncPhase.Isolated && value.next_retry_at < NEVER ? { nextRetryAt: value.next_retry_at } : {}), retryable });
    }
    return result;
  }
}
