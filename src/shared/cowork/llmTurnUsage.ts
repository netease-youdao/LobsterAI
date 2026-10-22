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
/**
 * Local token proxy route where the model-routing plugin reports the trace of
 * each run OpenClaw starts itself (IM, cron). Mirrored in that plugin.
 */
export const NATIVE_RUN_LLM_TRACE_PROXY_PATH = '/lobsterai/native-run-llm-traces';

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

/**
 * Stored on the turn's user message: by the client when it starts the turn,
 * or when an IM/cron run that OpenClaw started finishes.
 */
export interface CoworkLlmTrace {
  traceId: string;
  /** Turn start (epoch ms); bounds the server ledger lookup window. */
  startedAt: number;
  /**
   * More traces of the same turn. OpenClaw gives each attempt of a cron run
   * its own trace, so a retried run spans several.
   */
  relatedTraceIds?: string[];
}

export const TurnUsageModelType = {
  Text: 'text',
  Image: 'image',
  Video: 'video',
} as const;
export type TurnUsageModelType = typeof TurnUsageModelType[keyof typeof TurnUsageModelType];

export const TurnUsagePricingPeriod = {
  Peak: 'peak',
  OffPeak: 'off_peak',
  Mixed: 'mixed',
} as const;
export type TurnUsagePricingPeriod = typeof TurnUsagePricingPeriod[keyof typeof TurnUsagePricingPeriod];

export interface TurnTokenCreditEstimate {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Theoretical uncached input/output cost minus actual text ledger charges; may be negative. */
  cacheSavings: number;
  pricingPeriod?: TurnUsagePricingPeriod;
}

export interface TurnModelUsage {
  type: TurnUsageModelType;
  model: string;
  count: number;
  creditsUsed: number;
  /** Sum of individually rounded ledger entries, when provided by the server. */
  displayCreditsUsed?: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  tokenCreditEstimate?: TurnTokenCreditEstimate;
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
  /** Display total from per-entry rounding; does not replace actual ledger charges. */
  displayCreditsUsed?: number;
  /** Absent for summaries saved by older clients/servers. */
  modelUsage?: TurnModelUsage[];
  mediaPending?: boolean;
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
  const { traceId, startedAt, relatedTraceIds } = trace as {
    traceId?: unknown;
    startedAt?: unknown;
    relatedTraceIds?: unknown;
  };
  if (!isValidLlmTraceId(traceId) || typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
    return null;
  }
  const related = Array.isArray(relatedTraceIds)
    ? [...new Set(relatedTraceIds.filter(isValidLlmTraceId))].filter(id => id !== traceId)
    : [];
  return { traceId, startedAt, ...(related.length > 0 ? { relatedTraceIds: related } : {}) };
};

/** Every trace of a turn, the primary one first. */
export const getCoworkLlmTraceIds = (trace: CoworkLlmTrace): string[] => (
  [trace.traceId, ...(trace.relatedTraceIds ?? [])]
);

const toCount = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
);

const toSignedCredits = (value: unknown): number => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
};

const toCredits = (value: unknown): number => Math.max(0, toSignedCredits(value));

