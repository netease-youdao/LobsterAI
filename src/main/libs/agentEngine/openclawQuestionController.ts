import {
  OpenClawQuestion,
  type OpenClawQuestionRecord,
  OpenClawQuestionStatus,
  parseOpenClawQuestionAnswers,
  parseOpenClawQuestionRecord,
} from '../../../shared/cowork/openclawQuestion';
import type { PermissionRequest, PermissionResult } from './types';

type GatewayClient = {
  request: <T = Record<string, unknown>>(
    method: string, params?: unknown, options?: { timeoutMs?: number | null },
  ) => Promise<T>;
};

type ControllerOptions = {
  getGatewayClient: () => GatewayClient | null;
  resolveSessionId: (sessionKey: string, runId?: string) => string | undefined;
  isSessionStopped: (sessionId: string, sessionKey: string) => boolean;
  emitPermissionRequest: (sessionId: string, request: PermissionRequest) => void;
  emitPermissionResolved: (sessionId: string, requestId: string) => void;
};

type PendingQuestion = {
  record: OpenClawQuestionRecord;
  sessionId: string;
  timer: ReturnType<typeof setTimeout>;
  response?: Promise<void>;
};

const RPC_TIMEOUT_MS = 10_000;
const TERMINAL_ERROR_REASONS = new Set(['QUESTION_ALREADY_TERMINAL', 'QUESTION_NOT_FOUND']);

/** Owns the native question lifecycle. It never dispatches to the legacy HTTP question bridge. */
export class OpenClawQuestionController {
  private readonly pending = new Map<string, PendingQuestion>();
  private readonly terminal = new Set<string>();
  private generation = 0;

  constructor(private readonly options: ControllerOptions) {}

  handlesRequest(requestId: string): boolean {
    return requestId.startsWith(OpenClawQuestion.RequestIdPrefix);
  }

  getPendingQuestions(): Array<PermissionRequest & { sessionId: string }> {
    const requests: Array<PermissionRequest & { sessionId: string }> = [];
    for (const [id, pending] of this.pending) {
      if (pending.record.expiresAtMs <= Date.now()) { this.finish(id); continue; }
      requests.push({
        sessionId: pending.sessionId, requestId: this.toRequestId(id),
        toolName: OpenClawQuestion.ToolName, toolInput: { ...pending.record }, toolUseId: id,
      });
    }
    return requests;
  }

  handleRequested(payload: unknown): void {
    const record = parseOpenClawQuestionRecord(payload);
    if (!record || this.terminal.has(record.id)) return;
    if (record.status !== OpenClawQuestionStatus.Pending || record.expiresAtMs <= Date.now()) {
      this.finish(record.id);
      return;
    }
    if (this.pending.has(record.id)) return;
    const sessionId = this.options.resolveSessionId(record.sessionKey, record.runId);
    // Questions owned by IM/other clients must not be assigned to the currently visible desktop task.
    if (!sessionId) return;
    if (this.options.isSessionStopped(sessionId, record.sessionKey)) {
      this.finish(record.id);
      this.cancel(record.id);
      return;
    }
    const timer = setTimeout(() => this.finish(record.id), Math.min(record.expiresAtMs - Date.now(), 2_147_483_647));
    timer.unref?.();
    this.pending.set(record.id, { record, sessionId, timer });
    this.options.emitPermissionRequest(sessionId, {
      requestId: this.toRequestId(record.id),
      toolName: OpenClawQuestion.ToolName,
      toolInput: { ...record },
      toolUseId: record.id,
    });
  }

  handleResolved(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const { id, status } = payload as Record<string, unknown>;
    if (typeof id !== 'string' || (status !== OpenClawQuestionStatus.Answered
      && status !== OpenClawQuestionStatus.Cancelled && status !== OpenClawQuestionStatus.Expired)) return;
    this.finish(id);
  }

  /** Restore pending questions after a handshake, without replaying events resolved during the RPC. */
  async restorePending(): Promise<void> {
    const client = this.options.getGatewayClient();
    if (!client) return;
    const generation = this.generation;
    const pendingBeforeList = new Set(this.pending.keys());
    try {
      const result = await client.request<{ questions?: unknown[] }>(OpenClawQuestion.List, {}, { timeoutMs: RPC_TIMEOUT_MS });
      if (generation !== this.generation || client !== this.options.getGatewayClient() || !Array.isArray(result.questions)) return;
      const ids = new Set<string>();
      for (const record of result.questions) {
        const parsed = parseOpenClawQuestionRecord(record);
        if (parsed) ids.add(parsed.id);
        this.handleRequested(record);
      }
      for (const id of pendingBeforeList) {
        if (!ids.has(id)) this.finish(id);
      }
    } catch (error) {
      if (generation === this.generation) console.warn('[OpenClawQuestion] failed to restore pending questions:', error);
    }
  }

  async respond(requestId: string, result: PermissionResult): Promise<void> {
    const id = requestId.slice(OpenClawQuestion.RequestIdPrefix.length);
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.record.expiresAtMs <= Date.now()) {
      this.finish(id);
      return;
    }
    if (pending.response) return pending.response;
    const client = this.options.getGatewayClient();
    if (!client) throw new Error('OpenClaw question gateway is disconnected');
    const answers = result.behavior === 'allow'
      ? parseOpenClawQuestionAnswers(pending.record.questions, result.updatedInput?.answers)
      : undefined;
    if (answers === null) throw new Error('Invalid OpenClaw question answers');
    const generation = this.generation;
    pending.response = (async () => {
      try {
        await client.request(OpenClawQuestion.Resolve, {
          id,
          ...(answers ? { answers: { answers } } : { cancel: true }),
        }, { timeoutMs: RPC_TIMEOUT_MS });
        if (generation === this.generation) this.finish(id);
      } catch (error) {
        const reason = (error as { details?: { reason?: string } } | null)?.details?.reason;
        if (reason && TERMINAL_ERROR_REASONS.has(reason)) {
          if (generation === this.generation) this.finish(id);
          return;
        }
        // Keep the request and the user's answers available for retry after a transport failure.
        console.warn('[OpenClawQuestion] failed to submit question response:', error);
        throw error;
      } finally {
        pending.response = undefined;
      }
    })();
    return pending.response;
  }

  cancelBySession(sessionId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.finish(id);
      this.cancel(id);
    }
  }

  /** A disconnect closes stale UI; the next handshake restores Gateway-owned pending questions. */
  disconnect(): void {
    this.generation += 1;
    for (const id of this.pending.keys()) this.finish(id);
    this.terminal.clear();
  }

  private cancel(id: string): void {
    const client = this.options.getGatewayClient();
    if (!client) return;
    void client.request(OpenClawQuestion.Resolve, { id, cancel: true }, { timeoutMs: RPC_TIMEOUT_MS }).catch((error) => {
      const reason = (error as { details?: { reason?: string } } | null)?.details?.reason;
      if (!reason || !TERMINAL_ERROR_REASONS.has(reason)) {
        console.warn('[OpenClawQuestion] failed to cancel stopped question:', error);
      }
    });
  }

  private finish(id: string): void {
    this.terminal.add(id);
    // Only retain enough tombstones to protect against late events/list responses.
    if (this.terminal.size > 1_000) this.terminal.delete(this.terminal.values().next().value!);
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    this.options.emitPermissionResolved(pending.sessionId, this.toRequestId(id));
  }

  private toRequestId(id: string): string {
    return `${OpenClawQuestion.RequestIdPrefix}${id}`;
  }
}
