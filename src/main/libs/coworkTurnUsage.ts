import {
  buildCoworkTurnUsage,
  type CoworkLlmTrace,
  type CoworkTurnUsage,
  CoworkTurnUsageStatus,
  getCoworkLlmTrace,
  getCoworkTurnUsage,
  LLM_TRACE_USAGE_API_PATH,
} from '../../shared/cowork/llmTurnUsage';
import type { CoworkMessage, CoworkMessageMetadata } from '../coworkStore';

type TurnUsageStore = {
  getMessage(sessionId: string, messageId: string): CoworkMessage | null;
  getLatestUserMessage(sessionId: string): CoworkMessage | null;
  updateMessage(sessionId: string, messageId: string, updates: { metadata?: CoworkMessageMetadata }): void;
};

type TurnTraceStats = {
  requests: number;
  completed: number;
};

export type CoworkTurnUsageEvent = {
  sessionId: string;
  messageId: string;
  turnUsage: CoworkTurnUsage;
};

export type CoworkTurnUsageServiceDeps = {
  getStore: () => TurnUsageStore;
  fetchWithAuth: (url: string, init?: RequestInit) => Promise<Response>;
  hasAuthTokens: () => boolean;
  /** Absolute server URL for an API path (including the client query parameters). */
  buildServerUrl: (pathWithQuery: string) => string;
  /** Model requests the local token proxy forwarded for a trace. */
  getTraceStats: (traceId: string) => TurnTraceStats | null;
  emitTurnUsage: (event: CoworkTurnUsageEvent) => void;
  /** Capture account/session access once; the fence must stay valid across awaits. */
  captureSessionAccess?: (sessionId: string) => (() => boolean);
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** The ledger is written before each proxied stream ends; one retry covers a slow commit. */
const PARTIAL_RETRY_DELAY_MS = 1_500;

type SettleMode = {
  /** Turn just finished: show a pending state and retry once if the ledger lags. */
  afterTurn: boolean;
};

/**
 * Settles the credits and token usage of a Cowork turn from the
 * lobsterai-server ledger and stores it on the turn's user message.
 */
export class CoworkTurnUsageService {
  private readonly inFlight = new Map<string, { promise: Promise<CoworkTurnUsage | null>; isCurrent: () => boolean }>();

  constructor(private readonly deps: CoworkTurnUsageServiceDeps) {}

  /** Runs when a turn completes or fails; turns without package-model requests are skipped. */
  async settleLatestTurn(sessionId: string): Promise<void> {
    const isCurrent = this.deps.captureSessionAccess?.(sessionId) ?? (() => true);
    if (!isCurrent()) return;
    const message = this.deps.getStore().getLatestUserMessage(sessionId);
    const trace = getCoworkLlmTrace(message?.metadata);
    if (!message || !trace) return;
    const stats = this.deps.getTraceStats(trace.traceId);
    if ((!stats || stats.requests === 0) && !message.metadata?.turnMediaTaskIds?.length) {
      console.debug(
        `[TurnUsage] skipped session ${sessionId}: trace ${trace.traceId} made no LobsterAI model requests.`,
      );
      return;
    }
    await this.settle(sessionId, message.id, { afterTurn: true });
  }

  /** Bind a generated task to the user message captured before the async tool request. */
  recordMediaTask(sessionId: string, userMessageId: string, taskId: unknown): void {
    const isCurrent = this.deps.captureSessionAccess?.(sessionId) ?? (() => true);
    if (!isCurrent()) return;
    const id = String(taskId ?? '');
    if (!/^[1-9]\d*$/.test(id)) return;
    const store = this.deps.getStore();
    const message = store.getMessage(sessionId, userMessageId);
    if (!message || message.type !== 'user') return;
    const ids = [...new Set([...(message.metadata?.turnMediaTaskIds ?? []), id])];
    store.updateMessage(sessionId, userMessageId, {
      metadata: { ...message.metadata, turnMediaTaskIds: ids },
    });
  }

  /** Renderer-triggered refresh, e.g. retrying a failed or partial summary. */
  refresh(sessionId: string, messageId: string): Promise<CoworkTurnUsage | null> {
    return this.settle(sessionId, messageId, { afterTurn: false });
  }

  private settle(sessionId: string, messageId: string, mode: SettleMode): Promise<CoworkTurnUsage | null> {
    const isCurrent = this.deps.captureSessionAccess?.(sessionId) ?? (() => true);
    if (!isCurrent()) return Promise.resolve(null);
    const key = `${sessionId}:${messageId}`;
    const existing = this.inFlight.get(key);
    if (existing?.isCurrent()) return existing.promise;
    const request = this.runSettle(sessionId, messageId, mode, isCurrent).finally(() => {
      // An account change may already have replaced this request.
      if (this.inFlight.get(key)?.promise === request) this.inFlight.delete(key);
    });
    this.inFlight.set(key, { promise: request, isCurrent });
    return request;
  }

  private async runSettle(sessionId: string, messageId: string, mode: SettleMode, isCurrent: () => boolean): Promise<CoworkTurnUsage | null> {
    if (!isCurrent()) return null;
    const message = this.deps.getStore().getMessage(sessionId, messageId);
    const trace = getCoworkLlmTrace(message?.metadata);
    if (!message || message.type !== 'user' || !trace) return null;

    const previous = getCoworkTurnUsage(message.metadata);
    const observedCompletedRequests = this.deps.getTraceStats(trace.traceId)?.completed
      ?? previous?.observedCompletedRequests;
    if (!isCurrent()) return null;
    if (mode.afterTurn && !previous) {
      this.deps.emitTurnUsage({
        sessionId,
        messageId,
        turnUsage: this.buildEmptyUsage(trace, CoworkTurnUsageStatus.Pending, observedCompletedRequests),
      });
    }

    const mediaTaskIds = message.metadata?.turnMediaTaskIds ?? [];
    let usage = await this.fetchUsage(trace, observedCompletedRequests, mediaTaskIds, isCurrent);
    if (!isCurrent()) return null;
    if (mode.afterTurn && (!usage || usage.status === CoworkTurnUsageStatus.Partial)) {
      await this.sleep(PARTIAL_RETRY_DELAY_MS);
      if (!isCurrent()) return null;
      usage = await this.fetchUsage(trace, observedCompletedRequests, mediaTaskIds, isCurrent) ?? usage;
      if (!isCurrent()) return null;
    }

    // Account switches and ledger delays must not replace a saved summary with fewer requests.
    const hasPreviousSummary = previous && previous.status !== CoworkTurnUsageStatus.Failed
      && previous.status !== CoworkTurnUsageStatus.Pending;
    if (hasPreviousSummary && usage && usage.requestCount < previous.requestCount) {
      usage = null;
    }
    const result = usage
      ?? (hasPreviousSummary ? previous : this.buildEmptyUsage(trace, CoworkTurnUsageStatus.Failed, observedCompletedRequests));
    if (!isCurrent()) return null;
    if (result !== previous) {
      this.persist(sessionId, messageId, result);
    }
    if (!isCurrent()) return null;
    this.deps.emitTurnUsage({ sessionId, messageId, turnUsage: result });
    const logLine = `[TurnUsage] session ${sessionId} message ${messageId} trace ${trace.traceId}:`
      + ` status=${result.status} requests=${result.requestCount}`
      + ` observedCompleted=${observedCompletedRequests ?? 'unknown'} failed=${result.failedRequestCount}`
      + ` credits=${result.creditsUsed} totalTokens=${result.totalTokens} scope=${result.billingScope ?? 'unknown'}.`;
    if (result.status === CoworkTurnUsageStatus.Settled) {
      console.log(logLine);
    } else {
      console.warn(logLine);
    }
    return isCurrent() ? result : null;
  }

  private async fetchUsage(
    trace: CoworkLlmTrace,
    observedCompletedRequests: number | undefined,
    mediaTaskIds: string[],
    isCurrent: () => boolean,
  ): Promise<CoworkTurnUsage | null> {
    if (!isCurrent()) return null;
    if (!this.deps.hasAuthTokens()) {
      console.warn(`[TurnUsage] cannot fetch trace ${trace.traceId}: not signed in.`);
      return null;
    }
    const params = new URLSearchParams({ since: String(Math.floor(trace.startedAt)) });
    if (mediaTaskIds.length > 0) params.set('mediaTaskIds', mediaTaskIds.join(','));
    const url = this.deps.buildServerUrl(`${LLM_TRACE_USAGE_API_PATH}/${trace.traceId}?${params}`);
    try {
      const response = await this.deps.fetchWithAuth(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      });
      if (!isCurrent()) return null;
      const body = await response.json() as { code?: number; message?: string; data?: unknown };
      if (!isCurrent()) return null;
      if (!response.ok || body.code !== 0) {
        console.warn(
          `[TurnUsage] summary request for trace ${trace.traceId} failed: http=${response.status} code=${body.code ?? 'none'}.`,
        );
        return null;
      }
      const usage = buildCoworkTurnUsage(body.data, {
        traceId: trace.traceId,
        observedCompletedRequests,
        now: this.now(),
      });
      if (!usage) {
        console.warn(`[TurnUsage] summary response for trace ${trace.traceId} was not usable.`);
      }
      // An empty ledger can belong to a different signed-in account. It is not
      // evidence that this local turn cost zero; keep its persisted snapshot.
      // Zero-credit requests and media-only summaries still contain ledger rows.
      if (usage && usage.requestCount === 0 && usage.creditsUsed === 0 && usage.totalTokens === 0
        && !usage.modelUsage?.length && !usage.mediaPending) {
        return null;
      }
      return usage;
    } catch (error) {
      console.warn(`[TurnUsage] summary request for trace ${trace.traceId} errored.`, error);
      return null;
    }
  }

  private persist(sessionId: string, messageId: string, turnUsage: CoworkTurnUsage): void {
    const store = this.deps.getStore();
    // Re-read so a metadata write made while the request was in flight is kept.
    const latest = store.getMessage(sessionId, messageId);
    if (!latest) return;
    store.updateMessage(sessionId, messageId, {
      metadata: { ...(latest.metadata ?? {}), turnUsage } as CoworkMessageMetadata,
    });
  }

  private buildEmptyUsage(
    trace: CoworkLlmTrace,
    status: CoworkTurnUsage['status'],
    observedCompletedRequests: number | undefined,
  ): CoworkTurnUsage {
    return {
      traceId: trace.traceId,
      status,
      requestCount: 0,
      failedRequestCount: 0,
      models: [],
      creditsUsed: 0,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      ...(typeof observedCompletedRequests === 'number' ? { observedCompletedRequests } : {}),
      updatedAt: this.now(),
    };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep?.(ms) ?? new Promise(resolve => setTimeout(resolve, ms));
  }
}
