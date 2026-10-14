import { describe, expect, test } from 'vitest';

import {
  buildCoworkTurnUsage,
  CoworkTurnUsageBillingScope,
  CoworkTurnUsageStatus,
  formatLlmTraceparent,
  getCoworkLlmTrace,
  getCoworkTurnUsage,
  isValidLlmTraceId,
  parseLlmTraceparent,
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
});
