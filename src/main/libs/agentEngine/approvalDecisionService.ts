import { createHash, randomUUID } from 'node:crypto';

import type { ApprovalDecisionOptions, ApprovalDecisionOutcome, ApprovalReconcileOptions, ApprovalState, DualApprovalConfiguration } from '../../../shared/cowork/approval';
import { t } from '../../i18n';
import { stableJson } from '../../remote/canonical';
import type { ApprovalDescription } from './openclawApprovalAdapters';
import { APPROVAL_ADAPTER_VERSION } from './openclawApprovalAdapters';
import type { ApprovalDecision, PendingApprovalEntry } from './openclawApprovalBridge';
import type { PermissionRequest } from './types';

export interface ApprovalPersistence {
  get<T>(key: string): T | null;
  put(key: string, value: unknown): void;
  entries<T>(prefix: string): Array<{ key: string; value: T }>;
  transaction<T>(operation: () => T): T;
}
export interface ApprovalBinding { runId: string | null; identity: unknown }
export interface ApprovalGateway {
  request: <T = Record<string, unknown>>(method: string, params?: unknown, options?: { timeoutMs?: number | null }) => Promise<T>;
}
export interface ApprovalGatewayContract { version: string; bootId: string; methods: string[] }
export interface ApprovalRegistration {
  pending: PendingApprovalEntry;
  rawRequest: Record<string, unknown>;
  permission: PermissionRequest;
  createdAtMs: number | null;
  expiresAtMs: number | null;
  description: ApprovalDescription;
}
interface Submission {
  id: string; source: ApprovalDecisionOptions['source']; decision: ApprovalDecision; contentHash: string;
  baseVersion: string; reservationVersion: string; phase: 'reserved' | 'dispatching' | 'unknown' | 'confirmed';
  dispatchedAt: string | null; applied: boolean | null;
}
interface RecordEntry extends ApprovalRegistration {
  formatVersion: 1;
  binding: ApprovalBinding;
  bindingHash: string;
  bootId: string | null;
  state: ApprovalState;
  submission: Submission | null;
  continuation: 'not_needed' | 'prepared' | 'dispatching' | 'confirmed' | 'unknown';
  conflict?: boolean;
  needsValidation?: boolean;
  continuationCancelled?: boolean;
}
interface SubmissionIndex { requestId: string; contentHash: string; outcome?: ApprovalDecisionOutcome }
interface Options {
  persistence: ApprovalPersistence;
  getGateway: () => ApprovalGateway | null;
  getBinding: (sessionId: string) => ApprovalBinding | null;
  emitState: (sessionId: string, state: ApprovalState) => void;
  emitResolved: (sessionId: string, requestId: string) => void;
  emitRequest: (sessionId: string, request: PermissionRequest) => void;
  emitError: (sessionId: string, message: string) => void;
  continueSession: (sessionId: string, decision: 'approve' | 'deny', beforeDispatch: () => void) => Promise<void>;
  canContinue?: (sessionId: string) => boolean;
  isSessionActive: (sessionId: string) => boolean;
  isPolicyCurrent?: (registration: ApprovalRegistration) => boolean;
}
const prefix = 'approvalResolution:';
const digest = (value: unknown): string => createHash('sha256').update(stableJson(value)).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const nowIso = (): string => new Date().toISOString();
const publicDecision = (decision: ApprovalDecision): 'approve' | 'deny' => decision === 'deny' ? 'deny' : 'approve';
const invalidated = new Set<ApprovalState['status']>(['expired', 'cancelled', 'superseded']);
const outcome = (kind: ApprovalDecisionOutcome['kind'], record?: RecordEntry, reason?: string): ApprovalDecisionOutcome => ({
  kind, ...(record ? { state: clone(record.state) } : {}), ...(reason ? { reason } : {}),
  ...(record?.state.resolution.confirmedDecision ? { decision: record.state.resolution.confirmedDecision } : {}),
});

/** One durable arbiter for desktop, notification and mobile approval entrances. */
export class ApprovalDecisionService {
  private contract: ApprovalGatewayContract | null = null;
  private configuration: DualApprovalConfiguration = { enabled: false, projectionSupported: false };
  private readonly inFlight = new Map<string, Promise<ApprovalDecisionOutcome>>();
  private readonly recovery = new Set<string>();
  private readonly recovered = new Set<string>();
  private readonly reservedChecks = new Set<string>();
  private recoveryActive = 0;
  private readonly continuationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unsupported: boolean;

