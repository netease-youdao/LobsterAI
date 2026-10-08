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
  private readonly inFlight = new Map<string, Promise<CoworkTurnUsage | null>>();

  constructor(private readonly deps: CoworkTurnUsageServiceDeps) {}

  /** Runs when a turn completes or fails; turns without package-model requests are skipped. */
  async settleLatestTurn(sessionId: string): Promise<void> {
    const message = this.deps.getStore().getLatestUserMessage(sessionId);
    const trace = getCoworkLlmTrace(message?.metadata);
    if (!message || !trace) return;
    const stats = this.deps.getTraceStats(trace.traceId);
    if (!stats || stats.requests === 0) {
      console.debug(
        `[TurnUsage] skipped session ${sessionId}: trace ${trace.traceId} made no LobsterAI model requests.`,
      );
      return;
    }
    await this.settle(sessionId, message.id, { afterTurn: true });
  }

  /** Renderer-triggered refresh, e.g. retrying a failed or partial summary. */
  refresh(sessionId: string, messageId: string): Promise<CoworkTurnUsage | null> {
    return this.settle(sessionId, messageId, { afterTurn: false });
  }

  private settle(sessionId: string, messageId: string, mode: SettleMode): Promise<CoworkTurnUsage | null> {
    const key = `${sessionId}:${messageId}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const request = this.runSettle(sessionId, messageId, mode).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return request;
  }

  private async runSettle(sessionId: string, messageId: string, mode: SettleMode): Promise<CoworkTurnUsage | null> {
    const message = this.deps.getStore().getMessage(sessionId, messageId);
    const trace = getCoworkLlmTrace(message?.metadata);
    if (!message || message.type !== 'user' || !trace) return null;

    const previous = getCoworkTurnUsage(message.metadata);
    const observedCompletedRequests = this.deps.getTraceStats(trace.traceId)?.completed;
    if (mode.afterTurn && !previous) {
      this.deps.emitTurnUsage({
        sessionId,
        messageId,
        turnUsage: this.buildEmptyUsage(trace, CoworkTurnUsageStatus.Pending, observedCompletedRequests),
      });
    }

    let usage = await this.fetchUsage(trace, observedCompletedRequests);
    if (mode.afterTurn && usage?.status === CoworkTurnUsageStatus.Partial) {
      await this.sleep(PARTIAL_RETRY_DELAY_MS);
      usage = await this.fetchUsage(trace, observedCompletedRequests) ?? usage;
    }

    // A failed refresh keeps a summary that was already fetched.
    const hasPreviousSummary = previous && previous.status !== CoworkTurnUsageStatus.Failed
      && previous.status !== CoworkTurnUsageStatus.Pending;
    const result = usage
      ?? (hasPreviousSummary ? previous : this.buildEmptyUsage(trace, CoworkTurnUsageStatus.Failed, observedCompletedRequests));
    if (result !== previous) {
      this.persist(sessionId, messageId, result);
    }
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
    return result;
  }

  private async fetchUsage(
    trace: CoworkLlmTrace,
    observedCompletedRequests: number | undefined,
  ): Promise<CoworkTurnUsage | null> {
    if (!this.deps.hasAuthTokens()) {
      console.warn(`[TurnUsage] cannot fetch trace ${trace.traceId}: not signed in.`);
      return null;
    }
    const url = this.deps.buildServerUrl(
      `${LLM_TRACE_USAGE_API_PATH}/${trace.traceId}?since=${Math.floor(trace.startedAt)}`,
    );
    try {
      const response = await this.deps.fetchWithAuth(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      });
      const body = await response.json() as { code?: number; message?: string; data?: unknown };
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
