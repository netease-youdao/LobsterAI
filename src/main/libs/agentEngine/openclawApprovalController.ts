import type { ApprovalDecisionOptions, ApprovalDecisionOutcome, ApprovalReconcileOptions, ApprovalState, DualApprovalConfiguration } from '../../../shared/cowork/approval';
import { t } from '../../i18n';
import { stableJson } from '../../remote/canonical';
import { withApprovalContinuationGuard } from './approvalContinuationContext';
import { type ApprovalBinding, ApprovalDecisionService, type ApprovalGateway, type ApprovalGatewayContract, type ApprovalPersistence } from './approvalDecisionService';
import { describeExecApproval, describePluginApproval } from './openclawApprovalAdapters';
import {
  buildExecApprovalPermissionRequest, buildPluginApprovalPermissionRequest,
  parseApprovalResolvedPayload, parseExecApprovalRequestedPayload, parsePluginApprovalRequestedPayload,
  resolveApprovalDecision,
} from './openclawApprovalBridge';
import type { PermissionRequest, PermissionResult } from './types';

type OpenClawApprovalControllerOptions = {
  persistence: ApprovalPersistence;
  getBinding: (sessionId: string) => ApprovalBinding | null;
  getWorkspace: (sessionId: string) => { cwd: string; name: string } | null;
  getGatewayClient: () => ApprovalGateway | null;
  resolveSessionId: (sessionKey: string) => string | undefined;
  isSessionInStopCooldown: (sessionId: string) => boolean;
  isManualStopSuppressed: (sessionId: string, sessionKey: string) => boolean;
  sessionExists: (sessionId: string) => boolean;
  isSessionActive: (sessionId: string) => boolean;
  continueSession: (sessionId: string, prompt: string) => Promise<void>;
  canContinue?: (sessionId: string) => boolean;
  emitPermissionRequest: (sessionId: string, request: PermissionRequest) => void;
  emitPermissionState: (sessionId: string, state: ApprovalState) => void;
  emitPermissionResolved: (sessionId: string, requestId: string) => void;
  emitError: (sessionId: string, error: string) => void;
};

export class OpenClawApprovalController {
  private readonly decisions: ApprovalDecisionService;
  constructor(private readonly options: OpenClawApprovalControllerOptions) {
    this.decisions = new ApprovalDecisionService({
      persistence: options.persistence, getGateway: options.getGatewayClient, getBinding: options.getBinding,
      emitState: options.emitPermissionState, emitResolved: options.emitPermissionResolved,
      isPolicyCurrent: registration => stableJson(registration.description) === stableJson(registration.pending.kind === 'exec'
        ? describeExecApproval(registration.rawRequest, options.getWorkspace(registration.pending.sessionId))
        : describePluginApproval(registration.rawRequest)),
      emitRequest: options.emitPermissionRequest, emitError: options.emitError, isSessionActive: options.isSessionActive,
      canContinue: options.canContinue,
      continueSession: (sessionId, _decision, guard) => withApprovalContinuationGuard(guard, () => options.continueSession(sessionId, t('execApprovalsResolved'))),
    });
  }

