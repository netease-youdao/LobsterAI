import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';

import type { RemoteOwner } from '../../shared/remote/constants';
import { type DeletionClaim, type DeletionCompletion, type DeletionOperation, type DeletionPermit, type DeletionReceipt, RemoteDeletion } from '../../shared/remote/deletions';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { ownershipOperationGate } from '../ownershipOperationGate';
import { payloadHash, sameOwner } from './canonical';
import { matchesRemoteDeletionTargetScope, samePersistedRemoteEnvironment } from './remoteEnvironmentMigration';
import { acknowledgeRemoteDeletionCompletion } from './remoteLocalGc';
import type { RemoteStore } from './remoteStore';
import type { SessionDeletionService } from './sessionDeletionService';

interface Context { owner: RemoteOwner; environment: string; deviceId: string; generation: string | null; enabled: boolean }
interface Report { reportId: string; result: Record<string, unknown> }
interface DeletionInbox extends DeletionClaim {
  phase: string; localFenceId: string; requestHash: string; permit?: DeletionPermit; permitRequest?: Record<string, unknown>; permitRequestPending?: boolean;
  report?: Report; receipt?: DeletionReceipt; completionReceipt?: DeletionCompletion;
  settlementReportId?: string; stopStatus?: string; journalRevision?: string;
}
export interface SessionDeletionDependencies {
  store: RemoteStore; service: SessionDeletionService; runtime: CoworkRuntime;
  context(): Context | null;
  controlsAdmitted?(): boolean;
  request(path: string, method?: string, body?: unknown): Promise<any>;
  security?: { commit<T>(operationId: string, operation: unknown, apply: () => T): Promise<T> };
  reconcileStop(sessionId: string): Promise<boolean>;
}
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const terminalOperations = new Set<string>([RemoteDeletion.Completed, RemoteDeletion.Cancelled]);
const Settled = 'settled';
const Received = 'received';

