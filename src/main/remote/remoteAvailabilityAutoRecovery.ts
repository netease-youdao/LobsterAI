import type Database from 'better-sqlite3';

import { type RemoteSyncRecoveryDisplay, RemoteSyncRecoveryReason, RemoteSyncRecoveryState } from '../../shared/remote/recovery';
import { payloadHash, stableJson } from './canonical';
import { isRecoveryDependencyFailure } from './remoteRecoveryDependency';
import { assertRemoteSidecarHeadroom } from './remoteSidecarHeadroom';
import { finishRecoveryRequest, readRecoveryLedger, recoveryDependencyEvidence, type RecoveryLedger, RecoveryOutcome, RemoteRecoveryLimiter, reserveRecoveryRequest, reserveRecoveryRound } from './remoteSyncRecoveryLedger';
import { type RecoveryFailure, recoveryFailure, RemoteRecoveryPolicyVersion } from './remoteSyncRecoveryPolicy';

export const AvailabilityRecoveryLane = { Control: 'control', Live: 'live', History: 'history' } as const;
export type AvailabilityRecoveryLane = typeof AvailabilityRecoveryLane[keyof typeof AvailabilityRecoveryLane];
const BudgetKey = '@lane-budget';
const InitialDelay = 30_000;
const MaxFaults = 64;
const initialized = new WeakSet<Database.Database>();
export interface AvailabilityRecoveryIdentity {
  scope: string; localId: string; lane: AvailabilityRecoveryLane; objectKey: string;
  contextKey: string; operationKey: string;
}
interface Fault {
  version: 1; failure: RecoveryFailure; failureKey: string; contextKey: string; operationKey: string;
  state: RemoteSyncRecoveryDisplay['state']; expiresAt?: number;
}
interface Row { body: string; revision: number; next_probe_at: number }
type Access = <T>(action: (db: Database.Database) => T) => T;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const args = (identity: AvailabilityRecoveryIdentity): string[] => [identity.scope, identity.localId, identity.lane, identity.objectKey];
const budgetArgs = (identity: AvailabilityRecoveryIdentity): string[] => [identity.scope, identity.localId, identity.lane, BudgetKey];
const invalid = (): never => { throw new Error('REMOTE_AUTO_RECOVERY_RECORD_INVALID'); };

