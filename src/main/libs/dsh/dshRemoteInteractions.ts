import { createHash } from 'node:crypto';
import path from 'node:path';

import type { ApprovalDecisionOptions, ApprovalReconcileOptions, DualApprovalConfiguration } from '../../../shared/cowork/approval';
import { DshOpsAction } from '../../../shared/dshEngine/hostConstants';
import { parseRemoteQuestionItems, type QuestionAnswers, type QuestionDecisionOptions, type QuestionStatus } from '../../../shared/remote/questions';
import { type QuestionRegistration, RemoteQuestionService } from '../../remote/remoteQuestionService';
import type { RemoteStore } from '../../remote/remoteStore';
import { ApprovalDecisionService } from '../agentEngine/approvalDecisionService';
import type { DshAdapterSessionRecord } from '../agentEngine/dshRuntimeAdapter';
import { describeExecApproval } from '../agentEngine/openclawApprovalAdapters';
import type { CoworkRuntimeEvents, PermissionRequest, PermissionResult } from '../agentEngine/types';
import type { DshApprovalCallContext } from './dshHostManager';
import type { DshRemoteTurnEvidence } from './dshRemoteTurnEvidence';
import { type DshTypertClient, type DshWaterfallEvent, type DshWaterfallOutcome,DshWaterfallReceipt } from './dshTypertClient';

type NativeReceipt = { eventId: string; sessionId: string; outcomeHash: string };
type LiveDecision = {
  nativeApproval?: DshApprovalCallContext | null;
  event: DshWaterfallEvent; request: PermissionRequest; sessionId: string;
  resolve: (outcome: DshWaterfallOutcome) => void;
};
type Deps = {
  remote: RemoteStore;
  getSession: (id: string) => DshAdapterSessionRecord | null | undefined;
  evidence: DshRemoteTurnEvidence;
  client: () => DshTypertClient | null;
  ready: () => boolean;
  emit: <K extends keyof CoworkRuntimeEvents>(event: K, ...args: Parameters<CoworkRuntimeEvents[K]>) => void;
};
const QUESTION_TTL_MS = 15 * 60_000;
const receiptKey = (id: string) => `dshDecisionReceipt:${id}`;

export class DshRemoteInteractions {
  readonly questions: RemoteQuestionService;
  readonly approvals: ApprovalDecisionService;
  private readonly live = new Map<string, LiveDecision>();
  private configuration: DualApprovalConfiguration = { enabled: false, projectionSupported: false };

  constructor(private readonly deps: Deps) {
    const binding = (id: string) => {
      const turn = deps.evidence.binding(id), session = deps.getSession(id);
      if (!turn || !session) return null;
      return { runId: turn.remoteRunId, owner: deps.remote.owner(id), agentId: session.agentId ?? 'main', cwd: session.cwd };
    };
    this.questions = new RemoteQuestionService(deps.remote, binding);
    this.approvals = new ApprovalDecisionService({
      persistence: deps.remote, getGateway: () => null,
      getBinding: id => { const identity = binding(id); return identity ? { runId: identity.runId, identity } : null; },
      native: {
        ready: deps.ready,
        dispatch: (id, decision) => this.deliver(id, { kind: 'result', value: decision === 'deny' ? 'rejected' : 'allowed-once' }),
        reconcile: id => this.reconcileReceipt(id),
      },
      isPolicyCurrent: registration => {
        const pending = this.live.get(registration.pending.requestId);
        return !!pending && this.describe(pending).remoteSafe;
      },
      emitState: (id, state) => deps.emit('permissionState', id, state),
      emitResolved: (id, requestId) => deps.emit('permissionResolved', id, requestId),
      emitRequest: (id, request) => deps.emit('permissionRequest', id, request),
      emitError: (id, message) => deps.emit('error', id, message),
      continueSession: async () => { throw new Error('DSH waterfall decisions resume their own execution.'); },
      isSessionActive: () => false,
    });
  }

  configure(configuration: DualApprovalConfiguration): void {
    this.configuration = configuration;
    this.approvals.configure(configuration);
  }

  private describe(item: LiveDecision) {
    const session = this.deps.getSession(item.sessionId);
    const native = item.nativeApproval;
    const args = native?.args;
    // bash resolves an absolute workdir unchanged. Relative/default workdirs depend on mutable
    // DSH workingDirectory state, so those decisions stay on the desktop.
    const trusted = native?.toolName === 'bash' && item.request.toolName === native.toolName
      && native.nativeSessionId === item.event.agentId && native.coworkSessionId === item.sessionId
      && args && typeof args.command === 'string' && Object.keys(args).every(key => ['command', 'workdir', 'description', 'timeoutMs'].includes(key))
      && typeof args.workdir === 'string' && path.isAbsolute(args.workdir);
    return describeExecApproval({ command: trusted ? String(args.command) : undefined, cwd: trusted ? String(args.workdir) : null },
      session ? { cwd: session.cwd, name: path.basename(session.cwd) } : null);
  }

