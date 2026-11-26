import { RemoteDeletion } from '../../shared/remote/deletions';
import type { RetentionState } from '../../shared/remote/retention';
import { payloadHash, sameOwner, stableJson } from './canonical';
import { isRecoveryDependencyFailure } from './remoteRecoveryDependency';
import type { RemoteStore, SyncRow } from './remoteStore';
import { finishRecoveryRequest, readRecoveryLedger, RecoveryBudget, recoveryDependencyEvidence, RecoveryOutcome, RemoteRecoveryLimiter, reserveRecoveryRequest, reserveRecoveryRound } from './remoteSyncRecoveryLedger';
import { recoveryCapabilityKey, recoveryFailure, RemoteRecoveryPolicyVersion } from './remoteSyncRecoveryPolicy';
import { RemoteTaskSyncState,type TaskSyncContext, type TaskSyncRecord } from './remoteTaskSyncState';

const NEVER = Number.MAX_SAFE_INTEGER;
interface Dependencies {
  store: RemoteStore; tasks: RemoteTaskSyncState; limiter: RemoteRecoveryLimiter;
  dependencyEpoch?(): number | null; capabilities(): unknown; admitted(id: string): boolean;
  readState(row: SyncRow): Promise<RetentionState | null>;
  readImport(id: string): Promise<any>; validateImport(id: string, receipt: any): void;
  partsAvailable(id: string): Promise<boolean>;
  now?: () => number;
}
interface Evidence { state: string; manifestHash: string; stateVersion: string; targetStreamEpoch?: string }
/** A query-only coordinator. Publication and ACKs remain owned by the original bridge. */
export class RemoteLegacyRecovery {
  private evidence = new Map<string, Evidence>();
  private busy = false;
  constructor(private readonly deps: Dependencies) {}
  private dependencyEpoch(): number | null { return this.deps.dependencyEpoch ? this.deps.dependencyEpoch() : 0; }
  private get now(): number { return (this.deps.now ?? Date.now)(); }
  private captured(row: SyncRow, saved: any): string {
    return payloadHash(JSON.parse(JSON.stringify({ localId: row.local_id, sessionId: row.session_id, device: row.device_id, environment: row.sync_environment,
      protocol: row.sync_protocol_version, epoch: row.stream_epoch, ack: row.ack_seq, server: row.server_seq,
      migration: row.migration_frozen, snapshot: row.needs_snapshot,
      import: saved ? { id: saved.importId, session: saved.sessionId, manifest: saved.manifest?.manifestHash, base: saved.baseSourceSeq,
        expected: saved.expectedSourceSeq, server: saved.expectedServerSeq, protocol: saved.syncProtocolVersion, epoch: saved.expectedStreamEpoch,
        targetEpoch: saved.targetStreamEpoch, owner: saved.owner, device: saved.deviceId, environment: saved.environment } : null })));
  }
  private coreMatches(context: TaskSyncContext, row: SyncRow, captured: string): boolean {
    const store = this.deps.store, latest = store.sync(row.local_id);
    return !!latest && this.captured(latest, store.get(`import:${row.local_id}`)) === captured
      && sameOwner(store.owner(row.local_id), context.owner) && !store.isSyncClosed(row.local_id)
      && !store.get(`${RemoteDeletion.Fence}${row.local_id}`) && !store.get(`localGcDeleted:${row.local_id}`);
  }
  private persist(context: TaskSyncContext, row: SyncRow, captured: string, task: TaskSyncRecord,
    ledger: ReturnType<typeof readRecoveryLedger>, nextAt: number, promote = false): boolean {
    return this.deps.store.transaction(() => this.coreMatches(context, row, captured)
      && this.deps.tasks.saveRecovery(context, task, ledger, nextAt, promote));
  }
  async tick(context: TaskSyncContext, current: () => boolean): Promise<void> {
    if (this.busy || !current()) return;
    this.busy = true;
    try {
      for (const initial of this.deps.tasks.recoveryCandidates(context)) {
        if (!current()) return;
        const id = initial.local_session_id, row = this.deps.store.sync(id), saved: any = this.deps.store.get(`import:${id}`);
        if (!row) { this.deps.tasks.saveRecovery(context, initial, null, NEVER); continue; }
        const captured = this.captured(row, saved);
        const allowed = (): boolean => current() && this.coreMatches(context, row, captured) && this.deps.admitted(id);
        let admitted = false;
        try { admitted = allowed(); } catch { /* An unreadable admission ledger cannot grant recovery. */ }
        const failure = recoveryFailure(this.deps.store.get(`syncFailure:${id}`));
        const ledger = this.deps.tasks.recoveryLedger(initial);
        if (!admitted) { this.deps.tasks.saveRecovery(context, initial, null, Math.max(initial.server_retry_at, this.now + 60000)); continue; }
        if (!failure || !ledger) { this.persist(context, row, captured, initial, null, NEVER); continue; }
        if (!initial.auto_probe_version) { this.deps.tasks.scheduleRecovery(context, id); continue; }
        const capabilityKey = recoveryCapabilityKey(failure, this.deps.capabilities(), saved ?? { syncProtocolVersion: row.sync_protocol_version });
        const deadlines = [saved?.expiresAt, saved?.absoluteExpiresAt].map(value => typeof value === 'string' ? Date.parse(value) : NaN).filter(Number.isFinite);
        const expired = deadlines.some(deadline => deadline <= this.now);
        const operationKey = payloadHash(saved ? [saved.importId, saved.manifest?.manifestHash] : [row.session_id, row.stream_epoch, row.sync_protocol_version]);
        const failureKey = payloadHash([context, 'history', saved ? 'import' : 'batch', failure]);
        const currentDependencyEpoch = this.dependencyEpoch();
        const dependencyEpoch = recoveryDependencyEvidence(ledger, failureKey, currentDependencyEpoch, this.now);
        if (dependencyEpoch === null || currentDependencyEpoch === null) { this.persist(context, row, captured, initial, ledger, NEVER); continue; }
        const evidenceKey = payloadHash([capabilityKey, RemoteRecoveryPolicyVersion, expired, dependencyEpoch]);
        const contextKey = payloadHash([context, captured]);
        const reservation = reserveRecoveryRound(ledger, { failureKey, evidenceKey, contextKey, operationKey, now: this.now, dependencyEpoch });
        const future = deadlines.filter(deadline => deadline > this.now);
        if (!reservation) {
          const waitingWindow = !ledger.rounds.some(value => value.failureKey === failureKey && value.evidenceKey === evidenceKey) && ledger.times.length >= RecoveryBudget.Rounds
            ? Math.min(...ledger.times) + RecoveryBudget.Day : NEVER;
          this.persist(context, row, captured, initial, ledger, Math.min(waitingWindow > this.now ? waitingWindow : NEVER, future.length ? Math.min(...future) : NEVER)); continue;
        }
        const round = reservation.round;
        if (round.contextKey !== contextKey || round.operationKey !== operationKey) continue;
        const request = reserveRecoveryRequest(reservation.ledger, round.attemptId, this.now, currentDependencyEpoch);
        if (!request) { this.persist(context, row, captured, initial, reservation.ledger, Math.max(this.now + 1000, round.nextAt)); continue; }
        const permitted = await this.deps.limiter.run(stableJson(context), async () => {
          if (!allowed()) return;
          if (!this.persist(context, row, captured, initial, request.ledger, round.nextAt)) return;
          const claimed = this.deps.tasks.get(context, id)!;
          try {
            const known = this.evidence.get(round.attemptId);
            if (saved && !known) {
              const receipt = await this.deps.readImport(saved.importId);
              if (!allowed()) return;
              this.deps.validateImport(id, receipt);
              if (!['committed', 'uploading', 'expired', 'aborted'].includes(receipt?.state)
                || receipt.importId !== saved.importId || receipt.sessionId !== saved.sessionId || receipt.manifestHash !== saved.manifest?.manifestHash
                || receipt.baseSourceSeq !== saved.baseSourceSeq || receipt.expectedSourceSeq !== saved.expectedSourceSeq
                || receipt.expectedServerSeq !== saved.expectedServerSeq) throw new Error('REMOTE_AUTO_RECOVERY_RECEIPT_INVALID');
              const finished = finishRecoveryRequest(request.ledger, request.token, { success: true, now: this.now });
              if (finished && this.persist(context, row, captured, claimed, finished, this.now)) {
                if (this.evidence.size >= 50) this.evidence.delete(this.evidence.keys().next().value!);
                this.evidence.set(round.attemptId, { state: receipt.state, manifestHash: receipt.manifestHash, stateVersion: receipt.stateVersion, targetStreamEpoch: receipt.targetStreamEpoch });
              }
              return;
            }
            const remote = await this.deps.readState(row);
            if (!allowed()) return;
            let safe = false;
            if (saved && known && remote) {
              safe = !remote.activeImport || remote.activeImport.importId === saved.importId;
              if (known.state !== 'committed') {
                const support = this.deps.capabilities() as any;
                safe = safe && (saved.syncProtocolVersion !== 2 || support?.capabilities?.includes('sync_retention_v2') === true && support?.syncRetention?.version === 2)
                  && (!saved.replyProjection || support?.capabilities?.includes('reply_content_v1') === true && support?.projectionVersions?.includes(4) === true);
              }
              if (known.state === 'uploading') safe = safe && await this.deps.partsAvailable(id);
              if (saved.syncProtocolVersion === 2 && known.state === 'uploading') safe = safe && typeof known.targetStreamEpoch === 'string'
                && (!saved.expectedStreamEpoch || saved.expectedStreamEpoch === known.targetStreamEpoch);
            } else if (!saved && remote && !remote.activeImport && row.needs_snapshot) {
              // A durable, already-requested snapshot is a recovery plan; GET success alone is not one.
              safe = remote.syncProtocolVersion === row.sync_protocol_version && remote.streamEpoch === row.stream_epoch
                && failure.code === 47006 && this.deps.store.get<any>(`syncFailure:${id}`)?.validation === 'Changing the current run must advance controlVersion';
            }
            if (!allowed()) return;
            if (remote?.deleted || failure.cause === 'immutable_operation_conflict' && known?.state !== 'committed'
              || failure.code === 47006 && known && ['expired', 'aborted'].includes(known.state) && failure.cause !== 'run_version_conflict') safe = false;
            const finished = finishRecoveryRequest(request.ledger, request.token, { success: true, now: this.now,
              outcome: safe ? RecoveryOutcome.Verified : RecoveryOutcome.Blocked });
            if (finished && this.persist(context, row, captured, claimed, finished, future.length ? Math.min(...future) : NEVER, safe)) this.evidence.delete(round.attemptId);
          } catch (error) {
            if (!allowed()) return;
            const status = Number((error as { httpStatus?: number }).httpStatus);
            const transport = isRecoveryDependencyFailure(error) || status === 429 || status >= 500;
            const retry = Math.max(this.now + [30000, 60000, 120000][Math.min(2, round.failures)],
              this.now + Math.max(0, Number((error as { retryAfterMs?: number }).retryAfterMs) || 0));
            const failureEpoch = this.dependencyEpoch();
            if (failureEpoch === null) return;
            const finished = finishRecoveryRequest(request.ledger, request.token, { success: false, now: this.now, nextAt: retry, dependencyFailure: transport, dependencyEpoch: failureEpoch,
              ...(!transport ? { outcome: RecoveryOutcome.Blocked } : {}) });
            if (finished) this.persist(context, row, captured, claimed, finished,
              finished.rounds.at(-1)?.outcome === RecoveryOutcome.Pending ? retry : future.length ? Math.min(...future) : NEVER);
          }
        });
        if (permitted.admitted) return; // One request, then yield to ordinary content and control.
      }
    } finally { this.busy = false; }
  }
}
