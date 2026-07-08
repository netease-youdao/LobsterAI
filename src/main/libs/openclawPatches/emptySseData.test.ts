import { describe, test } from 'vitest';

import { expectPatchContains } from './patchTestUtils';

describe('openclaw-empty-sse-data.patch', () => {
  test('filters empty OpenAI-compatible SSE data frames before SDK parsing', () => {
    expectPatchContains('openclaw-empty-sse-data.patch', [
      'diff --git a/src/agents/openai-transport-stream.ts',
      'OPENAI_COMPAT_EMPTY_SSE_DATA_FRAME_LIMIT',
      'filterEmptySseDataFramesFromResponse',
      'buildOpenAICompletionsFetch',
      'fetch: buildOpenAICompletionsFetch(model)',
      'Provider stream emitted too many empty SSE data frames.',
    ]);
  });

  test('adds OpenClaw coverage for filtering and runaway empty-frame streams', () => {
    expectPatchContains('openclaw-empty-sse-data.patch', [
      'diff --git a/src/agents/openai-transport-stream.test.ts',
      'drops empty SSE data frames before the OpenAI SDK stream parser sees them',
      'fails streams that emit too many consecutive empty SSE data frames',
      'does not rewrite non-event-stream responses',
      'data: [DONE]',
    ]);
  });
});