  register(item: LiveDecision, kind: 'approval' | 'user-questions', rootRequestId: string | undefined): boolean {
    const { event, request, sessionId } = item;
    if (!this.deps.ready() || !this.configuration.enabled || !rootRequestId || !event.confirmDelivery
      || !this.deps.evidence.binding(sessionId, rootRequestId) || !this.deps.remote.owner(sessionId)) return false;
    const now = Date.now();
    if (kind === 'approval') {
      const description = this.describe(item);
      if (!description.remoteSafe || !this.configuration.projectionSupported) return false;
      const state = this.approvals.register({
        pending: { requestId: request.requestId, sessionId, kind: 'exec', allowedDecisions: ['allow-once', 'deny'] },
        // The bound description is the complete validated operation; local raw args can contain credentials.
        permission: { ...request, toolInput: {} }, description, rawRequest: { nativeId: event.agentId, callId: request.toolUseId ?? null },
        createdAtMs: now, expiresAtMs: now + QUESTION_TTL_MS,
      });
      if (!state) return false;
      request.approval = state;
    } else {
      const raw = request.toolInput.questions;
      if (!Array.isArray(raw) || request.toolInput.secretStore !== undefined) return false;
      const items = parseRemoteQuestionItems(raw.map(q => q && typeof q === 'object' && !q.intent && !q.isSecret
        && q.secretStore === undefined && q.inputType !== 'password'
        ? { ...q, questionId: q.id, header: q.header ?? '', options: q.options ?? [], isOther: q.isOther !== false, allowSkip: q.allowSkip !== false }
        : null));
      if (!items) return false;
      const state = this.questions.register({
        kind: 'native', requestId: request.requestId, sessionId, createdAt: now, expiresAt: now + QUESTION_TTL_MS, questions: items,
        resolve: async response => {
          const answers = items.map(q => {
            const values = response.answers[q.questionId] ?? [];
            const selected = values.filter(v => q.options.some(o => o.label === v));
            const custom = values.find(v => !selected.includes(v));
            return { id: q.questionId, selected, ...(custom ? { custom } : {}) };
          });
          const cancel = response.action === 'cancel';
          const outcome: DshWaterfallOutcome = cancel
            ? { kind: 'rejected', error: { name: 'UserQuestionError', message: 'The question was cancelled.', code: 'ASK_ABORTED' } }
            : { kind: 'result', value: { answers } };
          const result = await this.deliver(request.requestId, outcome);
          if (result === DshWaterfallReceipt.Applied) return { kind: 'confirmed', status: cancel ? 'cancelled' : 'answered', answers: response.answers };
          return { kind: result === DshWaterfallReceipt.Stale ? 'known_not_applied' : 'unknown' };
        },
      });
      if (!state) return false;
    }
    this.live.set(request.requestId, item);
    return true;
  }

  private async deliver(id: string, outcome: DshWaterfallOutcome): Promise<DshWaterfallReceipt> {
    const live = this.live.get(id);
    if (!live?.event.confirmDelivery || live.event.signal.aborted) return DshWaterfallReceipt.Stale;
    const outcomeHash = createHash('sha256').update(JSON.stringify(outcome)).digest('hex');
    this.deps.remote.put(receiptKey(id), { eventId: live.event.eventId, sessionId: live.event.agentId, outcomeHash } satisfies NativeReceipt);
    const receipt = live.event.confirmDelivery();
    this.live.delete(id);
    live.resolve(outcome);
    return receipt;
  }

  async reconcileReceipt(id: string): Promise<boolean> {
    const receipt = this.deps.remote.get<NativeReceipt>(receiptKey(id));
    const client = this.deps.client();
    if (!receipt || !client) return false;
    const result = await client.callOps<{ matched: boolean }>(DshOpsAction.InspectDecisionReceipt, receipt, AbortSignal.timeout(4_000));
    return result?.matched === true;
  }

  desktopQuestion(id: string, result: PermissionResult) {
    const wire = result.behavior === 'allow' ? result.updatedInput?.answers : undefined;
    if (Array.isArray(wire)) {
      const answers: QuestionAnswers = {};
      for (const answer of wire) {
        if (!answer || typeof answer.id !== 'string' || !Array.isArray(answer.selected)) return result;
        answers[answer.id] = [...answer.selected, ...(answer.custom ? [answer.custom] : [])];
      }
      return { behavior: 'allow' as const, updatedInput: { answers } };
    }
    return result;
  }

  submitQuestion(id: string, result: PermissionResult, options?: QuestionDecisionOptions) {
    return this.questions.submit(id, options?.source === 'mobile' ? result : this.desktopQuestion(id, result), options);
  }
  submitApproval(id: string, result: PermissionResult, options?: ApprovalDecisionOptions) {
    return this.approvals.submit(id, result.behavior === 'allow' ? 'allow-once' : 'deny', options);
  }
  registerQuestion(input: QuestionRegistration) { return this.questions.register(input); }
  settleQuestion(id: string, result: { status: Exclude<QuestionStatus, 'pending'>; answers?: QuestionAnswers }) { this.questions.settle(id, result); }
  reconcileApproval(id: string, options?: ApprovalReconcileOptions) { return this.approvals.reconcileSubmission(id, options); }
  expire(now?: number) { this.approvals.expire(now); this.questions.expirePending(now); }
  forget(id: string) { this.live.delete(id); }
}
