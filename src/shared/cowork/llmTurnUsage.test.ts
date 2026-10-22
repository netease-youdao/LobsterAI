import { describe, expect, test } from 'vitest';

import {
  buildCoworkTurnUsage,
  CoworkTurnUsageBillingScope,
  CoworkTurnUsageStatus,
  formatLlmTraceparent,
  getCoworkLlmTrace,
  getCoworkLlmTraceIds,
  getCoworkTurnUsage,
  isValidLlmTraceId,
  mergeLlmTraceUsageSummaries,
  parseLlmTraceparent,
  TurnUsageModelType,
  TurnUsagePricingPeriod,
} from './llmTurnUsage';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

describe('traceparent', () => {
  test('round-trips a W3C traceparent', () => {
    const header = formatLlmTraceparent(TRACE_ID, SPAN_ID);

    expect(header).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
    expect(parseLlmTraceparent(header)).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID });
  });

  test('normalizes case and accepts future versions with extra fields', () => {
    expect(parseLlmTraceparent(` 00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01 `))
      .toEqual({ traceId: TRACE_ID, spanId: SPAN_ID });
    expect(parseLlmTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01-extra`))
      .toEqual({ traceId: TRACE_ID, spanId: SPAN_ID });
  });

  test.each([
    undefined,
    '',
    `ff-${TRACE_ID}-${SPAN_ID}-01`,
    `00-${'0'.repeat(32)}-${SPAN_ID}-01`,
    `00-${TRACE_ID}-${'0'.repeat(16)}-01`,
    `00-${TRACE_ID}-${SPAN_ID}-01-extra`,
    `00-${TRACE_ID}-${SPAN_ID}`,
    `00-${TRACE_ID}-${SPAN_ID}-01${'0'.repeat(200)}`,
  ])('rejects malformed traceparent %s', (value) => {
    expect(parseLlmTraceparent(value)).toBeNull();
  });

  test('validates trace ids', () => {
    expect(isValidLlmTraceId(TRACE_ID)).toBe(true);
    expect(isValidLlmTraceId(TRACE_ID.toUpperCase())).toBe(false);
    expect(isValidLlmTraceId('0'.repeat(32))).toBe(false);
    expect(isValidLlmTraceId(42)).toBe(false);
  });
});

describe('message metadata accessors', () => {
  test('reads a stored turn trace', () => {
    expect(getCoworkLlmTrace({ llmTrace: { traceId: TRACE_ID, startedAt: 1_000 } }))
      .toEqual({ traceId: TRACE_ID, startedAt: 1_000 });
    expect(getCoworkLlmTrace({ llmTrace: { traceId: 'bad', startedAt: 1_000 } })).toBeNull();
    expect(getCoworkLlmTrace({ llmTrace: { traceId: TRACE_ID } })).toBeNull();
    expect(getCoworkLlmTrace(undefined)).toBeNull();
  });

  test('reads related traces of a multi-attempt run without duplicates or invalid ids', () => {
    const related = '11112222333344445555666677778888';
    const trace = getCoworkLlmTrace({
      llmTrace: { traceId: TRACE_ID, startedAt: 1_000, relatedTraceIds: [related, TRACE_ID, 'bad', related] },
    });

    expect(trace).toEqual({ traceId: TRACE_ID, startedAt: 1_000, relatedTraceIds: [related] });
    expect(getCoworkLlmTraceIds(trace!)).toEqual([TRACE_ID, related]);
    expect(getCoworkLlmTrace({ llmTrace: { traceId: TRACE_ID, startedAt: 1_000, relatedTraceIds: 'x' } }))
      .toEqual({ traceId: TRACE_ID, startedAt: 1_000 });
  });

  test('reads a stored turn usage only with a known status', () => {
    const usage = { traceId: TRACE_ID, status: CoworkTurnUsageStatus.Settled };
    expect(getCoworkTurnUsage({ turnUsage: usage })).toBe(usage);
    expect(getCoworkTurnUsage({ turnUsage: { ...usage, status: 'unknown' } })).toBeNull();
    expect(getCoworkTurnUsage({ turnUsage: { ...usage, traceId: 'bad' } })).toBeNull();
    expect(getCoworkTurnUsage({})).toBeNull();
  });
});

describe('buildCoworkTurnUsage', () => {
  const summary = {
    traceId: TRACE_ID,
    billingScope: 'personal',
    requestCount: 6,
    failedRequestCount: 1,
    models: ['deepseek-v4.1-flash', ''],
    creditsUsed: 12.5,
    uncachedInputTokens: 3_659,
    cacheReadTokens: 1_152_640,
    cacheWriteTokens: 0,
    inputTokens: 999,
    outputTokens: 7_508,
    totalTokens: 999,
  };

  test('derives input and grand totals from their parts', () => {
    const usage = buildCoworkTurnUsage(summary, { traceId: TRACE_ID, observedCompletedRequests: 6, now: 5_000 });

    expect(usage).toEqual({
      traceId: TRACE_ID,
      status: CoworkTurnUsageStatus.Settled,
      billingScope: CoworkTurnUsageBillingScope.Personal,
      requestCount: 6,
      failedRequestCount: 1,
      models: ['deepseek-v4.1-flash'],
      creditsUsed: 12.5,
      uncachedInputTokens: 3_659,
      cacheReadTokens: 1_152_640,
      cacheWriteTokens: 0,
      inputTokens: 1_156_299,
      outputTokens: 7_508,
      totalTokens: 1_163_807,
      observedCompletedRequests: 6,
      updatedAt: 5_000,
    });
  });

  test('marks the summary partial when the ledger lags the client', () => {
    expect(buildCoworkTurnUsage(summary, { traceId: TRACE_ID, observedCompletedRequests: 7, now: 1 })?.status)
      .toBe(CoworkTurnUsageStatus.Partial);
    expect(buildCoworkTurnUsage(summary, { traceId: TRACE_ID, now: 1 })?.status)
      .toBe(CoworkTurnUsageStatus.Settled);
  });

  test('reads enterprise scope and decimal strings, clamps invalid numbers', () => {
    const usage = buildCoworkTurnUsage(
      { ...summary, billingScope: 'enterprise', creditsUsed: '3.25', outputTokens: -5, failedRequestCount: 99 },
      { traceId: TRACE_ID, now: 1 },
    );

    expect(usage?.billingScope).toBe(CoworkTurnUsageBillingScope.Enterprise);
    expect(usage?.creditsUsed).toBe(3.25);
    expect(usage?.outputTokens).toBe(0);
    expect(usage?.failedRequestCount).toBe(6);
  });

  test('rejects a summary for another trace or a non-object', () => {
    expect(buildCoworkTurnUsage({ ...summary, traceId: '11112222333344445555666677778888' }, {
      traceId: TRACE_ID,
      now: 1,
    })).toBeNull();
    expect(buildCoworkTurnUsage(null, { traceId: TRACE_ID, now: 1 })).toBeNull();
  });

  test('keeps rounded display totals separate from original ledger charges', () => {
    const result = buildCoworkTurnUsage({
      ...summary,
      creditsUsed: '607.203752',
      displayCreditsUsed: '607.21',
      modelUsage: [{
        type: TurnUsageModelType.Text, model: 'deepseek-flash', count: 3,
        creditsUsed: '7.203752', displayCreditsUsed: '7.21',
      }, {
        type: TurnUsageModelType.Video, model: 'HappyHorse-1.1', count: 1,
        creditsUsed: '600', displayCreditsUsed: '600.00',
      }],
    }, { traceId: TRACE_ID, now: 1 });
    expect(result?.creditsUsed).toBe(607.203752);
    expect(result?.displayCreditsUsed).toBe(607.21);
    expect(result?.modelUsage?.map(model => model.creditsUsed)).toEqual([7.203752, 600]);
    expect(result?.modelUsage?.map(model => model.displayCreditsUsed)).toEqual([7.21, 600]);
  });

  test.each([undefined, null, '', ' ', 'invalid', -1, Number.NaN, Infinity])(
    'ignores absent or invalid display totals: %s', (displayCreditsUsed) => {
      const result = buildCoworkTurnUsage({
        ...summary, displayCreditsUsed,
        modelUsage: [{ type: TurnUsageModelType.Text, creditsUsed: 12.5, displayCreditsUsed }],
      }, { traceId: TRACE_ID, now: 1 });
      expect(result?.displayCreditsUsed).toBeUndefined();
      expect(result?.modelUsage?.[0].displayCreditsUsed).toBeUndefined();
      expect(result?.creditsUsed).toBe(12.5);
    },
  );

  test('preserves zero as an explicitly supplied display total', () => {
    const result = buildCoworkTurnUsage({ ...summary, creditsUsed: 0.004, displayCreditsUsed: 0 }, {
      traceId: TRACE_ID, now: 1,
    });
    expect(result?.displayCreditsUsed).toBe(0);
    expect(result?.creditsUsed).toBe(0.004);
  });
});

describe('mergeLlmTraceUsageSummaries', () => {
  const RELATED_TRACE_ID = '11112222333344445555666677778888';

  test('returns a single summary unchanged', () => {
    const summary = { traceId: TRACE_ID, creditsUsed: 1 };
    expect(mergeLlmTraceUsageSummaries(TRACE_ID, [summary])).toBe(summary);
  });

  test('sums the attempts of a run into one summary of the primary trace', () => {
    const merged = mergeLlmTraceUsageSummaries(TRACE_ID, [{
      traceId: TRACE_ID,
      billingScope: 'enterprise',
      requestCount: 2,
      failedRequestCount: 1,
      models: ['deepseek-flash'],
      creditsUsed: '1.5',
      displayCreditsUsed: '1.6',
      uncachedInputTokens: 10,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      outputTokens: 5,
      modelUsage: [{
        type: TurnUsageModelType.Text, model: 'deepseek-flash', count: 2, creditsUsed: 1.5, displayCreditsUsed: 1.6,
        uncachedInputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 5,
        tokenCreditEstimate: {
          uncachedInput: 0.5, cacheRead: 0.5, cacheWrite: 0, output: 0.5, cacheSavings: 1,
          pricingPeriod: TurnUsagePricingPeriod.Peak,
        },
      }],
    }, {
      traceId: RELATED_TRACE_ID,
      billingScope: 'enterprise',
      requestCount: 1,
      failedRequestCount: 0,
      models: ['deepseek-flash', 'glm-5'],
      creditsUsed: 2,
      uncachedInputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 4,
      outputTokens: 6,
      mediaPending: true,
      modelUsage: [{
        type: TurnUsageModelType.Text, model: 'deepseek-flash', count: 1, creditsUsed: 2,
        uncachedInputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 4, outputTokens: 6,
        tokenCreditEstimate: {
          uncachedInput: 1, cacheRead: 0, cacheWrite: 0.5, output: 0.5, cacheSavings: -0.25,
          pricingPeriod: TurnUsagePricingPeriod.OffPeak,
        },
      }, {
        type: TurnUsageModelType.Image, model: 'seedream', count: 1, creditsUsed: 0,
      }],
    }]);

    const usage = buildCoworkTurnUsage(merged, { traceId: TRACE_ID, observedCompletedRequests: 3, now: 1 });

    expect(usage).toMatchObject({
      traceId: TRACE_ID,
      status: CoworkTurnUsageStatus.Partial,
      billingScope: CoworkTurnUsageBillingScope.Enterprise,
      requestCount: 3,
      failedRequestCount: 1,
      models: ['deepseek-flash', 'glm-5'],
      creditsUsed: 3.5,
      displayCreditsUsed: 3.6,
      uncachedInputTokens: 30,
      cacheReadTokens: 100,
      cacheWriteTokens: 4,
      inputTokens: 134,
      outputTokens: 11,
      mediaPending: true,
    });
    expect(usage?.modelUsage).toEqual([{
      type: TurnUsageModelType.Text,
      model: 'deepseek-flash',
      count: 3,
      creditsUsed: 3.5,
      displayCreditsUsed: 3.6,
      uncachedInputTokens: 30,
      cacheReadTokens: 100,
      cacheWriteTokens: 4,
      outputTokens: 11,
      tokenCreditEstimate: {
        uncachedInput: 1.5, cacheRead: 0.5, cacheWrite: 0.5, output: 1, cacheSavings: 0.75,
        pricingPeriod: TurnUsagePricingPeriod.Mixed,
      },
    }, {
      type: TurnUsageModelType.Image,
      model: 'seedream',
      count: 1,
      creditsUsed: 0,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    }]);
  });

  test('omits a model estimate that only some attempts provided', () => {
    const row = { type: TurnUsageModelType.Text, model: 'm', count: 1, creditsUsed: 1 };
    const merged = mergeLlmTraceUsageSummaries(TRACE_ID, [
      { modelUsage: [{ ...row, tokenCreditEstimate: { uncachedInput: 1 } }] },
      { modelUsage: [row] },
    ]);

    expect(buildCoworkTurnUsage(merged, { traceId: TRACE_ID, now: 1 })?.modelUsage?.[0].tokenCreditEstimate)
      .toBeUndefined();
  });
});
