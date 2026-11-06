import { beforeEach, describe, expect, test } from 'vitest';

import { formatLlmTraceparent } from '../../shared/cowork/llmTurnUsage';
import { clearLlmUsageContexts, configureLlmUsageContextResolver, getLlmUsageHeaders, getMediaUsageContext, LlmUsageHeader, registerLlmUsageContext } from './llmUsageContext';

beforeEach(() => {
  clearLlmUsageContexts();
  configureLlmUsageContextResolver(undefined);
  return () => {
    clearLlmUsageContexts();
    configureLlmUsageContextResolver(undefined);
  };
});

test('recovers the exact evicted or reloaded origin and revalidates its account', () => {
  const traceId = 'a'.repeat(32);
  const traceparent = formatLlmTraceparent(traceId, 'b'.repeat(16));
  let owner = 'account-a:1';
  configureLlmUsageContextResolver((id, registration) => id === traceId ? {
    sessionId: 'original-session', userMessage: 'original prompt',
    owner: owner.startsWith('account-a:') ? owner : null,
  } : registration ?? null);
  registerLlmUsageContext(traceId, 'original-session', 'original prompt');
  for (let i = 1; i <= 513; i++) {
    registerLlmUsageContext(i.toString(16).padStart(32, '0'), 'other-session', 'other prompt');
  }
  expect(getLlmUsageHeaders(traceparent, undefined, owner)).toMatchObject({
    [LlmUsageHeader.Session]: 'original-session', [LlmUsageHeader.Turn]: traceId,
  });
  clearLlmUsageContexts();
  expect(getLlmUsageHeaders(traceparent, undefined, owner)[LlmUsageHeader.Session]).toBe('original-session');
  owner = 'account-b:2';
  expect(getLlmUsageHeaders(traceparent, undefined, owner)).toEqual({});
  owner = 'account-a:3';
  expect(getLlmUsageHeaders(traceparent, undefined, owner)[LlmUsageHeader.Session]).toBe('original-session');
});

describe('media turn attribution', () => {
  test('captures the exact user turn and bounded original input before async work', () => {
    const message = { content: '字'.repeat(250), metadata: { llmTrace: { traceId: 'a'.repeat(32), startedAt: 1000 } } };
    const context = getMediaUsageContext('session', message);
    message.metadata.llmTrace.traceId = 'b'.repeat(32);
    expect(context).toEqual({ sessionId: 'session', turnId: 'a'.repeat(32), userMessage: '字'.repeat(200) });
  });
  test('does not infer missing legacy attribution', () => {
    expect(getMediaUsageContext('session', { content: '图片' })).toBeUndefined();
    expect(getMediaUsageContext(undefined, { content: '图片' })).toBeUndefined();
  });
});
