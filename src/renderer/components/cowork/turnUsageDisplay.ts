import {
  type CoworkTurnUsage,
  CoworkTurnUsageBillingScope,
  CoworkTurnUsageStatus,
} from '../../../shared/cowork/llmTurnUsage';

export const TurnUsageTokenRowKey = {
  UncachedInput: 'uncachedInput',
  CacheRead: 'cacheRead',
  CacheWrite: 'cacheWrite',
  Output: 'output',
  Total: 'total',
} as const;
export type TurnUsageTokenRowKey = typeof TurnUsageTokenRowKey[keyof typeof TurnUsageTokenRowKey];

export type TurnUsageTokenRow = {
  key: TurnUsageTokenRowKey;
  labelKey: string;
  tokens: number;
};

export const TurnUsageChipState = {
  Pending: 'pending',
  Failed: 'failed',
  Ready: 'ready',
} as const;
export type TurnUsageChipState = typeof TurnUsageChipState[keyof typeof TurnUsageChipState];

const numberFormatter = new Intl.NumberFormat('en-US');
const creditsFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** Credits with at most two decimals; a non-zero amount never reads as 0. */
export const formatTurnCredits = (credits: number): string => {
  if (!Number.isFinite(credits) || credits <= 0) return '0';
  if (credits < 0.01) return '<0.01';
  return creditsFormatter.format(credits);
};

/** A partial summary is a lower bound: some requests are not in the ledger yet. */
export const formatTurnUsageCredits = (usage: Pick<CoworkTurnUsage, 'creditsUsed' | 'status'>): string => {
  const credits = formatTurnCredits(usage.creditsUsed);
  return usage.status === CoworkTurnUsageStatus.Partial ? `≥${credits}` : credits;
};

export const formatTurnTokens = (tokens: number): string => (
  `${numberFormatter.format(Math.max(0, Math.floor(tokens)))} tok`
);

/** Share of the input served from the prompt cache; null when the turn had no input. */
export const getTurnCacheHitRate = (usage: Pick<CoworkTurnUsage, 'cacheReadTokens' | 'inputTokens'>): number | null => (
  usage.inputTokens > 0 ? usage.cacheReadTokens / usage.inputTokens : null
);

export const formatTurnCacheHitRate = (rate: number | null): string => {
  if (rate === null) return '—';
  const percent = rate * 100;
  // Keep a partial hit from rounding to 0% or 100%.
  if (percent > 0 && percent < 0.1) return '<0.1%';
  if (percent < 100 && percent > 99.9) return '>99.9%';
  return `${percent.toFixed(1).replace(/\.0$/, '')}%`;
};

/**
 * Token rows in reading order: the input parts, then output, then the total,
 * so the rows above the total add up to it. Cache writes are shown only when
 * the models reported them.
 */
export const buildTurnUsageTokenRows = (usage: CoworkTurnUsage): TurnUsageTokenRow[] => {
  const rows: TurnUsageTokenRow[] = [
    { key: TurnUsageTokenRowKey.UncachedInput, labelKey: 'coworkTurnUsageUncachedInput', tokens: usage.uncachedInputTokens },
    { key: TurnUsageTokenRowKey.CacheRead, labelKey: 'coworkTurnUsageCacheRead', tokens: usage.cacheReadTokens },
  ];
  if (usage.cacheWriteTokens > 0) {
    rows.push({ key: TurnUsageTokenRowKey.CacheWrite, labelKey: 'coworkTurnUsageCacheWrite', tokens: usage.cacheWriteTokens });
  }
  rows.push(
    { key: TurnUsageTokenRowKey.Output, labelKey: 'coworkTurnUsageOutput', tokens: usage.outputTokens },
    { key: TurnUsageTokenRowKey.Total, labelKey: 'coworkTurnUsageTotalTokens', tokens: usage.totalTokens },
  );
  return rows;
};

export const getTurnUsageChipState = (usage: CoworkTurnUsage): TurnUsageChipState => {
  if (usage.status === CoworkTurnUsageStatus.Pending) return TurnUsageChipState.Pending;
  if (usage.status === CoworkTurnUsageStatus.Failed) return TurnUsageChipState.Failed;
  return TurnUsageChipState.Ready;
};

export const getTurnCreditsLabelKey = (usage: CoworkTurnUsage): string => (
  usage.billingScope === CoworkTurnUsageBillingScope.Enterprise
    ? 'coworkTurnUsageTeamCredits'
    : 'coworkTurnUsageCredits'
);

/** 4bf92f35…0e4736: enough to recognize, the copy button carries the full id. */
export const shortenTraceId = (traceId: string): string => (
  traceId.length > 16 ? `${traceId.slice(0, 8)}…${traceId.slice(-6)}` : traceId
);
