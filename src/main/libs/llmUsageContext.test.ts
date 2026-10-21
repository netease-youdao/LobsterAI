import { describe, expect, test } from 'vitest';

import { getMediaUsageContext } from './llmUsageContext';

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
