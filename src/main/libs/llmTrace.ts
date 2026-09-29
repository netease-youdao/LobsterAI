import { randomBytes } from 'crypto';

import { type CoworkLlmTrace, formatLlmTraceparent } from '../../shared/cowork/llmTurnUsage';

export const createLlmTraceId = (): string => randomBytes(16).toString('hex');

export const createLlmSpanId = (): string => randomBytes(8).toString('hex');

/** Trace for one Cowork turn; every model request of the turn becomes a child span. */
export const createCoworkLlmTrace = (now = Date.now()): CoworkLlmTrace => ({
  traceId: createLlmTraceId(),
  startedAt: now,
});

/** traceparent for one gateway request that belongs to the trace. */
export const createLlmTraceparent = (traceId: string): string => (
  formatLlmTraceparent(traceId, createLlmSpanId())
);
