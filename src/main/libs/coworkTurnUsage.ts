import {
  buildCoworkTurnUsage,
  type CoworkLlmTrace,
  type CoworkTurnUsage,
  CoworkTurnUsageStatus,
  getCoworkLlmTrace,
  getCoworkLlmTraceIds,
  getCoworkTurnUsage,
  LLM_TRACE_USAGE_API_PATH,
  mergeLlmTraceUsageSummaries,
} from '../../shared/cowork/llmTurnUsage';
import type { CoworkMessage, CoworkMessageMetadata } from '../coworkStore';
import type { NativeRunTurnUsage } from './nativeRunTurnUsage';

type TurnUsageStore = {
  getMessage(sessionId: string, messageId: string): CoworkMessage | null;
  getLatestUserMessage(sessionId: string): CoworkMessage | null;
  getRecentConversationMessages(sessionId: string, limit: number): CoworkMessage[];
  updateMessage(sessionId: string, messageId: string, updates: { metadata?: CoworkMessageMetadata }): void;
};

type TurnTraceStats = {
  requests: number;
  completed: number;
};

/** OpenClaw runs of a finished turn, used to bind IM/cron turns to their traces. */
export type NativeTurnRuns = {
  runIds: string[];
  /**
   * OpenClaw's start time of the run, when known. Earlier replies cannot belong
   * to it, which reveals a latest user message left over from an earlier turn.
   */
  startedAt?: number;
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
  /** Removes the traces and media tasks that IM/cron runs reported for these run ids. */
  claimNativeRunTurnUsage?: (runIds: string[]) => NativeRunTurnUsage | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** The ledger is written before each proxied stream ends; one retry covers a slow commit. */
const PARTIAL_RETRY_DELAY_MS = 1_500;
/** Conversation tail searched for replies that follow the user message being bound. */
const BIND_REPLY_CHECK_LIMIT = 40;

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
  async settleLatestTurn(sessionId: string, nativeRuns?: NativeTurnRuns): Promise<void> {
    if (nativeRuns?.runIds.length) this.bindNativeRunUsage(sessionId, nativeRuns);
    const message = this.deps.getStore().getLatestUserMessage(sessionId);
    const trace = getCoworkLlmTrace(message?.metadata);
    if (!message || !trace) return;
    const stats = this.getTurnTraceStats(trace);
    if ((!stats || stats.requests === 0) && !message.metadata?.turnMediaTaskIds?.length) {
      console.debug(
        `[TurnUsage] skipped session ${sessionId}: trace ${trace.traceId} made no LobsterAI model requests.`,
      );
      return;
    }
    await this.settle(sessionId, message.id, { afterTurn: true });
  }

  /**
   * OpenClaw starts IM and cron runs itself, so their synced user message has
   * no client trace. Give it the traces and media tasks the runs reported.
   */
  private bindNativeRunUsage(sessionId: string, nativeRuns: NativeTurnRuns): void {
    const usage = this.deps.claimNativeRunTurnUsage?.(nativeRuns.runIds);
    if (!usage) return;
    const store = this.deps.getStore();
    const message = store.getLatestUserMessage(sessionId);
    // A desktop prompt in an IM session keeps the trace it was sent with.
    if (!message || getCoworkLlmTrace(message.metadata)) return;
    // The run's own message has not synced; never charge an earlier turn for it.
    if (nativeRuns.startedAt !== undefined && this.hasReplyBefore(sessionId, message.id, nativeRuns.startedAt)) {
      console.warn(
        `[TurnUsage] skipped native run trace ${usage.trace.traceId} for session ${sessionId}:`
        + ` latest user message ${message.id} belongs to an earlier turn.`,
      );
      return;
    }
    const mediaTaskIds = [...new Set([...(message.metadata?.turnMediaTaskIds ?? []), ...usage.mediaTaskIds])];
    store.updateMessage(sessionId, message.id, {
      metadata: {
        ...message.metadata,
        llmTrace: usage.trace,
        ...(mediaTaskIds.length > 0 ? { turnMediaTaskIds: mediaTaskIds } : {}),
        // Desktop turns stamp the selected preset on their messages; IM/cron runs resolve it in OpenClaw.
        ...(usage.modelPreset && !message.metadata?.modelPresetId ? usage.modelPreset : {}),
      },
    });
    console.debug(
      `[TurnUsage] bound native run trace ${usage.trace.traceId} (+${usage.trace.relatedTraceIds?.length ?? 0})`
      + ` to session ${sessionId} message ${message.id}.`,
    );
  }

  private hasReplyBefore(sessionId: string, userMessageId: string, timestamp: number): boolean {
    const messages = this.deps.getStore().getRecentConversationMessages(sessionId, BIND_REPLY_CHECK_LIMIT);
    const index = messages.findIndex(item => item.id === userMessageId);
    return index >= 0 && messages.slice(index + 1).some(item => item.type === 'assistant' && item.timestamp < timestamp);
  }

  /** Bind a generated task to the user message captured before the async tool request. */
  recordMediaTask(sessionId: string, userMessageId: string, taskId: unknown): void {
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
    const observedCompletedRequests = this.getTurnTraceStats(trace)?.completed
      ?? previous?.observedCompletedRequests;
    if (mode.afterTurn && !previous) {
      this.deps.emitTurnUsage({
        sessionId,
        messageId,
        turnUsage: this.buildEmptyUsage(trace, CoworkTurnUsageStatus.Pending, observedCompletedRequests),
      });
    }

    const mediaTaskIds = message.metadata?.turnMediaTaskIds ?? [];
    let usage = await this.fetchUsage(trace, observedCompletedRequests, mediaTaskIds);
    if (mode.afterTurn && (!usage || usage.status === CoworkTurnUsageStatus.Partial)) {
      await this.sleep(PARTIAL_RETRY_DELAY_MS);
      usage = await this.fetchUsage(trace, observedCompletedRequests, mediaTaskIds) ?? usage;
    }

    // Account switches and ledger delays must not replace a saved summary with fewer requests.
    const hasPreviousSummary = previous && previous.status !== CoworkTurnUsageStatus.Failed
      && previous.status !== CoworkTurnUsageStatus.Pending;
    if (hasPreviousSummary && usage && usage.requestCount < previous.requestCount) {
      usage = null;
    }
    const result = usage
      ?? (hasPreviousSummary ? previous : this.buildEmptyUsage(trace, CoworkTurnUsageStatus.Failed, observedCompletedRequests));
    const resultMessageId = result !== previous
      ? this.persist(sessionId, messageId, result) ?? messageId
      : messageId;
    this.deps.emitTurnUsage({ sessionId, messageId: resultMessageId, turnUsage: result });
    const logLine = `[TurnUsage] session ${sessionId} message ${resultMessageId} trace ${trace.traceId}:`
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
    mediaTaskIds: string[],
  ): Promise<CoworkTurnUsage | null> {
    if (!this.deps.hasAuthTokens()) {
      console.warn(`[TurnUsage] cannot fetch trace ${trace.traceId}: not signed in.`);
      return null;
    }
    const summaries: unknown[] = [];
    for (const [index, traceId] of getCoworkLlmTraceIds(trace).entries()) {
      // Media costs are keyed by task, not trace; add them once.
      const summary = await this.fetchTraceSummary(traceId, trace.startedAt, index === 0 ? mediaTaskIds : []);
      if (!summary) return null;
      summaries.push(summary.data);
    }
    const usage = buildCoworkTurnUsage(mergeLlmTraceUsageSummaries(trace.traceId, summaries), {
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
  }

  private async fetchTraceSummary(
    traceId: string,
    startedAt: number,
    mediaTaskIds: string[],
  ): Promise<{ data: unknown } | null> {
    const params = new URLSearchParams({ since: String(Math.floor(startedAt)) });
    if (mediaTaskIds.length > 0) params.set('mediaTaskIds', mediaTaskIds.join(','));
    const url = this.deps.buildServerUrl(`${LLM_TRACE_USAGE_API_PATH}/${traceId}?${params}`);
    try {
      const response = await this.deps.fetchWithAuth(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      });
      const body = await response.json() as { code?: number; message?: string; data?: unknown };
      if (!response.ok || body.code !== 0) {
        console.warn(
          `[TurnUsage] summary request for trace ${traceId} failed: http=${response.status} code=${body.code ?? 'none'}.`,
        );
        return null;
      }
      return { data: body.data };
    } catch (error) {
      console.warn(`[TurnUsage] summary request for trace ${traceId} errored.`, error);
      return null;
    }
  }

  private getTurnTraceStats(trace: CoworkLlmTrace): TurnTraceStats | null {
    let total: TurnTraceStats | null = null;
    for (const traceId of getCoworkLlmTraceIds(trace)) {
      const stats = this.deps.getTraceStats(traceId);
      if (!stats) continue;
      total = {
        requests: (total?.requests ?? 0) + stats.requests,
        completed: (total?.completed ?? 0) + stats.completed,
      };
    }
    return total;
  }

  /** Returns the id of the message that now holds the usage. */
  private persist(sessionId: string, messageId: string, turnUsage: CoworkTurnUsage): string | null {
    const store = this.deps.getStore();
    // Re-read so a metadata write made while the request was in flight is kept.
    // IM history sync can replace the message meanwhile; its copy keeps the trace.
    let latest = store.getMessage(sessionId, messageId);
    if (!latest) {
      const candidate = store.getLatestUserMessage(sessionId);
      latest = getCoworkLlmTrace(candidate?.metadata)?.traceId === turnUsage.traceId ? candidate : null;
    }
    if (!latest) return null;
    store.updateMessage(sessionId, latest.id, {
      metadata: { ...(latest.metadata ?? {}), turnUsage } as CoworkMessageMetadata,
    });
    return latest.id;
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
