import { describe, expect, test } from 'vitest';

import {
  type CoworkTurnUsage,
  CoworkTurnUsageBillingScope,
  CoworkTurnUsageStatus,
  type TurnModelUsage,
  TurnUsageModelType,
} from '../../../shared/cowork/llmTurnUsage';
import {
  buildTurnModelTokenRows,
  buildTurnUsageTokenRows,
  formatTurnCacheHitRate,
  formatTurnCredits,
  formatTurnTokens,
  formatTurnUsageCredits,
  getTurnCacheHitRate,
  getTurnCreditsLabelKey,
  getTurnModelUsage,
  getTurnUsageChipState,
  shortenTraceId,
  TurnUsageChipState,
  TurnUsageTokenRowKey,
} from './turnUsageDisplay';

const usage = (overrides: Partial<CoworkTurnUsage> = {}): CoworkTurnUsage => ({
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  status: CoworkTurnUsageStatus.Settled,
  billingScope: CoworkTurnUsageBillingScope.Personal,
  requestCount: 6,
  failedRequestCount: 0,
  models: ['deepseek-v4.1-flash'],
  creditsUsed: 12.5,
  uncachedInputTokens: 3_659,
  cacheReadTokens: 1_152_640,
  cacheWriteTokens: 0,
  inputTokens: 1_156_299,
  outputTokens: 7_508,
  totalTokens: 1_163_807,
  updatedAt: 1,
  ...overrides,
});

describe('turn usage formatting', () => {
  test('formats credits with at most two decimals and never shows spent credits as zero', () => {
    expect(formatTurnCredits(12.5)).toBe('12.5');
    expect(formatTurnCredits(12.345)).toBe('12.35');
    expect(formatTurnCredits(1234.5)).toBe('1,234.5');
    expect(formatTurnCredits(0.004)).toBe('<0.01');
    expect(formatTurnCredits(0)).toBe('0');
    expect(formatTurnCredits(Number.NaN)).toBe('0');
  });

  test('marks a partial total as a lower bound', () => {
    expect(formatTurnUsageCredits(usage({ status: CoworkTurnUsageStatus.Partial }))).toBe('≥12.5');
    expect(formatTurnUsageCredits(usage())).toBe('12.5');
  });

  test('formats tokens with separators', () => {
    expect(formatTurnTokens(1_163_807)).toBe('1,163,807 tok');
    expect(formatTurnTokens(-3)).toBe('0 tok');
  });

  test('computes the cache hit rate from cache reads over all input', () => {
    expect(formatTurnCacheHitRate(getTurnCacheHitRate(usage()))).toBe('99.7%');
    expect(formatTurnCacheHitRate(getTurnCacheHitRate(usage({ cacheReadTokens: 500, inputTokens: 1_000 })))).toBe('50%');
    expect(formatTurnCacheHitRate(getTurnCacheHitRate(usage({ inputTokens: 0, cacheReadTokens: 0 })))).toBe('—');
    expect(formatTurnCacheHitRate(0.0004)).toBe('<0.1%');
    expect(formatTurnCacheHitRate(0.99996)).toBe('>99.9%');
    expect(formatTurnCacheHitRate(1)).toBe('100%');
  });

  test('shortens the trace id for display', () => {
    expect(shortenTraceId('4bf92f3577b34da6a3ce929d0e0e4736')).toBe('4bf92f35…0e4736');
  });
});