  respondToPermissionConfirmed(requestId: string, result: PermissionResult, options?: ApprovalDecisionOptions): Promise<ApprovalDecisionOutcome> {
    const pending = this.decisions.getPending(requestId);
    if (!pending) return Promise.resolve({ kind: 'known_not_applied', reason: 'APPROVAL_STALE' });
    // Remote decisions are single use; a plugin that only supports allow-always stays local.
    if (options?.source === 'mobile' && result.behavior === 'allow' && pending.allowedDecisions && !pending.allowedDecisions.includes('allow-once')) {
      return Promise.resolve({ kind: 'known_not_applied', reason: 'REMOTE_APPROVAL_UNAVAILABLE' });
    }
    return this.decisions.submit(requestId, resolveApprovalDecision(pending, result), options);
  }
  respondToPermission(requestId: string, result: PermissionResult): void {
    void this.respondToPermissionConfirmed(requestId, result).catch(error => {
      const state = this.decisions.getState(requestId);
      if (state) this.options.emitError(state.sessionId, t('approvalSubmitFailed', { message: error instanceof Error ? error.message : String(error) }));
    });
  }
  getPermissionState(requestId: string): ApprovalState | null { return this.decisions.getState(requestId); }
  getApprovalSubmission(id: string): ApprovalDecisionOutcome | null { return this.decisions.getSubmission(id); }
  reconcileApprovalSubmission(id: string, options?: ApprovalReconcileOptions): Promise<ApprovalDecisionOutcome | null> { return this.decisions.reconcileSubmission(id, options); }
  configureDualApproval(configuration: DualApprovalConfiguration): void { this.decisions.configure(configuration); }
  supportsDualApproval(): boolean { return this.decisions.supportsDualApproval(); }
  setGatewayContract(contract: ApprovalGatewayContract | null): void { this.decisions.setGatewayContract(contract); }
  expirePermissions(now?: number): void { this.decisions.expire(now); }
  closeSessionPermissions(id: string, runId: string | null, status?: 'cancelled' | 'expired' | 'superseded'): void { this.decisions.closeSession(id, runId, status); }
  listPendingPermissions(): Array<{ sessionId: string; request: PermissionRequest }> { return this.decisions.listPending(); }

  handleExecApprovalRequested(payload: unknown): void {
    const approval = parseExecApprovalRequestedPayload(payload);
    if (!approval) return;
    const { command, request, requestId, sessionKey, shouldAutoApprove, createdAtMs, expiresAtMs } = approval;
    const sessionId = this.options.resolveSessionId(sessionKey);
    if (!sessionId || this.suppressed(sessionId, sessionKey)) return;
    const permission = buildExecApprovalPermissionRequest(requestId, request, command);
    const state = this.decisions.register({ pending: { requestId, sessionId, kind: 'exec', ...(shouldAutoApprove ? { allowAlways: true } : {}) },
      rawRequest: request, permission, createdAtMs, expiresAtMs,
      description: describeExecApproval(request, this.options.getWorkspace(sessionId)),
    });
    if (!state || state.status !== 'pending') return;
    if (shouldAutoApprove) {
      // Automatic policy still uses the same durable arbiter, and never falls through to a fake human request.
      void this.respondToPermissionConfirmed(requestId, { behavior: 'allow', updatedInput: {} }, { submissionId: `system:${requestId}`, source: 'system' });
      return;
    }
    this.options.emitPermissionRequest(sessionId, { ...permission, approval: state });
  }

  handlePluginApprovalRequested(payload: unknown): void {
    const approval = parsePluginApprovalRequestedPayload(payload);
    if (!approval) return;
    const { allowedDecisions, request, requestId, sessionKey, createdAtMs, expiresAtMs } = approval;
    const sessionId = this.options.resolveSessionId(sessionKey);
    if (!sessionId || this.suppressed(sessionId, sessionKey)) return;
    const permission = buildPluginApprovalPermissionRequest(requestId, request, allowedDecisions);
    const state = this.decisions.register({ pending: { requestId, sessionId, kind: 'plugin', allowedDecisions },
      rawRequest: request, permission, createdAtMs, expiresAtMs, description: describePluginApproval(request) });
    if (state?.status === 'pending') this.options.emitPermissionRequest(sessionId, { ...permission, approval: state });
  }

  handleExecApprovalResolved(payload: unknown): void { this.resolved(payload); }
  handlePluginApprovalResolved(payload: unknown): void { this.resolved(payload); }
  private resolved(payload: unknown): void {
    const resolved = parseApprovalResolvedPayload(payload);
    if (resolved) this.decisions.mergeResolved(resolved.requestId, resolved.decision, resolved.ts, resolved.request);
  }
  private suppressed(sessionId: string, sessionKey: string): boolean {
    return this.options.isSessionInStopCooldown(sessionId) || this.options.isManualStopSuppressed(sessionId, sessionKey);
  }
  dispose(): void { this.decisions.dispose(); }
  clearBySession(sessionId: string): void { this.decisions.closeSession(sessionId, null); }
}