export class AvailabilityRecoveryDeferred extends Error {
  constructor(readonly retryAfterMs = InitialDelay) { super('REMOTE_AUTO_RECOVERY_DEFERRED'); }
}
export function initializeAvailabilityRecovery(db: Database.Database): void {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS availability_auto_recovery(scope TEXT NOT NULL,local_id TEXT NOT NULL,lane TEXT NOT NULL,
    object_key TEXT NOT NULL,next_probe_at INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,body TEXT NOT NULL,
    PRIMARY KEY(scope,local_id,lane,object_key));
    CREATE INDEX IF NOT EXISTS idx_availability_auto_recovery_due ON availability_auto_recovery(scope,next_probe_at,local_id,lane);`);
  initialized.add(db);
}
function fault(row: Row): Fault {
  if (typeof row.body !== 'string' || Buffer.byteLength(row.body) > 2048 || !Number.isSafeInteger(row.revision)
    || row.revision < 0 || !Number.isSafeInteger(row.next_probe_at) || row.next_probe_at < 0) return invalid();
  let value: Fault;
  try { value = JSON.parse(row.body); } catch { return invalid(); }
  if (!value || value.version !== 1 || ![value.failureKey, value.contextKey, value.operationKey].every(digest)
    || !recoveryFailure({ ...value.failure, data: value.failure })
    || !Object.values(RemoteSyncRecoveryState).includes(value.state)
    || value.expiresAt !== undefined && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0)) return invalid();
  return value;
}
function readRow(db: Database.Database, identity: AvailabilityRecoveryIdentity): Row | undefined {
  return db.prepare('SELECT CASE WHEN octet_length(body)<=2048 THEN body ELSE NULL END AS body,revision,next_probe_at FROM availability_auto_recovery WHERE scope=? AND local_id=? AND lane=? AND object_key=?')
    .get(...args(identity)) as Row | undefined;
}
function readBudget(db: Database.Database, identity: AvailabilityRecoveryIdentity): RecoveryLedger {
  const row = db.prepare('SELECT CASE WHEN octet_length(body)<=8192 THEN body ELSE NULL END AS body FROM availability_auto_recovery WHERE scope=? AND local_id=? AND lane=? AND object_key=?')
    .get(...budgetArgs(identity)) as { body: string } | undefined;
  if (!row && db.prepare(`SELECT 1 FROM availability_auto_recovery WHERE scope=? AND local_id=? AND lane=?
    AND object_key<>? AND revision>0 LIMIT 1`).get(...budgetArgs(identity))) invalid();
  return readRecoveryLedger(row ? row.body : '{}') ?? invalid();
}
function resumableBudget(db: Database.Database, identity: AvailabilityRecoveryIdentity, value: Fault): RecoveryLedger {
  const ledger = readBudget(db, identity);
  if (value.state === RemoteSyncRecoveryState.Recovering) {
    // A validated query may commit before the original lane ACK. Resume that exact unfinished attempt,
    // querying again; this is not a new opportunity and never authorizes a POST from cached display state.
    const round = [...ledger.rounds].reverse().find(item => item.failureKey === value.failureKey && item.contextKey === identity.contextKey
      && item.operationKey === identity.operationKey && item.outcome === RecoveryOutcome.Verified);
    if (round) { round.outcome = RecoveryOutcome.Pending; round.nextAt = 0; round.inflight = null; }
  }
  return ledger;
}
function writeBudget(db: Database.Database, identity: AvailabilityRecoveryIdentity, ledger: RecoveryLedger): void {
  const body = JSON.stringify(ledger);
  if (!readRecoveryLedger(body)) invalid();
  db.prepare(`INSERT INTO availability_auto_recovery(scope,local_id,lane,object_key,body) VALUES(?,?,?,?,?)
    ON CONFLICT(scope,local_id,lane,object_key) DO UPDATE SET body=excluded.body,revision=revision+1`)
    .run(...budgetArgs(identity), body);
}

/** Only actual original publication confirmation releases its consumed evidence; rate timestamps remain. */
export function completeAvailabilityRecovery(db: Database.Database, scope: string, localId: string, lane: AvailabilityRecoveryLane, objectKey: string, resolved = true): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='availability_auto_recovery'").get()) return;
  const identity = { scope, localId, lane, objectKey, contextKey: '', operationKey: '' };
  const row = readRow(db, identity);
  if (!row) return;
  const previous = fault(row), ledger = readBudget(db, identity);
  if (resolved) ledger.rounds = ledger.rounds.filter(round => round.failureKey !== previous.failureKey || round.operationKey !== previous.operationKey);
  writeBudget(db, identity, ledger);
  db.prepare('DELETE FROM availability_auto_recovery WHERE scope=? AND local_id=? AND lane=? AND object_key=?').run(...args(identity));
}

/** Shared by manual admission and read-only display; corruption cannot turn into a fresh retry budget. */
export function availabilityRecoveryMetadataValid(db: Database.Database, scope: string, localId: string): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='availability_auto_recovery'").get()) return true;
  try {
    const rows = db.prepare(`SELECT lane,object_key,CASE WHEN octet_length(body)<=8192 THEN body ELSE NULL END AS body,revision,next_probe_at
      FROM availability_auto_recovery WHERE scope=? AND local_id=? LIMIT ?`).all(scope, localId, MaxFaults * 3 + 4) as Array<Row & { object_key: string; lane: string }>;
    if (rows.length > MaxFaults * 3 + 3) return false;
    const budgets = new Set(rows.filter(row => row.object_key === BudgetKey).map(row => row.lane));
    return rows.every(row => row.object_key === BudgetKey ? !!readRecoveryLedger(row.body)
      : !!fault(row) && (budgets.has(row.lane) || row.revision === 0 && fault(row).state === RemoteSyncRecoveryState.Waiting));
  } catch { return false; }
}
/** Reader for display workers: never initializes, repairs, or writes either sidecar. */
export function readAvailabilityRecoveryDisplay(db: Database.Database, scope: string, localId: string, now = Date.now(), lanes?: readonly AvailabilityRecoveryLane[]): RemoteSyncRecoveryDisplay | undefined {
  if (!availabilityRecoveryMetadataValid(db, scope, localId)) return { state: RemoteSyncRecoveryState.Blocked, reason: RemoteSyncRecoveryReason.Unavailable };
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='availability_auto_recovery'").get()) return undefined;
  const rows = db.prepare(`SELECT CASE WHEN octet_length(body)<=2048 THEN body ELSE 'null' END AS body,revision,next_probe_at FROM availability_auto_recovery
    WHERE scope=? AND local_id=? AND object_key<>? ${lanes ? `AND lane IN (${lanes.map(() => '?').join(',')})` : ''} ORDER BY next_probe_at LIMIT ?`).all(scope, localId, BudgetKey, ...(lanes ?? []), MaxFaults + 1) as Row[];
  if (rows.length > MaxFaults) return { state: RemoteSyncRecoveryState.Blocked };
  let display: RemoteSyncRecoveryDisplay | undefined;
  try {
    for (const row of rows) {
      const value = fault(row);
      const current: RemoteSyncRecoveryDisplay = { state: value.state === RemoteSyncRecoveryState.Checking && row.next_probe_at <= now
        ? RemoteSyncRecoveryState.Waiting : value.state, ...(row.next_probe_at > now ? { nextProbeAt: row.next_probe_at } : {}),
      reason: value.failure.httpStatus === 426 || value.failure.reason === 'CAPABILITY_UNSUPPORTED'
        || value.failure.cause === 'protocol_requirement' || value.failure.cause === 'capability_unavailable' ? RemoteSyncRecoveryReason.Protocol : value.failure.httpStatus === 409 ? RemoteSyncRecoveryReason.Conflict : RemoteSyncRecoveryReason.Request };
      if (!display || current.state === RemoteSyncRecoveryState.Checking || current.state === RemoteSyncRecoveryState.Blocked
        && display.state !== RemoteSyncRecoveryState.Checking) display = current;
    }
  } catch { return { state: RemoteSyncRecoveryState.Blocked }; }
  return display;
}

/** Metadata only. Every returned response is still checked and committed by the original lane. */
export class RemoteAvailabilityAutoRecovery {
  constructor(private readonly access: Access) {}
  has(identity: AvailabilityRecoveryIdentity): boolean {
    return this.access(db => { initializeAvailabilityRecovery(db); return !!readRow(db, identity); });
  }
  record(identity: AvailabilityRecoveryIdentity, error: unknown, now = Date.now()): boolean {
    const failure = recoveryFailure(error);
    if (!failure) return false;
    this.access(db => {
      initializeAvailabilityRecovery(db);
      db.transaction(() => {
        const previous = readRow(db, identity);
        if (previous) {
          const value = fault(previous);
          if (value.contextKey !== identity.contextKey || value.operationKey !== identity.operationKey) invalid();
          if (value.state === RemoteSyncRecoveryState.Recovering) {
            const ledger = readBudget(db, identity);
            const previousRound = [...ledger.rounds].reverse().find(round => round.failureKey === value.failureKey
              && round.operationKey === identity.operationKey && round.outcome === RecoveryOutcome.Verified);
            if (previousRound) previousRound.outcome = RecoveryOutcome.Blocked;
            writeBudget(db, identity, ledger);
            db.prepare(`UPDATE availability_auto_recovery SET body=?,revision=revision+1
              WHERE scope=? AND local_id=? AND lane=? AND object_key=?`)
              .run(stableJson({ ...value, state: RemoteSyncRecoveryState.Blocked }), ...args(identity));
          }
          return;
        }
        const count = db.prepare('SELECT COUNT(*) AS count FROM availability_auto_recovery WHERE scope=? AND local_id=? AND lane=? AND object_key<>?')
          .get(...budgetArgs(identity)) as { count: number };
        if (count.count >= MaxFaults) invalid();
        assertRemoteSidecarHeadroom(db.name, 4096, 0);
        const retry = Number((error as { retryAfterMs?: unknown })?.retryAfterMs);
        const deadline = now + Math.max(InitialDelay, Number.isSafeInteger(retry) && retry > 0 ? retry : 0);
        const value: Fault = { version: 1, failure, failureKey: payloadHash([identity.contextKey, identity.lane, identity.objectKey, failure]),
          contextKey: identity.contextKey, operationKey: identity.operationKey, state: RemoteSyncRecoveryState.Waiting };
        db.prepare(`INSERT INTO availability_auto_recovery(scope,local_id,lane,object_key,next_probe_at,body) VALUES(?,?,?,?,?,?)`)
          .run(...args(identity), deadline, stableJson(value));
      })();
    });
    return true;
  }
  async probe<T>(identity: AvailabilityRecoveryIdentity, evidence: unknown, limiter: RemoteRecoveryLimiter | undefined,
    current: () => boolean, query: () => Promise<T>, validate: (result: T) => void, dependencyEpoch: () => number | null = () => 0): Promise<T> {
    const initialEpoch = dependencyEpoch();
    if (!limiter || !current() || initialEpoch === null) throw new AvailabilityRecoveryDeferred();
    const eligible = this.access(db => db.transaction(() => {
      const row = readRow(db, identity);
      if (!row) invalid();
      const value = fault(row!);
      if (value.contextKey !== identity.contextKey || value.operationKey !== identity.operationKey) invalid();
      const now = Date.now();
      if (row!.next_probe_at > now) return false;
      const ledger = resumableBudget(db, identity, value);
      const proof = recoveryDependencyEvidence(ledger, value.failureKey, initialEpoch, now);
      if (proof === null) return false;
      const evidenceKey = payloadHash({ policy: RemoteRecoveryPolicyVersion, evidence, dependencyEpoch: proof,
        expiry: value.expiresAt && now >= value.expiresAt ? value.expiresAt : null });
      const reserved = reserveRecoveryRound(ledger, { failureKey: value.failureKey, evidenceKey,
        contextKey: identity.contextKey, operationKey: identity.operationKey, now, dependencyEpoch: proof });
      if (reserved && reserveRecoveryRequest(reserved.ledger, reserved.round.attemptId, now, initialEpoch)) return true;
      if (value.state !== RemoteSyncRecoveryState.Blocked) db.prepare(`UPDATE availability_auto_recovery SET body=?,revision=revision+1
        WHERE scope=? AND local_id=? AND lane=? AND object_key=?`).run(stableJson({ ...value, state: RemoteSyncRecoveryState.Blocked }), ...args(identity));
      return false;
    })());
    if (!eligible) throw new AvailabilityRecoveryDeferred();
    const admitted = await limiter.run(identity.scope, async () => {
      const requestEpoch = dependencyEpoch();
      if (!current() || requestEpoch === null) throw new AvailabilityRecoveryDeferred();
      const reservation = this.access(db => db.transaction(() => {
        const row = readRow(db, identity);
        if (!row) invalid();
        const value = fault(row!);
        if (value.contextKey !== identity.contextKey || value.operationKey !== identity.operationKey) invalid();
        const now = Date.now();
        if (row!.next_probe_at > now) throw new AvailabilityRecoveryDeferred(row!.next_probe_at - now);
        const ledger = resumableBudget(db, identity, value);
        const proof = recoveryDependencyEvidence(ledger, value.failureKey, requestEpoch, now);
        if (proof === null) return null;
        const evidenceKey = payloadHash({ policy: RemoteRecoveryPolicyVersion, evidence, dependencyEpoch: proof,
          expiry: value.expiresAt && now >= value.expiresAt ? value.expiresAt : null });
        const reserved = reserveRecoveryRound(ledger, { failureKey: value.failureKey, evidenceKey,
          contextKey: identity.contextKey, operationKey: identity.operationKey, now, dependencyEpoch: proof });
        const request = reserved && reserveRecoveryRequest(reserved.ledger, reserved.round.attemptId, now, requestEpoch);
        if (!request) {
          db.prepare('UPDATE availability_auto_recovery SET body=?,revision=revision+1 WHERE scope=? AND local_id=? AND lane=? AND object_key=?')
            .run(stableJson({ ...value, state: RemoteSyncRecoveryState.Blocked }), ...args(identity));
          return null;
        }
        writeBudget(db, identity, request.ledger);
        const nextAt = request.ledger.rounds.find(round => round.attemptId === reserved!.round.attemptId)!.nextAt;
        db.prepare('UPDATE availability_auto_recovery SET body=?,next_probe_at=?,revision=revision+1 WHERE scope=? AND local_id=? AND lane=? AND object_key=?')
          .run(stableJson({ ...value, state: RemoteSyncRecoveryState.Checking }), nextAt, ...args(identity));
        return { token: request.token, value, revision: row!.revision + 1 };
      })());
      if (!reservation) throw new AvailabilityRecoveryDeferred();
      let result: T;
      try {
        result = await query();
        if (!current()) throw new AvailabilityRecoveryDeferred();
        // A known identity/content contradiction cannot be healed by changing IDs or by a sparse receipt.
        if (reservation.value.failure.cause === 'immutable_operation_conflict') throw new Error('REMOTE_AUTO_RECOVERY_EVIDENCE_INVALID');
        validate(result);
      } catch (error) {
        if (current()) this.finish(identity, reservation, false, error, dependencyEpoch());
        throw error;
      }
      if (!this.finish(identity, reservation, true, result, dependencyEpoch())) throw new AvailabilityRecoveryDeferred();
      return result;
    });
    if (!admitted.admitted) throw new AvailabilityRecoveryDeferred();
    return admitted.value;
  }
  private finish(identity: AvailabilityRecoveryIdentity, reservation: { token: string; value: Fault; revision: number }, success: boolean, response: unknown, dependencyEpoch: number | null): boolean {
    // Read the shared core proof outside the lane transaction; corrupt proof leaves this request unknown.
    if (dependencyEpoch === null) return false;
    return this.access(db => db.transaction(() => {
      const row = readRow(db, identity);
      if (!row || row.revision !== reservation.revision) return false;
      const value = fault(row), ledger = readBudget(db, identity), now = Date.now();
      const status = Number((response as { httpStatus?: unknown })?.httpStatus);
      const terminalFailure = !success && (status >= 400 && status < 500 && status !== 429
        || response instanceof Error && /(?:RECEIPT|STATE|CONTEXT|EVIDENCE).*INVALID$/u.test(response.message));
      const prior = ledger.rounds.find(round => round.inflight?.token === reservation.token);
      const retry = Number((response as { retryAfterMs?: unknown })?.retryAfterMs);
      const nextAt = now + Math.max([30_000, 60_000, 120_000][Math.min(2, Math.max(0, (prior?.failures ?? 1) - 1))],
        Number.isSafeInteger(retry) && retry > 0 ? retry : 0);
      const next = finishRecoveryRequest(ledger, reservation.token, { success, now, nextAt, dependencyEpoch,
        dependencyFailure: !success && !terminalFailure && isRecoveryDependencyFailure(response),
        ...(success ? { outcome: RecoveryOutcome.Verified } : terminalFailure ? { outcome: RecoveryOutcome.Blocked } : {}) });
      if (!next) return false;
      const outcome = next.rounds.find(round => round.attemptId === prior!.attemptId)!.outcome;
      const expiry = success ? Date.parse(String((response as { expiresAt?: unknown })?.expiresAt ?? '')) : NaN;
      const updated: Fault = { ...value, state: success ? RemoteSyncRecoveryState.Recovering
        : outcome === RecoveryOutcome.Blocked ? RemoteSyncRecoveryState.Blocked : RemoteSyncRecoveryState.Waiting,
      ...(Number.isSafeInteger(expiry) && expiry > now ? { expiresAt: expiry } : {}) };
      writeBudget(db, identity, next);
      db.prepare('UPDATE availability_auto_recovery SET body=?,next_probe_at=?,revision=revision+1 WHERE scope=? AND local_id=? AND lane=? AND object_key=?')
        .run(stableJson(updated), success ? 0 : nextAt, ...args(identity));
      return true;
    })());
  }
}