/** A separate bounded control lane. Content/file uploads never gate execution or factual receipts. */
export class RemoteSessionDeletionClient {
  private busy = false;
  private nextPoll = 0;
  private cursor = '';
  constructor(private readonly deps: SessionDeletionDependencies) {}
  wake(): void { this.nextPoll = 0; }
  retryDelay(): number { return Math.max(1000, this.nextPoll - Date.now()); }
  private key(entry: DeletionInbox): string { return `${RemoteDeletion.Inbox}${entry.operation.operationId}:${entry.operation.deletionVersion}:${entry.claim.claimId}`; }
  private save(entry: DeletionInbox): void {
    this.deps.store.transaction(() => {
      const key = this.key(entry), pending = `${RemoteDeletion.Pending}${key}`;
      this.deps.store.put(key, entry);
      if (terminalOperations.has(entry.phase)) this.deps.store.remove(pending);
      else this.deps.store.put(pending, { key });
    });
  }
  private notIssued(entry: DeletionInbox, response: any): boolean {
    const proof = response?.recoveryProof;
    if (!proof) return false;
    if (response.executionAllowed !== false || proof.permitIssued !== false || proof.claimId !== entry.claim.claimId
      || proof.localFenceId !== entry.localFenceId || proof.deletionVersion !== entry.operation.deletionVersion) throw new Error('Invalid deletion recovery proof');
    // This response also closes the server claim, fencing the delayed original HTTP request.
    entry.permitRequestPending = false; entry.phase = Settled; this.releaseFence(entry); this.save(entry); return true;
  }
  private matching(entry: DeletionInbox, context: Context | null): context is Context {
    return !!context && sameOwner(entry.target, context.owner) && entry.target.deviceId === context.deviceId
      && matchesRemoteDeletionTargetScope(this.deps.store, entry.target, context.environment);
  }
  private identity(entry: DeletionInbox): boolean {
    const store = this.deps.store, target = entry.target, row = store.sync(target.localSessionId);
    return this.matching(entry, this.deps.context()) && sameOwner(target, store.owner(target.localSessionId)) && !!row
      && row.device_id === target.deviceId && row.session_id === target.sessionId && row.stream_epoch === target.streamEpoch
      && row.sync_environment !== null && matchesRemoteDeletionTargetScope(store, target, row.sync_environment)
      && !row.migration_frozen && !store.needsSecurityRecovery();
  }
  private controlsAdmitted(): boolean {
    try { return this.deps.store.areControlsAdmitted() && this.deps.controlsAdmitted?.() !== false; } catch { return false; }
  }
  private executionAdmitted(entry: DeletionInbox): boolean {
    return this.controlsAdmitted() && this.deps.store.isTaskAdmitted(entry.target.localSessionId);
  }
  private guardMatches(entry: DeletionInbox): boolean {
    return payloadHash(this.deps.store.deletionGuard(entry.target.localSessionId)) === payloadHash(entry.operation.approvedGuard);
  }
  private localExists(id: string): boolean { return !!this.deps.store.db.prepare('SELECT 1 FROM cowork_sessions WHERE id=?').get(id); }
  private fence(entry: DeletionInbox, phase: string): void {
    entry.phase = phase;
    this.deps.store.put(`${RemoteDeletion.Fence}${entry.target.localSessionId}`, {
      operationId: entry.operation.operationId, deletionVersion: entry.operation.deletionVersion, localFenceId: entry.localFenceId, phase,
    });
    this.save(entry);
  }
  private releaseFence(entry: DeletionInbox): void {
    const key = `${RemoteDeletion.Fence}${entry.target.localSessionId}`;
    if (this.deps.store.get<{ localFenceId: string }>(key)?.localFenceId === entry.localFenceId) this.deps.store.remove(key);
  }
  async poll(supported: boolean, available: boolean): Promise<void> {
    if (this.busy || !supported || Date.now() < this.nextPoll) return;
    const context = this.deps.context(); if (!context) return;
    this.busy = true; this.nextPoll = Date.now() + 30000;
    try {
      // Page durable work so terminal history never starves an unresolved operation.
      const entries = this.deps.store.entries<{ key: string }>(RemoteDeletion.Pending, this.cursor, 20);
      for (const { key, value: reference } of entries) {
        this.cursor = key;
        const value = this.deps.store.get<DeletionInbox>(reference.key);
        if (!value) continue;
        if (!this.matching(value, context) || terminalOperations.has(value.phase)) continue;
        this.nextPoll = Math.min(this.nextPoll, Date.now() + 5000);
        await this.recover(value, available);
      }
      if (entries.length < 20) this.cursor = '';
      const current = this.deps.context();
      if (!available || !this.controlsAdmitted() || !current?.enabled || !current.generation || !sameOwner(context.owner, current.owner)
        || !samePersistedRemoteEnvironment(this.deps.store, current, context.environment, current.environment)) return;
      const response = await this.deps.request(`/devices/${encodeURIComponent(context.deviceId)}/session-deletions/claim`, 'POST', { connectionGeneration: current.generation, limit: 1 });
      for (const item of (response.items || []).slice(0, 1) as DeletionClaim[]) {
        if (!item.operation || !item.target || !item.claim || !this.matching({ ...item } as DeletionInbox, current)) continue;
        const entry: DeletionInbox = { ...item, phase: Received, localFenceId: randomUUID(), requestHash: payloadHash(item.target) };
        const existing = this.deps.store.get<DeletionInbox>(this.key(entry));
        if (existing && existing.claim.claimId === entry.claim.claimId && existing.phase !== Settled) {
          if (existing.claim.claimToken !== entry.claim.claimToken && !existing.permit && [Received, RemoteDeletion.Prepared].includes(existing.phase)) {
            // The server rotates only an expired claim with no issued permit. Keep the local fence identity.
            existing.claim = entry.claim; existing.operation = entry.operation;
            delete existing.permitRequest; delete existing.permitRequestPending; this.save(existing);
          }
          await this.recover(existing, available); continue;
        }
        if (existing && ![Settled, RemoteDeletion.Cancelled].includes(existing.phase)) continue;
        const resume = item.operation.resume;
        if (resume) {
          const previous = this.deps.store.entries<DeletionInbox>(`${RemoteDeletion.Inbox}${item.operation.operationId}:`, '', 200)
            .map(row => row.value).find(value => value.permit?.permitId === resume.previousPermitId && value.settlementReportId === resume.settlementReportId
              && value.localFenceId === resume.localFenceId && value.stopStatus && terminal.has(value.stopStatus)
              && payloadHash(value.target) === payloadHash(item.target) && payloadHash(value.operation.approvedGuard) === payloadHash(item.operation.approvedGuard));
          if (!previous) { this.save(entry); await this.sendReport(entry, { kind: 'blocked', reason: 'LOCAL_RECOVERY_REQUIRED' }); continue; }
          entry.localFenceId = previous.localFenceId; entry.permit = previous.permit; entry.settlementReportId = previous.settlementReportId;
          entry.stopStatus = previous.stopStatus; entry.journalRevision = previous.journalRevision; entry.phase = RemoteDeletion.Stopped;
        }
        this.save(entry);
        await this.execute(entry, !!resume);
        this.nextPoll = Math.min(this.nextPoll, Date.now() + 5000);
      }
    } catch {
      // Credentials/results remain in the private SQLite inbox; never log tokens or task bodies.
      this.nextPoll = Date.now() + 5000;
    } finally { this.busy = false; }
  }
  private async sendReport(entry: DeletionInbox, result?: Record<string, unknown>): Promise<void> {
    if (result) { entry.report = { reportId: randomUUID(), result }; this.save(entry); }
    if (!entry.report || !this.matching(entry, this.deps.context())) return;
    const response = await this.deps.request(`/session-deletions/${encodeURIComponent(entry.operation.operationId)}/reports`, 'POST', {
      ...entry.report, claimId: entry.claim.claimId, claimToken: entry.claim.claimToken,
      deletionVersion: entry.operation.deletionVersion, expectedStateVersion: entry.operation.stateVersion, mode: 'recovery',
    });
    const operation = (response.operation || response) as DeletionOperation & { completionReceipt?: DeletionCompletion };
    if (operation.operationId !== entry.operation.operationId) throw new Error('Deletion report identity changed');
    entry.operation = operation;
    const resultKind = entry.report.result.kind;
    if (operation.state === RemoteDeletion.Completed) {
      const completion = operation.completionReceipt || response.completionReceipt;
      if (!completion || !entry.receipt || !acknowledgeRemoteDeletionCompletion(this.deps.store, entry, completion)) throw new Error('Deletion completion receipt mismatch');
      entry.completionReceipt = completion; entry.phase = RemoteDeletion.Completed; this.releaseFence(entry);
    } else if (resultKind === 'stopped_before_delete') {
      entry.settlementReportId = entry.report.reportId;
      entry.phase = RemoteDeletion.Stopped; this.releaseFence(entry);
    } else if (resultKind === 'not_started' || resultKind === 'needs_confirmation' || resultKind === 'blocked') {
      entry.phase = Settled; this.releaseFence(entry);
    }
    delete entry.report; this.save(entry);
  }
  private async recover(entry: DeletionInbox, available: boolean): Promise<void> {
    const remote = await this.deps.request(`/session-deletions/${encodeURIComponent(entry.operation.operationId)}`) as DeletionOperation & { completionReceipt?: DeletionCompletion };
    if (remote.operationId !== entry.operation.operationId) throw new Error('Deletion recovery identity changed');
    if (remote.state === RemoteDeletion.Completed && remote.completionReceipt) {
      const proof = remote.completionReceipt;
      if (entry.phase === Settled && BigInt(remote.deletionVersion) > BigInt(entry.operation.deletionVersion)) {
        // A newer explicit confirmation completed this operation. Preserve old evidence; it is not a GC receipt for this claim.
        entry.phase = RemoteDeletion.Completed; this.releaseFence(entry); this.save(entry); return;
      }
      if (entry.receipt) {
        if (!acknowledgeRemoteDeletionCompletion(this.deps.store, entry, proof)) throw new Error('Deletion recovery proof mismatch');
      } else if (!this.identity(entry) || this.localExists(entry.target.localSessionId)
        || !this.deps.store.get<{ ackAt?: number }>(`localGcDeleted:${entry.target.localSessionId}`)?.ackAt
        || !['desktop_source_delete', 'desktop_snapshot_delete'].includes(proof.proofKind)
        || !sameOwner(proof.owner, entry.target) || proof.deviceId !== entry.target.deviceId || proof.localSessionId !== entry.target.localSessionId
        || proof.sessionId !== entry.target.sessionId || proof.streamEpoch !== entry.target.streamEpoch || proof.serviceScope !== entry.target.serviceScope) return;
      entry.completionReceipt = proof; entry.phase = RemoteDeletion.Completed; this.releaseFence(entry); this.save(entry); return;
    }
    if (remote.state === RemoteDeletion.Cancelled && !entry.permit && !entry.receipt) {
      entry.phase = RemoteDeletion.Cancelled; this.releaseFence(entry); this.save(entry); return;
    }
    if (entry.phase === Settled) return;
    if (entry.permitRequestPending && entry.permitRequest) {
      // Replay the exact persisted request: changed generations/versions must not mint another permit.
      const recovered = await this.deps.request(`/session-deletions/${encodeURIComponent(entry.operation.operationId)}/permit`, 'POST', entry.permitRequest);
      if (this.notIssued(entry, recovered)) return;
      entry.permit = recovered as DeletionPermit;
      if (!entry.permit.permitId || !entry.permit.permitToken) throw new Error('Invalid recovered deletion permit');
      if (entry.permit.stateVersion) entry.operation.stateVersion = entry.permit.stateVersion;
      entry.permitRequestPending = false; this.save(entry);
      if (entry.permitRequest.phase === RemoteDeletion.DeleteOnly) await this.reportStopped(entry); else await this.notStarted(entry); return;
    }
    if (entry.report) { await this.sendReport(entry); if (entry.report) return; }
    if (entry.receipt) {
      if (entry.phase !== RemoteDeletion.Completed) await this.sendReport(entry, entry.receipt as unknown as Record<string, unknown>);
      return;
    }
    if (entry.phase === Received || entry.phase === RemoteDeletion.Prepared) {
      if (available && !entry.permit) await this.execute(entry);
      else if (entry.permit) await this.notStarted(entry);
      return;
    }
    if (!this.identity(entry)) return;
    if (entry.phase === RemoteDeletion.EffectStarted || entry.phase === RemoteDeletion.Reconciling) {
      await this.deps.reconcileStop(entry.target.localSessionId);
      const run = this.deps.store.run(entry.target.localSessionId);
      if (!run || !terminal.has(run.status) || run.runId !== entry.operation.approvedGuard.runId || !this.guardMatches(entry)) return;
      entry.stopStatus = run.status;
      this.deps.store.transaction(() => this.fence(entry, RemoteDeletion.Stopped));
    }
    if (entry.phase === RemoteDeletion.Stopped) {
      if (!entry.settlementReportId) await this.reportStopped(entry);
      if (available && entry.settlementReportId) await this.execute(entry, true);
    }
  }
  private evidence(entry: DeletionInbox, stopped: boolean): Record<string, unknown> {
    return { journalRevision: entry.journalRevision || '0', phase: stopped ? RemoteDeletion.Stopped : RemoteDeletion.Prepared,
      ...(stopped ? { stopStatus: entry.stopStatus } : { dispatchStarted: false }), deleteCommitted: false,
      executionSettlementDigest: payloadHash({ requestHash: entry.requestHash, localFenceId: entry.localFenceId, phase: entry.phase, journalRevision: entry.journalRevision || '0' }) };
  }
  private async notStarted(entry: DeletionInbox): Promise<void> {
    await this.sendReport(entry, { kind: 'not_started', permitId: entry.permit!.permitId, permitToken: entry.permit!.permitToken,
      localFenceId: entry.localFenceId, guard: entry.operation.approvedGuard, evidence: this.evidence(entry, false) });
  }
  private async reportStopped(entry: DeletionInbox): Promise<void> {
    await this.sendReport(entry, { kind: 'stopped_before_delete', permitId: entry.permit!.permitId, permitToken: entry.permit!.permitToken,
      localFenceId: entry.localFenceId, guard: entry.operation.approvedGuard, evidence: this.evidence(entry, true) });
  }
  private async execute(entry: DeletionInbox, deleteOnly = false): Promise<void> {
    const id = entry.target.localSessionId;
    if (!this.identity(entry)) { await this.sendReport(entry, { kind: 'blocked', reason: 'LOCAL_IDENTITY_MISSING' }); return; }
    if (!this.executionAdmitted(entry)) { await this.sendReport(entry, { kind: 'blocked', reason: 'LOCAL_RECOVERY_REQUIRED' }); return; }
    if (!this.localExists(id)) { await this.sendReport(entry, { kind: 'blocked', reason: 'LOCAL_RECOVERY_REQUIRED' }); return; }
    const release = ownershipOperationGate.tryAcquire({ agentIds: [], sessionIds: [id] });
    if (!release) return;
    let renewal: ReturnType<typeof setInterval> | undefined;
    try {
      const store = this.deps.store;
      const observedGuard = store.deletionGuard(id), run = store.run(id);
      const active = run && !terminal.has(run.status) || this.deps.runtime.isSessionActive?.(id) === true;
      if (entry.claim.observationOnly || !this.guardMatches(entry) || active && entry.operation.action !== RemoteDeletion.StopAndDelete) {
        await this.sendReport(entry, { kind: 'needs_confirmation', ...(entry.claim.observationOnly ? { reason: 'AUTHORIZATION_CHANGED' } : {}), observedGuard, requiredAction: active ? RemoteDeletion.StopAndDelete : RemoteDeletion.Delete }); return;
      }
      if (store.get(`inputFence:${id}`) || store.projectionPublishing(id) || store.get(`import:${id}`)) {
        await this.sendReport(entry, { kind: 'blocked', reason: 'LOCAL_RECOVERY_REQUIRED' }); return;
      }
      const context = this.deps.context();
      if (!context?.enabled || !context.generation) return;
      const generation = context.generation;
      const phase = deleteOnly ? RemoteDeletion.DeleteOnly : RemoteDeletion.Execute;
      const prepare = (): void => {
        entry.journalRevision = String(BigInt(entry.journalRevision || '0') + 1n);
        this.fence(entry, deleteOnly ? RemoteDeletion.Stopped : RemoteDeletion.Prepared);
      };
      if (this.deps.security) await this.deps.security.commit(entry.operation.operationId, { target: entry.target, localFenceId: entry.localFenceId, phase: RemoteDeletion.Prepared }, prepare);
      else store.transaction(prepare);
      if (!this.executionAdmitted(entry)) return;
      const started = performance.now();
      const permitRequest = {
        claimId: entry.claim.claimId, claimToken: entry.claim.claimToken, connectionGeneration: generation,
        deletionVersion: entry.operation.deletionVersion, expectedStateVersion: entry.operation.stateVersion,
        localFenceId: entry.localFenceId, phase, observedGuard,
        ...(deleteOnly ? { previousPermitId: entry.permit!.permitId, settlementReportId: entry.settlementReportId } : {}),
      };
      entry.permitRequest = permitRequest; entry.permitRequestPending = true; this.save(entry);
      const permit = await this.deps.request(`/session-deletions/${encodeURIComponent(entry.operation.operationId)}/permit`, 'POST', permitRequest) as DeletionPermit;
      if (this.notIssued(entry, permit)) return;
      if (!permit.permitId || !permit.permitToken || !Number.isFinite(Date.parse(permit.permitUntil)) || !Number.isFinite(Date.parse(permit.serverTime))) throw new Error('Invalid deletion permit');
      entry.permit = permit; entry.permitRequestPending = false; delete entry.settlementReportId;
      if (permit.stateVersion) entry.operation.stateVersion = permit.stateVersion;
      this.save(entry);
      // Conservatively subtract the complete request duration; wall-clock changes cannot extend a permit.
      let serverTime = Date.parse(permit.serverTime), serverObservedAt = performance.now();
      let deadline = started + Math.min(30000, Math.max(0, Date.parse(permit.permitUntil) - serverTime));
      const permitted = (): boolean => permit.executionAllowed === true && (!permit.connectionGeneration || permit.connectionGeneration === generation) && this.identity(entry) && this.guardMatches(entry)
        && this.executionAdmitted(entry)
        && this.deps.context()?.enabled === true && this.deps.context()?.generation === generation && performance.now() + 1000 < deadline;
      if (!permitted()) { if (deleteOnly) await this.reportStopped(entry); else await this.notStarted(entry); return; }
      const recordEffect = (): void => {
        entry.journalRevision = String(BigInt(entry.journalRevision || '0') + 1n);
        this.fence(entry, deleteOnly ? RemoteDeletion.Stopped : RemoteDeletion.EffectStarted);
      };
      if (this.deps.security) await this.deps.security.commit(entry.operation.operationId, { target: entry.target, localFenceId: entry.localFenceId, permitId: permit.permitId, phase }, recordEffect);
      else store.transaction(recordEffect);
      if (!permitted()) { if (deleteOnly) await this.reportStopped(entry); else await this.notStarted(entry); return; }
      let renewing = false;
      renewal = setInterval(() => {
        if (!permitted()) { deadline = 0; return; }
        if (renewing) return; renewing = true;
        const began = performance.now();
        void this.deps.request(`/session-deletions/${encodeURIComponent(entry.operation.operationId)}/lease/renew`, 'POST', {
          claimId: entry.claim.claimId, claimToken: entry.claim.claimToken, permitId: permit.permitId, permitToken: permit.permitToken,
          deletionVersion: entry.operation.deletionVersion, connectionGeneration: generation, localPhase: RemoteDeletion.EffectStarted,
        }).then((result: DeletionPermit) => {
          if (result.permitId === permit.permitId && Number.isFinite(Date.parse(result.permitUntil)) && Number.isFinite(Date.parse(result.serverTime))) {
            serverTime = Date.parse(result.serverTime); serverObservedAt = performance.now();
            deadline = began + Math.min(30000, Math.max(0, Date.parse(result.permitUntil) - serverTime));
          }
        }).catch(() => { deadline = 0; }).finally(() => { renewing = false; });
      }, 10000);
      renewal.unref?.();
      if (active && !deleteOnly) {
        const confirmed = await this.deps.runtime.cancelSessionConfirmed?.(id);
        if (!confirmed) {
          this.deps.store.transaction(() => this.fence(entry, RemoteDeletion.Reconciling));
          await this.sendReport(entry, { kind: 'stop_unknown', permitId: permit.permitId, permitToken: permit.permitToken, localFenceId: entry.localFenceId, guard: observedGuard }); return;
        }
        if (this.identity(entry) && this.guardMatches(entry) && store.run(id)?.runId === observedGuard.runId) store.updateRun(id, 'cancelled');
      }
      entry.stopStatus = store.run(id)?.status || 'succeeded';
      this.deps.store.transaction(() => this.fence(entry, RemoteDeletion.Stopped));
      if (!permitted() || store.run(id) && !terminal.has(store.run(id)!.status) || this.deps.runtime.isSessionActive?.(id) === true) {
        await this.reportStopped(entry); return;
      }
      this.deps.service.deleteRemote(id, context.owner, () => {
        if (!permitted() || !this.localExists(id)) throw new Error('Deletion target changed before commit');
        const sync = store.sync(id)!;
        const receipt = { kind: RemoteDeletion.Deleted, permitId: permit.permitId, localReceiptId: randomUUID(), localFenceId: entry.localFenceId,
          sessionId: sync.session_id, localSessionId: id, deviceId: sync.device_id, streamEpoch: sync.stream_epoch!, guard: observedGuard,
          localDeletionRevision: String(store.projectionRevision(id) + 1), closedSourceHighWatermark: String(sync.source_seq), lastAcknowledgedSourceSeq: String(sync.ack_seq),
          deletedAt: new Date(serverTime + 1 + Math.max(0, performance.now() - serverObservedAt)).toISOString(), executionSettlementDigest: payloadHash(this.evidence(entry, true)) };
        entry.receipt = { ...receipt, permitToken: permit.permitToken, receiptDigest: payloadHash(receipt) };
        store.put(`${RemoteDeletion.Closed}${id}`, { operationId: entry.operation.operationId, deletionVersion: entry.operation.deletionVersion,
          receiptId: entry.receipt.localReceiptId, receiptDigest: entry.receipt.receiptDigest, sourceHighWatermark: sync.source_seq, ackSourceSeq: sync.ack_seq });
        this.fence(entry, RemoteDeletion.Deleted);
      });
      await this.sendReport(entry, entry.receipt as unknown as Record<string, unknown>);
    } finally { if (renewal) clearInterval(renewal); release(); }
  }
}