  constructor(private readonly options: Options) {
    const records = options.persistence.entries<RecordEntry>(prefix);
    this.unsupported = records.some(({ value }) => value.formatVersion !== 1);
    if (this.unsupported) return;
    options.persistence.transaction(() => {
      for (const { value: record } of records) {
        if (record.state.status === 'pending' && record.state.resolution.phase === 'idle') {
          record.needsValidation = true;
          record.state.resolution.phase = 'unknown'; record.state.remoteAllowed = false;
          this.save(record, true);
        }
        if (record.continuation === 'dispatching') record.continuation = 'unknown';
        if (record.submission?.phase === 'dispatching') {
          record.submission.phase = 'unknown';
          if (record.state.status === 'pending') record.state.resolution.phase = 'unknown';
          this.save(record, true);
        } else this.save(record, false);
      }
    });
  }

  supportsDualApproval(): boolean {
    const c = this.contract;
    return !this.unsupported && Boolean(c && c.version.replace(/^v/u, '') === '2026.8.1' && c.bootId
      && ['approval.get', 'approval.resolve', 'exec.approval.list', 'plugin.approval.list'].every(m => c.methods.includes(m)));
  }

  setGatewayContract(contract: ApprovalGatewayContract | null): void {
    this.contract = contract;
    this.recovered.clear(); this.reservedChecks.clear();
    this.configure(this.configuration, true);
    if (!this.supportsDualApproval()) return;
    // Bounded recovery: no polling and at most four queries concurrently.
    const pending = this.records().filter(r => r.state.status === 'pending' || r.submission?.phase === 'unknown' || r.continuation === 'prepared');
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const record = pending[next++];
        await this.recoverRecord(record);
        const current = this.read(record.pending.requestId);
        if (current?.state.status === 'pending') this.options.emitRequest(current.pending.sessionId, { ...current.permission, approval: clone(current.state) });
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker)).catch((): void => undefined);
  }

  configure(configuration: DualApprovalConfiguration, force = false): void {
    const changed = configuration.enabled !== this.configuration.enabled || configuration.projectionSupported !== this.configuration.projectionSupported;
    this.configuration = configuration;
    if (!changed && !force) return;
    this.options.persistence.transaction(() => {
      for (const record of this.records()) {
        if (record.state.status !== 'pending' || record.state.resolution.phase !== 'idle') continue;
        const allowed = this.canOfferRemote(record);
        if (changed || allowed !== record.state.remoteAllowed) {
          record.state.remoteAllowed = allowed;
          this.save(record, true);
        }
      }
    });
  }

  register(registration: ApprovalRegistration): ApprovalState | null {
    if (this.unsupported) { this.options.emitError(registration.pending.sessionId, t('approvalRequiresUpgrade')); return null; }
    const binding = this.options.getBinding(registration.pending.sessionId);
    if (!binding) return null;
    const old = this.read(registration.pending.requestId);
    const operationDigest = digest({ binding, kind: registration.pending.kind, requestId: registration.pending.requestId,
      raw: registration.rawRequest, createdAt: registration.createdAtMs, expiresAt: registration.expiresAtMs,
      adapter: APPROVAL_ADAPTER_VERSION, description: registration.description });
    if (old) {
      // Gateway IDs are immutable; a conflicting reused ID never receives an old decision.
      if (old.state.operationDigest !== operationDigest) this.close(old, 'superseded');
      return clone(this.read(registration.pending.requestId)!.state);
    }
    const legacy = this.options.persistence.get<{ status?: string; approvalVersion?: string }>(`approval:${registration.pending.sessionId}:${registration.pending.requestId}`);
    if (legacy?.status && legacy.status !== 'pending') return null;
    const initialVersion = legacy?.approvalVersion && /^[0-9]+$/u.test(legacy.approvalVersion) ? String(BigInt(legacy.approvalVersion) + 1n) : '1';
    const record: RecordEntry = { ...clone(registration), formatVersion: 1, binding, bindingHash: digest(binding), bootId: this.contract?.bootId ?? null,
      submission: null, continuation: 'not_needed', state: {
        requestId: registration.pending.requestId, sessionId: registration.pending.sessionId, runId: binding.runId,
        approvalVersion: initialVersion, operationDigest, title: registration.description.title, summary: registration.description.summary,
        expiresAt: registration.expiresAtMs !== null ? new Date(registration.expiresAtMs).toISOString() : null,
        remoteAllowed: false, requiresLocalAction: !registration.description.remoteSafe,
        status: 'pending', resolvedAt: null, resolution: { phase: 'idle', source: null, confirmedDecision: null, confirmedAt: null },
      } };
    record.state.remoteAllowed = this.canOfferRemote(record);
    this.options.persistence.transaction(() => this.save(record, false));
    return clone(record.state);
  }

  getState(requestId: string): ApprovalState | null { const r = this.read(requestId); return r ? clone(r.state) : null; }
  getPending(requestId: string): PendingApprovalEntry | null { return this.read(requestId)?.pending ?? null; }
  listPending(): Array<{ sessionId: string; request: PermissionRequest }> {
    return this.records().filter(r => r.state.status === 'pending').map(r => ({ sessionId: r.pending.sessionId, request: { ...r.permission, approval: clone(r.state) } }));
  }
  getSubmission(submissionId: string): ApprovalDecisionOutcome | null {
    const index = this.options.persistence.get<SubmissionIndex>(`approvalSubmission:${submissionId}`);
    if (!index) return null;
    if (index.outcome) return clone(index.outcome);
    const record = this.read(index.requestId);
    if (!record || record.submission?.id !== submissionId) return { kind: 'unknown', reason: 'RESULT_UNKNOWN' };
    if (record.submission.applied === true) return outcome('confirmed', record);
    if (record.submission.applied === false) return outcome('known_not_applied', record, 'APPROVAL_STALE');
    return outcome('unknown', record, 'RESULT_UNKNOWN');
  }

  submit(requestId: string, decision: ApprovalDecision, options?: ApprovalDecisionOptions): Promise<ApprovalDecisionOutcome> {
    const opts = options ?? { submissionId: randomUUID(), source: 'desktop' as const };
    const hash = digest({ requestId, decision, source: opts.source, expectedVersion: opts.expectedVersion ?? null, operationDigest: opts.operationDigest ?? null });
    const index = this.options.persistence.get<SubmissionIndex>(`approvalSubmission:${opts.submissionId}`);
    if (index) {
      if (index.contentHash !== hash) return Promise.resolve({ kind: 'known_not_applied', reason: 'IDEMPOTENCY_CONFLICT' });
      if (index.outcome) return Promise.resolve(clone(index.outcome));
      return this.inFlight.get(opts.submissionId) ?? Promise.resolve(this.getSubmission(opts.submissionId)!);
    }
    let record = this.read(requestId);
    if (!record || this.unsupported) return Promise.resolve({ kind: 'known_not_applied', reason: 'APPROVAL_STALE' });
    const failure = this.checkNewSubmission(record, opts);
    if (failure) return Promise.resolve(outcome('known_not_applied', record, failure));
    this.options.persistence.transaction(() => {
      record = this.read(requestId)!;
      const baseVersion = record.state.approvalVersion;
      record.submission = { id: opts.submissionId, source: opts.source, decision, contentHash: hash,
        baseVersion, reservationVersion: String(BigInt(baseVersion) + 1n), phase: 'reserved', dispatchedAt: null, applied: null };
      record.state.resolution = { phase: 'submitting', source: opts.source, confirmedDecision: null, confirmedAt: null };
      record.state.remoteAllowed = false;
      this.options.persistence.put(`approvalSubmission:${opts.submissionId}`, { requestId, contentHash: hash });
      this.save(record, true);
    });
    const task = this.dispatch(record!, opts).finally(() => this.inFlight.delete(opts.submissionId));
    this.inFlight.set(opts.submissionId, task);
    return task;
  }

  private checkNewSubmission(record: RecordEntry, opts: ApprovalDecisionOptions): string | null {
    if (record.needsValidation || record.state.status !== 'pending' || record.state.resolution.phase !== 'idle' || record.submission) return 'APPROVAL_STALE';
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== record.state.approvalVersion) return 'APPROVAL_STALE';
    if (opts.operationDigest !== undefined && opts.operationDigest !== record.state.operationDigest) return 'APPROVAL_STALE';
    if (record.expiresAtMs !== null && record.expiresAtMs <= Date.now()) { this.close(record, 'expired'); return 'APPROVAL_EXPIRED'; }
    if (!this.bindingValid(record)) return 'APPROVAL_STALE';
    if (opts.source === 'mobile' && (!record.state.remoteAllowed || !opts.beforeDispatch || !opts.expectedVersion || !opts.operationDigest)) return 'REMOTE_APPROVAL_UNAVAILABLE';
    if (!this.options.getGateway()) return 'GATEWAY_UNAVAILABLE';
    return null;
  }

  private async dispatch(initial: RecordEntry, options: ApprovalDecisionOptions): Promise<ApprovalDecisionOutcome> {
    const id = initial.pending.requestId;
    let sent = false;
    try {
      await options.beforeDispatch?.();
      let record = this.read(id)!;
      const sub = record.submission;
      if (!sub || sub.id !== options.submissionId || sub.phase !== 'reserved'
        || record.state.approvalVersion !== sub.reservationVersion || !this.bindingValid(record)
        || (record.expiresAtMs !== null && record.expiresAtMs <= Date.now())) return this.notSent(record, options.submissionId, 'APPROVAL_STALE');
      const client = this.options.getGateway();
      if (!client) return this.notSent(record, options.submissionId, 'GATEWAY_UNAVAILABLE');
      if (options.source === 'mobile' && (!this.supportsDualApproval() || record.bootId !== this.contract?.bootId || this.options.isPolicyCurrent?.(record) === false)) return this.notSent(record, options.submissionId, 'GATEWAY_CHANGED');
      options.onDispatch?.();
      this.options.persistence.transaction(() => {
        record = this.read(id)!;
        record.submission!.phase = 'dispatching'; record.submission!.dispatchedAt = nowIso();
        this.save(record, false);
      });
      sent = true;
      if (this.supportsDualApproval()) {
        const result = await client.request<{ applied: boolean; approval: unknown }>('approval.resolve', { id, kind: record.pending.kind, decision: sub.decision }, { timeoutMs: 5000 });
        const snapshot = this.parseSnapshot(record, result.approval);
        if (typeof result.applied !== 'boolean' || !snapshot || snapshot.status === 'pending') throw new Error('Unverified approval response');
        this.options.persistence.transaction(() => {
          record = this.read(id)!;
          if (record.submission?.id === options.submissionId) record.submission.applied = result.applied && snapshot.decision === publicDecision(record.submission.decision);
          this.mergeSnapshot(record, snapshot, record.submission?.applied ? options.source : 'unknown');
          this.saveInbox(record);
        });
      } else {
        // Older gateways remain local-only. A plain idempotent ACK proves the decision,
        // but cannot attribute it to this submission rather than another gateway client.
        const result = await client.request<{ ok: boolean }>(`${record.pending.kind}.approval.resolve`, { id, decision: sub.decision }, { timeoutMs: 5000 });
        if (result?.ok !== true) throw new Error('Unverified approval ACK');
        this.confirm(this.read(id)!, publicDecision(sub.decision), nowIso(), 'unknown');
      }
    } catch (error) {
      const record = this.read(id)!;
      if (!sent) return this.notSent(record, options.submissionId, 'BEFORE_DISPATCH_REJECTED');
      this.options.persistence.transaction(() => {
        if (record.submission?.id === options.submissionId && record.submission.applied === null) {
          record.submission.phase = 'unknown';
          if (record.state.status === 'pending') record.state.resolution.phase = 'unknown';
          this.save(record, true); this.saveInbox(record);
        }
      });
      // permissionState carries the uncertainty. A runtime error event would incorrectly fail the running task.
      console.warn('[ApprovalDecisionService] decision requires reconciliation', id, error instanceof Error ? error.message : String(error));
    }
    return this.getSubmission(options.submissionId) ?? outcome('unknown', this.read(id)!);
  }

  private notSent(record: RecordEntry, submissionId: string, reason: string): ApprovalDecisionOutcome {
    let result: ApprovalDecisionOutcome;
    this.options.persistence.transaction(() => {
      const index = this.options.persistence.get<SubmissionIndex>(`approvalSubmission:${submissionId}`);
      if (record.submission?.id === submissionId && record.submission.phase === 'reserved') {
        record.submission.applied = false;
        this.saveInbox(record);
        record.submission = null;
        if (record.state.status === 'pending') {
          if (record.expiresAtMs !== null && record.expiresAtMs <= Date.now()) this.close(record, 'expired');
          else {
            record.state.resolution = { phase: 'idle', source: null, confirmedDecision: null, confirmedAt: null };
            record.state.remoteAllowed = this.canOfferRemote(record);
            this.save(record, true);
          }
        } else this.save(record, false);
      }
      result = outcome('known_not_applied', record, reason);
      if (index) this.options.persistence.put(`approvalSubmission:${submissionId}`, { ...index, outcome: result });
    });
    return result!;
  }

  mergeResolved(requestId: string, decision: ApprovalDecision | null, ts: number | null, rawRequest: Record<string, unknown> | null): void {
    const record = this.read(requestId);
    if (!record || !decision || !rawRequest || digest(rawRequest) !== digest(record.rawRequest)
      || record.bootId !== this.contract?.bootId || ts === null || (record.createdAtMs !== null && ts < record.createdAtMs)) return;
    this.confirm(record, publicDecision(decision), new Date(ts).toISOString(), 'unknown');
  }

  async reconcileSubmission(submissionId: string, options: ApprovalReconcileOptions = {}): Promise<ApprovalDecisionOutcome | null> {
    const existing = this.getSubmission(submissionId);
    if (!existing || existing.kind !== 'unknown') return existing;
    const index = this.options.persistence.get<SubmissionIndex>(`approvalSubmission:${submissionId}`)!;
    const record = this.read(index.requestId);
    if (!record) return existing;
    if (record.submission?.phase === 'reserved' && options.canProveNeverDispatched && !this.reservedChecks.has(submissionId)) {
      this.reservedChecks.add(submissionId);
      if (await this.verifyPending(record)) {
      return this.notSent(this.read(record.pending.requestId)!, submissionId, 'NEVER_DISPATCHED');
      }
    }
    await this.recoverRecord(record);
    return this.getSubmission(submissionId);
  }

  private async verifyPending(record: RecordEntry): Promise<boolean> {
    if (!this.supportsDualApproval() || record.bootId !== this.contract?.bootId || (record.expiresAtMs ?? 0) <= Date.now()) return false;
    try {
      const result = await this.queryRecovery<unknown>(record, `${record.pending.kind}.approval.list`, {});
      return Array.isArray(result) && result.some(item => item && item.id === record.pending.requestId
        && item.createdAtMs === record.createdAtMs && item.expiresAtMs === record.expiresAtMs && digest(item.request) === digest(record.rawRequest));
    } catch { return false; }
  }

  private async recoverRecord(record: RecordEntry): Promise<void> {
    if (!this.supportsDualApproval() || record.bootId !== this.contract?.bootId || this.recovery.has(record.pending.requestId) || this.recovered.has(record.pending.requestId)) return;
    this.recovery.add(record.pending.requestId); this.recovered.add(record.pending.requestId);
    try {
      const result = await this.queryRecovery<{ approval: unknown }>(record, 'approval.get', { id: record.pending.requestId });
      const snapshot = this.parseSnapshot(record, result.approval);
      if (!snapshot) return;
      const current = this.read(record.pending.requestId)!;
      if (snapshot.status !== 'pending') this.mergeSnapshot(current, snapshot, 'unknown');
      else if (current.state.status === 'pending' && (current.state.resolution.phase === 'idle' || (current.needsValidation && !current.submission)) && await this.verifyPending(current)) {
        current.bootId = this.contract?.bootId ?? null;
        current.needsValidation = false; current.state.resolution.phase = 'idle';
        current.state.remoteAllowed = this.canOfferRemote(current);
        this.options.persistence.transaction(() => this.save(current, true));
      }
    } catch { /* Missing/expired request, timeout and unavailable query never prove non-execution. */ }
    finally { this.recovery.delete(record.pending.requestId); }
  }

  private async queryRecovery<T>(record: RecordEntry, method: string, params: unknown): Promise<T> {
    if (this.recoveryActive >= 4) throw new Error('Approval recovery busy');
    this.recoveryActive++;
    try {
      const remaining = (record.expiresAtMs ?? Date.now()) - Date.now();
      return await this.options.getGateway()!.request<T>(method, params, { timeoutMs: remaining > 0 ? Math.max(1, Math.min(5000, remaining)) : 5000 });
    } finally { this.recoveryActive--; }
  }

  private parseSnapshot(record: RecordEntry, value: unknown): { status: string; decision: 'approve' | 'deny' | null; confirmedAt: string } | null {
    if (!value || typeof value !== 'object') return null;
    const s = value as Record<string, any>;
    if (s.id !== record.pending.requestId || s.createdAtMs !== record.createdAtMs || s.expiresAtMs !== record.expiresAtMs
      || s.presentation?.kind !== record.pending.kind
      || (s.source?.sessionKey && s.source.sessionKey !== record.rawRequest.sessionKey)) return null;
    if (s.status === 'pending') return { status: 'pending', decision: null, confirmedAt: nowIso() };
    if (!Number.isSafeInteger(s.resolvedAtMs) || s.resolvedAtMs < (record.createdAtMs ?? 0) || !['allowed', 'denied', 'expired', 'cancelled'].includes(s.status)) return null;
    const decision = s.decision === 'deny' ? 'deny' : ['allow-once', 'allow-always'].includes(s.decision) ? 'approve' : null;
    if ((s.status === 'allowed' && decision !== 'approve') || (s.status === 'denied' && decision !== 'deny')) return null;
    return { status: s.status, decision, confirmedAt: new Date(s.resolvedAtMs).toISOString() };
  }

  private mergeSnapshot(record: RecordEntry, snapshot: { status: string; decision: 'approve' | 'deny' | null; confirmedAt: string }, source: ApprovalState['resolution']['source']): void {
    if (snapshot.decision) this.confirm(record, snapshot.decision, snapshot.confirmedAt, source);
    else if (snapshot.status === 'expired' || snapshot.status === 'cancelled') this.close(record, snapshot.status);
  }

  private confirm(record: RecordEntry, decision: 'approve' | 'deny', confirmedAt: string, source: ApprovalState['resolution']['source']): void {
    this.options.persistence.transaction(() => {
      const previous = record.state.resolution.confirmedDecision;
      if (previous && previous !== decision) {
        record.conflict = true;
        if (record.submission) record.submission.applied = null;
        this.save(record, false); this.saveInbox(record); return;
      }
      const closed = invalidated.has(record.state.status);
      const changed = !previous || (record.state.resolution.source === 'unknown' && source !== 'unknown');
      if (!closed) record.state.status = decision === 'approve' ? 'approved' : 'denied';
      record.state.resolvedAt ??= confirmedAt;
      record.state.remoteAllowed = false;
      record.state.resolution = { phase: 'finished', source: previous && source === 'unknown' ? record.state.resolution.source : source,
        confirmedDecision: decision, confirmedAt: record.state.resolution.confirmedAt ?? confirmedAt };
      if (record.submission) record.submission.phase = 'confirmed';
      if (!closed && !record.continuationCancelled && record.pending.kind === 'exec' && !record.pending.allowAlways && record.continuation === 'not_needed') record.continuation = 'prepared';
      this.save(record, changed); this.saveInbox(record);
      if (!previous && !closed) this.options.emitResolved(record.pending.sessionId, record.pending.requestId);
    });
    if (record.continuation === 'prepared') this.scheduleContinuation(record.pending.requestId, 10);
  }

  private scheduleContinuation(requestId: string, retries: number): void {
    if (this.continuationTimers.has(requestId)) return;
    const run = () => {
      this.continuationTimers.delete(requestId);
      const record = this.read(requestId);
      if (!record || record.continuationCancelled || record.continuation !== 'prepared' || invalidated.has(record.state.status) || !this.bindingValid(record) || this.options.canContinue?.(record.pending.sessionId) === false) return;
      if (this.records().some(r => r.pending.sessionId === record.pending.sessionId && r.state.status === 'pending')) return;
      if (this.options.isSessionActive(record.pending.sessionId)) {
        if (retries > 0) this.scheduleContinuation(requestId, retries - 1);
        return;
      }
      const laneKey = `approvalContinuationLane:${record.pending.sessionId}:${record.bindingHash}`;
      const lane = this.options.persistence.get<{ phase: string }>(laneKey);
      if (lane && lane.phase !== 'confirmed') return;
      const members = this.records().filter(r => r.pending.sessionId === record.pending.sessionId
        && r.bindingHash === record.bindingHash && r.continuation === 'prepared').map(r => r.pending.requestId);
      this.options.persistence.transaction(() => {
        this.options.persistence.put(laneKey, { phase: 'dispatching', bindingHash: record.bindingHash, members, dispatchedAt: nowIso() });
        for (const id of members) { const member = this.read(id)!; member.continuation = 'dispatching'; this.save(member, false); }
      });
      const beforeDispatch = () => {
        const current = this.read(requestId);
        if (!current || current.continuationCancelled || !this.bindingValid(current) || this.options.canContinue?.(current.pending.sessionId) === false) throw new Error('Approval continuation binding changed');
      };
      void this.options.continueSession(record.pending.sessionId, record.state.resolution.confirmedDecision!, beforeDispatch).then(() => {
        this.options.persistence.transaction(() => {
          this.options.persistence.put(laneKey, { phase: 'confirmed', bindingHash: record.bindingHash, members });
          for (const id of members) { const member = this.read(id)!; member.continuation = 'confirmed'; this.save(member, false); }
        });
      }).catch(() => {
        this.options.persistence.transaction(() => {
          this.options.persistence.put(laneKey, { phase: 'unknown', bindingHash: record.bindingHash, members });
          for (const id of members) { const member = this.read(id)!; member.continuation = 'unknown'; this.save(member, false); }
        });
      });
    };
    const timer = setTimeout(run, 1000); timer.unref?.(); this.continuationTimers.set(requestId, timer);
  }

  dispose(): void { for (const timer of this.continuationTimers.values()) clearTimeout(timer); this.continuationTimers.clear(); }

  expire(now = Date.now()): void {
    for (const record of this.records()) {
      if (record.state.status === 'pending' && record.expiresAtMs !== null && record.expiresAtMs <= now && !record.submission?.dispatchedAt) this.close(record, 'expired');
    }
  }
  closeSession(sessionId: string, runId: string | null, status: 'cancelled' | 'expired' | 'superseded' = 'cancelled'): void {
    for (const record of this.records()) {
      if (record.pending.sessionId !== sessionId || (runId !== null && record.binding.runId !== runId)) continue;
      if (['prepared', 'dispatching'].includes(record.continuation)) {
        record.continuationCancelled = true;
        this.options.persistence.transaction(() => this.save(record, false));
      }
      this.close(record, status);
    }
  }
  private close(record: RecordEntry, status: 'cancelled' | 'expired' | 'superseded'): void {
    if (record.state.status !== 'pending') return;
    this.options.persistence.transaction(() => {
      record.state.status = status; record.state.resolvedAt = nowIso(); record.state.remoteAllowed = false;
      record.state.resolution = { ...record.state.resolution, phase: 'finished', source: 'system' };
      this.save(record, true);
      this.options.emitResolved(record.pending.sessionId, record.pending.requestId);
    });
  }
  private canOfferRemote(record: RecordEntry): boolean {
    return !record.needsValidation && this.configuration.enabled && this.configuration.projectionSupported && this.supportsDualApproval()
      && record.bootId === this.contract?.bootId && record.description.remoteSafe && record.createdAtMs !== null
      && record.expiresAtMs !== null && record.expiresAtMs > Date.now() && record.expiresAtMs > record.createdAtMs
      && this.bindingValid(record);
  }
  private bindingValid(record: RecordEntry): boolean {
    const current = this.options.getBinding(record.pending.sessionId);
    return current !== null && digest(current) === record.bindingHash;
  }
  private read(id: string): RecordEntry | null { return this.options.persistence.get<RecordEntry>(`${prefix}${id}`); }
  private records(): RecordEntry[] { return this.options.persistence.entries<RecordEntry>(prefix).map(row => row.value).filter(r => r.formatVersion === 1); }
  private save(record: RecordEntry, increment: boolean): void {
    if (increment) record.state.approvalVersion = String(BigInt(record.state.approvalVersion) + 1n);
    this.options.persistence.put(`${prefix}${record.pending.requestId}`, record);
    this.options.emitState(record.pending.sessionId, clone(record.state));
  }
  private saveInbox(record: RecordEntry): void {
    const sub = record.submission;
    if (!sub || sub.source !== 'mobile') return;
    const key = `inbox:${sub.id}`;
    const entry = this.options.persistence.get<Record<string, any>>(key);
    if (!entry || entry.localSessionId !== record.pending.sessionId || entry.runId !== record.binding.runId) return;
    if (sub.applied === true) this.options.persistence.put(key, { ...entry, state: 'applied', result: { outcome: 'approval_applied' } });
    else if (sub.applied === false) this.options.persistence.put(key, { ...entry, state: 'rejected', result: { code: 47007, reason: 'APPROVAL_STALE', reasonDetail: 'NEVER_DISPATCHED', message: '审批已处理或未派发。', retryable: false, retryAfterMs: null } });
    else if (sub.dispatchedAt) this.options.persistence.put(key, { ...entry, state: 'unknown' });
  }
}