const toOptionalCredits = (value: unknown): number | undefined => {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const parseModelUsage = (value: unknown): TurnModelUsage[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry): TurnModelUsage[] => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    if (!Object.values(TurnUsageModelType).includes(row.type as TurnUsageModelType)) return [];
    const estimate = row.tokenCreditEstimate && typeof row.tokenCreditEstimate === 'object'
      ? row.tokenCreditEstimate as Record<string, unknown> : null;
    const displayCreditsUsed = toOptionalCredits(row.displayCreditsUsed);
    return [{
      type: row.type as TurnUsageModelType,
      model: typeof row.model === 'string' ? row.model : '',
      count: toCount(row.count),
      creditsUsed: toCredits(row.creditsUsed),
      ...(displayCreditsUsed !== undefined ? { displayCreditsUsed } : {}),
      uncachedInputTokens: toCount(row.uncachedInputTokens),
      cacheReadTokens: toCount(row.cacheReadTokens),
      cacheWriteTokens: toCount(row.cacheWriteTokens),
      outputTokens: toCount(row.outputTokens),
      ...(estimate ? { tokenCreditEstimate: {
        uncachedInput: toCredits(estimate.uncachedInput),
        cacheRead: toCredits(estimate.cacheRead),
        cacheWrite: toCredits(estimate.cacheWrite),
        output: toCredits(estimate.output),
        cacheSavings: toSignedCredits(estimate.cacheSavings),
        ...(Object.values(TurnUsagePricingPeriod).includes(estimate.pricingPeriod as TurnUsagePricingPeriod)
          ? { pricingPeriod: estimate.pricingPeriod as TurnUsagePricingPeriod } : {}),
      } } : {}),
    }];
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const SUMMARY_COUNT_FIELDS = [
  'requestCount', 'failedRequestCount', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens',
] as const;
const MODEL_USAGE_COUNT_FIELDS = [
  'count', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens',
] as const;
const TOKEN_ESTIMATE_CREDIT_FIELDS = ['uncachedInput', 'cacheRead', 'cacheWrite', 'output'] as const;

const sumField = (
  rows: Record<string, unknown>[],
  field: string,
  read: (value: unknown) => number,
): number => rows.reduce((total, row) => total + read(row[field]), 0);

const sumFields = (
  rows: Record<string, unknown>[],
  fields: readonly string[],
  read: (value: unknown) => number,
): Record<string, number> => Object.fromEntries(fields.map(field => [field, sumField(rows, field, read)]));

/** Rows without a display total contribute their actual credits. */
const mergeDisplayCredits = (rows: Record<string, unknown>[]): { displayCreditsUsed?: number } => (
  rows.some(row => toOptionalCredits(row.displayCreditsUsed) !== undefined)
    ? {
      displayCreditsUsed: rows.reduce(
        (total, row) => total + (toOptionalCredits(row.displayCreditsUsed) ?? toCredits(row.creditsUsed)),
        0,
      ),
    }
    : {}
);

const mergeModelUsageRows = (rows: Record<string, unknown>[]): Record<string, unknown>[] => {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = `${String(row.type)}\x1f${String(row.model)}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()].map((group) => {
    const estimates = group.map(row => row.tokenCreditEstimate).filter(isRecord);
    const periods = new Set(estimates.map(estimate => estimate.pricingPeriod));
    return {
      type: group[0].type,
      model: group[0].model,
      ...sumFields(group, MODEL_USAGE_COUNT_FIELDS, toCount),
      creditsUsed: sumField(group, 'creditsUsed', toCredits),
      ...mergeDisplayCredits(group),
      // A partial estimate would not add up to the row's credits.
      ...(estimates.length === group.length ? {
        tokenCreditEstimate: {
          ...sumFields(estimates, TOKEN_ESTIMATE_CREDIT_FIELDS, toCredits),
          cacheSavings: sumField(estimates, 'cacheSavings', toSignedCredits),
          pricingPeriod: periods.size === 1 ? estimates[0].pricingPeriod : TurnUsagePricingPeriod.Mixed,
        },
      } : {}),
    };
  });
};

/**
 * Combines the server summaries of a turn that spans several traces into one
 * summary of the primary trace. A single summary is returned unchanged.
 */
export const mergeLlmTraceUsageSummaries = (traceId: string, summaries: unknown[]): unknown => {
  if (summaries.length === 1) return summaries[0];
  const rows = summaries.filter(isRecord);
  if (rows.length === 0) return null;
  return {
    traceId,
    billingScope: rows[0].billingScope,
    ...sumFields(rows, SUMMARY_COUNT_FIELDS, toCount),
    models: [...new Set(rows.flatMap(row => (Array.isArray(row.models) ? row.models : [])))],
    creditsUsed: sumField(rows, 'creditsUsed', toCredits),
    ...mergeDisplayCredits(rows),
    ...(rows.some(row => Array.isArray(row.modelUsage)) ? {
      modelUsage: mergeModelUsageRows(
        rows.flatMap(row => (Array.isArray(row.modelUsage) ? row.modelUsage.filter(isRecord) : [])),
      ),
    } : {}),
    ...(rows.some(row => row.mediaPending === true) ? { mediaPending: true } : {}),
  };
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
  const displayCreditsUsed = toOptionalCredits(raw.displayCreditsUsed);
  const observed = options.observedCompletedRequests;
  const billingScope = raw.billingScope === CoworkTurnUsageBillingScope.Enterprise
    ? CoworkTurnUsageBillingScope.Enterprise
    : CoworkTurnUsageBillingScope.Personal;
  return {
    traceId: options.traceId,
    status: raw.mediaPending === true || (typeof observed === 'number' && requestCount < observed)
      ? CoworkTurnUsageStatus.Partial
      : CoworkTurnUsageStatus.Settled,
    billingScope,
    requestCount,
    failedRequestCount: Math.min(toCount(raw.failedRequestCount), requestCount),
    models: Array.isArray(raw.models)
      ? raw.models.filter((model): model is string => typeof model === 'string' && model.trim().length > 0)
      : [],
    creditsUsed: toCredits(raw.creditsUsed),
    ...(displayCreditsUsed !== undefined ? { displayCreditsUsed } : {}),
    ...(Array.isArray(raw.modelUsage) ? { modelUsage: parseModelUsage(raw.modelUsage) } : {}),
    ...(raw.mediaPending === true ? { mediaPending: true } : {}),
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