describe('turn usage rows', () => {
  test('lists input parts, output and a total that equals their sum', () => {
    const rows = buildTurnUsageTokenRows(usage());

    expect(rows.map(row => row.key)).toEqual([
      TurnUsageTokenRowKey.UncachedInput,
      TurnUsageTokenRowKey.CacheRead,
      TurnUsageTokenRowKey.Output,
      TurnUsageTokenRowKey.Total,
    ]);
    const total = rows.pop();
    expect(rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(total?.tokens);
  });

  test('shows cache writes only when the models reported them', () => {
    const rows = buildTurnUsageTokenRows(usage({ cacheWriteTokens: 40, inputTokens: 1_156_339, totalTokens: 1_163_847 }));

    expect(rows.map(row => row.key)).toContain(TurnUsageTokenRowKey.CacheWrite);
    const total = rows.pop();
    expect(rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(total?.tokens);
  });
});

describe('turn ledger display totals', () => {
  const model = (overrides: Partial<TurnModelUsage> = {}): TurnModelUsage => ({
    type: TurnUsageModelType.Text,
    model: 'deepseek-flash',
    count: 3,
    creditsUsed: 7.203752,
    uncachedInputTokens: 67050,
    cacheReadTokens: 139776,
    cacheWriteTokens: 0,
    outputTokens: 548,
    tokenCreditEstimate: {
      uncachedInput: 6.705,
      cacheRead: 0.279552,
      cacheWrite: 0,
      output: 0.2192,
      cacheSavings: 13.698048,
    },
    ...overrides,
  });

  test('uses the sum of individually rounded ledger charges for the reported video turn', () => {
    const source = model({ displayCreditsUsed: 7.21 });
    const snapshot = structuredClone(source);
    const summary = usage({
      creditsUsed: 607.203752,
      displayCreditsUsed: 607.21,
      modelUsage: [source, model({
        type: TurnUsageModelType.Video, model: 'HappyHorse-1.1', creditsUsed: 600,
        displayCreditsUsed: 600, tokenCreditEstimate: undefined,
      })],
    });
    const rows = buildTurnModelTokenRows(source);

    expect(formatTurnUsageCredits(summary, true)).toBe('607.21');
    expect(formatTurnUsageCredits(summary)).toBe('607.21');
    expect(getTurnModelUsage(summary).map(item => formatTurnCredits(item.displayCreditsUsed ?? item.creditsUsed, true)))
      .toEqual(['600.00', '7.21']);
    expect(rows.map(row => formatTurnCredits(row.credits!, true))).toEqual(['6.71', '0.28', '0.22']);
    expect(rows.map(row => row.credits)).toEqual([6.705, 0.279552, 0.2192]);
    expect(source).toEqual(snapshot);
    expect(summary.creditsUsed).toBe(607.203752);
  });

  test('keeps server display totals even when token-price estimates differ', () => {
    const summary = usage({ creditsUsed: 7.203752, displayCreditsUsed: 8.02, modelUsage: [model({ displayCreditsUsed: 8.02 })] });
    expect(formatTurnUsageCredits(summary, true)).toBe('8.02');
    expect(getTurnModelUsage(summary)[0].displayCreditsUsed).toBe(8.02);
    expect(buildTurnModelTokenRows(model()).map(row => row.credits)).toEqual([6.705, 0.279552, 0.2192]);
  });

  test('marks partial display totals and preserves a valid zero display total', () => {
    expect(formatTurnUsageCredits(usage({
      creditsUsed: 7.203752, displayCreditsUsed: 7.21, status: CoworkTurnUsageStatus.Partial,
    }), true)).toBe('≥7.21');
    expect(formatTurnUsageCredits(usage({ creditsUsed: 0.004, displayCreditsUsed: 0 }), true)).toBe('0.00');
  });

  test('keeps legacy ledger totals until the server supplies per-entry display totals', () => {
    expect(formatTurnUsageCredits(usage({ creditsUsed: 7.203752 }), true)).toBe('7.20');
    expect(getTurnModelUsage(usage({ creditsUsed: 7.203752 }))[0].displayCreditsUsed).toBeUndefined();
    expect(getTurnModelUsage(usage({ creditsUsed: 7.203752, displayCreditsUsed: 7.21 }))[0].displayCreditsUsed).toBe(7.21);
  });

  test('does not invent charges when token estimates are absent', () => {
    expect(buildTurnModelTokenRows(model({ tokenCreditEstimate: undefined }))
      .every(row => row.credits === undefined)).toBe(true);
  });
});

describe('turn usage chip', () => {
  test('maps usage status to the chip state', () => {
    expect(getTurnUsageChipState(usage({ status: CoworkTurnUsageStatus.Pending }))).toBe(TurnUsageChipState.Pending);
    expect(getTurnUsageChipState(usage({ status: CoworkTurnUsageStatus.Failed }))).toBe(TurnUsageChipState.Failed);
    expect(getTurnUsageChipState(usage({ status: CoworkTurnUsageStatus.Partial }))).toBe(TurnUsageChipState.Ready);
    expect(getTurnUsageChipState(usage())).toBe(TurnUsageChipState.Ready);
  });

  test('labels team credits for enterprise turns', () => {
    expect(getTurnCreditsLabelKey(usage())).toBe('coworkTurnUsageCredits');
    expect(getTurnCreditsLabelKey(usage({ billingScope: CoworkTurnUsageBillingScope.Enterprise })))
      .toBe('coworkTurnUsageTeamCredits');
  });
});
