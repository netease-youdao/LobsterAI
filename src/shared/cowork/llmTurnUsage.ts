/**
 * Per-turn LLM usage (credits, tokens, request count) for LobsterAI package
 * models, and the W3C trace context that ties every model request of a turn
 * from the client logs to lobsterai-server logs and its usage ledger.
 */

/** W3C trace context header OpenClaw attaches to each model request. */
export const LLM_TRACEPARENT_HEADER = 'traceparent';
/** Server-side trace id echoed by lobsterai-server's proxy responses. */
export const LOBSTER_SERVER_TRACE_ID_HEADER = 'x-lobster-trace-id';
/** lobsterai-server endpoint that summarizes one turn's usage by trace id. */
export const LLM_TRACE_USAGE_API_PATH = '/api/usage/llm-traces';

export const CoworkTurnUsageStatus = {
  /** The turn finished and its summary is being fetched. */
  Pending: 'pending',
  /** The server ledger covers every request the client saw complete. */
  Settled: 'settled',
  /** The ledger has fewer requests than the client saw complete. */
  Partial: 'partial',
  /** The summary could not be fetched; the user can retry. */
  Failed: 'failed',
} as const;
export type CoworkTurnUsageStatus = typeof CoworkTurnUsageStatus[keyof typeof CoworkTurnUsageStatus];

export const CoworkTurnUsageBillingScope = {
  Personal: 'personal',
  Enterprise: 'enterprise',
} as const;
export type CoworkTurnUsageBillingScope =
  typeof CoworkTurnUsageBillingScope[keyof typeof CoworkTurnUsageBillingScope];

/** Stored on the turn's user message when the client starts the turn. */
export interface CoworkLlmTrace {
  traceId: string;
  /** Turn start (epoch ms); bounds the server ledger lookup window. */
  startedAt: number;
}

/** Stored on the turn's user message once the turn has finished. */
export interface CoworkTurnUsage {
  traceId: string;
  status: CoworkTurnUsageStatus;
  billingScope?: CoworkTurnUsageBillingScope;
  requestCount: number;
  failedRequestCount: number;
  models: string[];
  creditsUsed: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Model requests the local token proxy saw complete for this trace. */
  observedCompletedRequests?: number;
  updatedAt: number;
}

/** Usage belonging to a user message before the loaded history window. */
export interface CoworkTurnUsageAnchor {
  userMessageId: string;
  turnUsage: CoworkTurnUsage | null;
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const INVALID_TRACE_ID = '0'.repeat(32);
const INVALID_SPAN_ID = '0'.repeat(16);
const MAX_TRACEPARENT_LENGTH = 128;

export const isValidLlmTraceId = (value: unknown): value is string => (
  typeof value === 'string' && TRACE_ID_RE.test(value) && value !== INVALID_TRACE_ID
);

export const formatLlmTraceparent = (traceId: string, spanId: string): string => (
  `00-${traceId}-${spanId}-01`
);

export const parseLlmTraceparent = (
  value: unknown,
): { traceId: string; spanId: string } | null => {
  if (typeof value !== 'string' || value.length > MAX_TRACEPARENT_LENGTH) return null;
  const parts = value.trim().toLowerCase().split('-');
  if (parts.length < 4) return null;
  const [version, traceId, spanId] = parts;
  if (!/^[0-9a-f]{2}$/.test(version) || version === 'ff' || (version === '00' && parts.length !== 4)) {
    return null;
  }
  if (!isValidLlmTraceId(traceId) || !SPAN_ID_RE.test(spanId) || spanId === INVALID_SPAN_ID) {
    return null;
  }
  return { traceId, spanId };
};

export const getCoworkLlmTrace = (metadata: unknown): CoworkLlmTrace | null => {
  if (!metadata || typeof metadata !== 'object') return null;
  const trace = (metadata as { llmTrace?: unknown }).llmTrace;
  if (!trace || typeof trace !== 'object') return null;
  const { traceId, startedAt } = trace as { traceId?: unknown; startedAt?: unknown };
  if (!isValidLlmTraceId(traceId) || typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
    return null;
  }
  return { traceId, startedAt };
};

const toCount = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
);

const toCredits = (value: unknown): number => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

/**
 * Builds a turn usage record from the server summary. Token parts are
 * re-derived so that uncached + cache read + cache write always equals the
 * input total, and input + output always equals the grand total.
 */
export const buildCoworkTurnUsage = (
  summary: unknown,
  options: { traceId: string; observedCompletedRequests?: number; now: number },
): CoworkTurnUsage | null => {
  if (!summary || typeof summary !== 'object') return null;
  const raw = summary as Record<string, unknown>;
  if (typeof raw.traceId === 'string' && raw.traceId !== options.traceId) return null;
  const requestCount = toCount(raw.requestCount);
  const uncachedInputTokens = toCount(raw.uncachedInputTokens);
  const cacheReadTokens = toCount(raw.cacheReadTokens);
  const cacheWriteTokens = toCount(raw.cacheWriteTokens);
  const inputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
  const outputTokens = toCount(raw.outputTokens);
  const observed = options.observedCompletedRequests;
  const billingScope = raw.billingScope === CoworkTurnUsageBillingScope.Enterprise
    ? CoworkTurnUsageBillingScope.Enterprise
    : CoworkTurnUsageBillingScope.Personal;
  return {
    traceId: options.traceId,
    status: typeof observed === 'number' && requestCount < observed
      ? CoworkTurnUsageStatus.Partial
      : CoworkTurnUsageStatus.Settled,
    billingScope,
    requestCount,
    failedRequestCount: Math.min(toCount(raw.failedRequestCount), requestCount),
    models: Array.isArray(raw.models)
      ? raw.models.filter((model): model is string => typeof model === 'string' && model.trim().length > 0)
      : [],
    creditsUsed: toCredits(raw.creditsUsed),
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(typeof observed === 'number' ? { observedCompletedRequests: observed } : {}),
    updatedAt: options.now,
  };
};

export const getCoworkTurnUsage = (metadata: unknown): CoworkTurnUsage | null => {
  if (!metadata || typeof metadata !== 'object') return null;
  const usage = (metadata as { turnUsage?: unknown }).turnUsage;
  if (!usage || typeof usage !== 'object') return null;
  const candidate = usage as Partial<CoworkTurnUsage>;
  if (!isValidLlmTraceId(candidate.traceId)) return null;
  const statuses = Object.values(CoworkTurnUsageStatus) as string[];
  if (typeof candidate.status !== 'string' || !statuses.includes(candidate.status)) return null;
  return usage as CoworkTurnUsage;
};
