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
import type { CoworkStoppedTurn } from './agentEngine/types';
import type { NativeRunTurnUsage } from './nativeRunTurnUsage';

type TurnUsageStore = {
  getMessage(sessionId: string, messageId: string): CoworkMessage | null;
  getLatestUserMessage(sessionId: string): CoworkMessage | null;
  findUserMessageByTrace(traceId: string, sessionId?: string): { sessionId: string; message: CoworkMessage } | null;
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
  getSessionKey?: () => string | null;
  isTurnActive?: (sessionId: string, messageId: string) => boolean;
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
/** Cancellation can reach the ledger after the local stream has already closed. */
const STOPPED_TURN_RETRY_DELAYS_MS = [PARTIAL_RETRY_DELAY_MS, 3_000, 5_000];
/** Conversation tail searched for replies that follow the user message being bound. */
const BIND_REPLY_CHECK_LIMIT = 40;

type SettleMode = {
  /** Turn just finished: show a pending state and retry once if the ledger lags. */
  afterTurn: boolean;
  /** A newly finished request invalidates even an already running summary fetch. */
  afterRequest?: boolean;
  afterStop?: boolean;
};

type TurnUsageObservation = Pick<CoworkTurnUsage, 'observedCompletedRequests' | 'observedRequests'>;

/**
 * Settles the credits and token usage of a Cowork turn from the
 * lobsterai-server ledger and stores it on the turn's user message.
 */
export class CoworkTurnUsageService {
  private readonly inFlight = new Map<string, {
    promise: Promise<CoworkTurnUsage | null>;
    rerun: boolean;
    mode: SettleMode;
  }>();

  constructor(private readonly deps: CoworkTurnUsageServiceDeps) {}

  /** Runs when a turn completes or fails; turns without package-model requests are skipped. */
  async settleLatestTurn(sessionId: string, nativeRuns?: NativeTurnRuns): Promise<void> {
    if (nativeRuns?.runIds.length) this.bindNativeRunUsage(sessionId, nativeRuns);
    const message = this.deps.getStore().getLatestUserMessage(sessionId);
    await this.settleFinishedTurn(sessionId, message, { afterTurn: true });
  }

  async settleStoppedTurn(sessionId: string, turn?: CoworkStoppedTurn): Promise<void> {
    if (turn?.runIds.length) this.bindNativeRunUsage(sessionId, turn, turn.userMessageId);
    const store = this.deps.getStore();
    // A stop owns the original turn even if history sync replaced its message
    // or the user has already submitted the next prompt.
    let message = turn?.userMessageId ? store.getMessage(sessionId, turn.userMessageId)
      : store.getLatestUserMessage(sessionId);
    if (turn?.traceId && getCoworkLlmTrace(message?.metadata)?.traceId !== turn.traceId) {
      message = store.findUserMessageByTrace(turn.traceId, sessionId)?.message ?? null;
    }
    await this.settleFinishedTurn(sessionId, message, { afterTurn: true, afterStop: true });
  }

  private async settleFinishedTurn(
    sessionId: string, message: CoworkMessage | null | undefined, mode: SettleMode,
  ): Promise<void> {
    const trace = getCoworkLlmTrace(message?.metadata);
    if (!message || !trace) return;
    const stats = this.getTurnTraceStats(trace);
    if ((!stats || stats.requests === 0) && !message.metadata?.turnMediaTaskIds?.length) {
      console.debug(
        `[TurnUsage] skipped session ${sessionId}: trace ${trace.traceId} made no LobsterAI model requests.`,
      );
      return;
    }
    await this.settle(sessionId, message.id, mode);
  }

  /**
   * OpenClaw starts IM and cron runs itself, so their synced user message has
   * no client trace. Give it the traces and media tasks the runs reported.
   */
  private bindNativeRunUsage(sessionId: string, nativeRuns: NativeTurnRuns, userMessageId?: string): void {
    const usage = this.deps.claimNativeRunTurnUsage?.(nativeRuns.runIds);
    if (!usage) return;
    const store = this.deps.getStore();
    const message = userMessageId ? store.getMessage(sessionId, userMessageId) : store.getLatestUserMessage(sessionId);
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

  /** A background request can finish after a different user turn has started. */
  refreshExactTrace(origin: { traceId: string; sessionId: string; owner: string }): Promise<CoworkTurnUsage | null> {
    if (this.deps.getSessionKey?.() !== origin.owner) return Promise.resolve(null);
    const target = this.deps.getStore().findUserMessageByTrace(origin.traceId, origin.sessionId);
    if (!target) return Promise.resolve(null);
    // Foreground steps get one summary at turn end. An already settled turn
    // remains refreshable even while a heartbeat or the next turn is running.
    if (!getCoworkTurnUsage(target.message.metadata)
      && this.deps.isTurnActive?.(origin.sessionId, target.message.id)
      && !this.inFlight.has(JSON.stringify([origin.owner, origin.sessionId, origin.traceId]))) return Promise.resolve(null);
    return this.settle(origin.sessionId, target.message.id, { afterTurn: true, afterRequest: true }, origin.owner);
  }

  private settle(
    sessionId: string,
    messageId: string,
    mode: SettleMode,
    owner = this.deps.getSessionKey?.(),
  ): Promise<CoworkTurnUsage | null> {
    const trace = getCoworkLlmTrace(this.deps.getStore().getMessage(sessionId, messageId)?.metadata);
    if (!trace) return Promise.resolve(null);
    const key = JSON.stringify([owner, sessionId, trace.traceId]);
    const existing = this.inFlight.get(key);
    if (existing) {
      if (mode.afterRequest || mode.afterStop) {
        existing.rerun = true;
        existing.mode = { ...existing.mode, ...mode };
      }
      return existing.promise;
    }
    const state = { promise: Promise.resolve<CoworkTurnUsage | null>(null), rerun: false, mode };
    state.promise = (async () => {
      let result: CoworkTurnUsage | null;
      do {
        state.rerun = false;
        // Explicit manual refresh may target a fork copy. Only recovery of a
        // replaced message needs the stricter origin lookup used by callbacks.
        const store = this.deps.getStore();
        const original = store.getMessage(sessionId, messageId);
        const target = getCoworkLlmTrace(original?.metadata)?.traceId === trace.traceId ? original
          : store.findUserMessageByTrace(trace.traceId, sessionId)?.message;
        if (!target || this.deps.getSessionKey?.() !== owner) return null;
        result = await this.runSettle(sessionId, target.id, state.mode, owner);
      } while (state.rerun && this.deps.getSessionKey?.() === owner);
      return result;
    })().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, state);
    return state.promise;
  }

  private async runSettle(
    sessionId: string, messageId: string, mode: SettleMode, owner: string | null | undefined,
  ): Promise<CoworkTurnUsage | null> {
    const message = this.deps.getStore().getMessage(sessionId, messageId);
    const trace = getCoworkLlmTrace(message?.metadata);
    if (!message || message.type !== 'user' || !trace) return null;

    let previous = getCoworkTurnUsage(message.metadata);
    const stats = this.getTurnTraceStats(trace);
    const observedCompletedRequests = stats === null ? previous?.observedCompletedRequests
      : Math.max(stats.completed, previous?.observedCompletedRequests ?? 0);
    const observedRequests = mode.afterStop || previous?.observedRequests !== undefined
      ? Math.max(stats?.requests ?? 0, previous?.observedRequests ?? 0) : undefined;
    const observation: TurnUsageObservation = {
      ...(observedCompletedRequests !== undefined ? { observedCompletedRequests } : {}),
      ...(observedRequests !== undefined ? { observedRequests } : {}),
    };
    // Keep the stop's request count across reloads and late request callbacks.
    // A successful earlier request alone does not settle a cancelled stream.
    if (previous && observedRequests !== undefined) {
      previous = {
        ...previous,
        ...observation,
        status: previous.status === CoworkTurnUsageStatus.Settled && previous.requestCount < observedRequests
          ? CoworkTurnUsageStatus.Partial : previous.status,
      };
      this.persist(sessionId, messageId, previous);
      this.deps.emitTurnUsage({ sessionId, messageId, turnUsage: previous });
    }
    if (mode.afterTurn && !previous) {
      const pending = this.buildEmptyUsage(trace, CoworkTurnUsageStatus.Pending, observation);
      if (observedRequests !== undefined) this.persist(sessionId, messageId, pending);
      this.deps.emitTurnUsage({
        sessionId,
        messageId,
        turnUsage: pending,
      });
    }

    const mediaTaskIds = message.metadata?.turnMediaTaskIds ?? [];
    let usage = await this.fetchUsage(trace, observation, mediaTaskIds, owner);
    if (this.deps.getSessionKey?.() !== owner) return null;
    const retryDelays = mode.afterStop ? STOPPED_TURN_RETRY_DELAYS_MS : [PARTIAL_RETRY_DELAY_MS];
    for (const delay of mode.afterTurn ? retryDelays : []) {
      if (usage && usage.status !== CoworkTurnUsageStatus.Partial
        && !(mode.afterRequest && previous && usage.requestCount <= previous.requestCount)) break;
      if (mode.afterStop && usage && (!previous || usage.requestCount >= previous.requestCount)) {
        const resultMessageId = this.persist(sessionId, messageId, usage);
        if (!resultMessageId) return null;
        this.deps.emitTurnUsage({ sessionId, messageId: resultMessageId, turnUsage: usage });
      }
      await this.sleep(delay);
      if (this.deps.getSessionKey?.() !== owner) return null;
      const refreshed = await this.fetchUsage(trace, observation, mediaTaskIds, owner);
      if (refreshed && (!usage || refreshed.requestCount >= usage.requestCount)) usage = refreshed;
    }
    if (this.deps.getSessionKey?.() !== owner) return null;

    // Account switches and ledger delays must not replace a saved summary with fewer requests.
    const hasPreviousSummary = previous && previous.status !== CoworkTurnUsageStatus.Failed
      && previous.status !== CoworkTurnUsageStatus.Pending;
    if (hasPreviousSummary && usage && usage.requestCount < previous.requestCount) {
      usage = null;
    }
    const result = usage
      ?? (hasPreviousSummary ? previous : this.buildEmptyUsage(trace, CoworkTurnUsageStatus.Failed, observation));
    const resultMessageId = this.persist(sessionId, messageId, result);
    if (!resultMessageId) return null;
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
    observation: TurnUsageObservation,
    mediaTaskIds: string[],
    owner: string | null | undefined,
  ): Promise<CoworkTurnUsage | null> {
    if (!this.deps.hasAuthTokens()) {
      console.warn(`[TurnUsage] cannot fetch trace ${trace.traceId}: not signed in.`);
      return null;
    }
    const summaries: unknown[] = [];
    for (const [index, traceId] of getCoworkLlmTraceIds(trace).entries()) {
      if (this.deps.getSessionKey?.() !== owner) return null;
      // Media costs are keyed by task, not trace; add them once.
      const summary = await this.fetchTraceSummary(traceId, trace.startedAt, index === 0 ? mediaTaskIds : []);
      if (!summary) return null;
      summaries.push(summary.data);
    }
    const usage = buildCoworkTurnUsage(mergeLlmTraceUsageSummaries(trace.traceId, summaries), {
      traceId: trace.traceId,
      ...observation,
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
    const original = store.getMessage(sessionId, messageId);
    const latest = getCoworkLlmTrace(original?.metadata)?.traceId === turnUsage.traceId ? original
      : store.findUserMessageByTrace(turnUsage.traceId, sessionId)?.message;
    if (!latest) return null;
    if (getCoworkTurnUsage(latest.metadata) !== turnUsage) {
      store.updateMessage(sessionId, latest.id, {
        metadata: { ...(latest.metadata ?? {}), turnUsage } as CoworkMessageMetadata,
      });
    }
    return latest.id;
  }

  private buildEmptyUsage(
    trace: CoworkLlmTrace,
    status: CoworkTurnUsage['status'],
    observation: TurnUsageObservation,
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
      ...observation,
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
