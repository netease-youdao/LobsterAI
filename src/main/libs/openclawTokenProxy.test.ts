import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
}));

import {
  __openClawTokenProxyTestUtils,
  consumeRecentOpenClawTokenProxyQuotaError,
} from './openclawTokenProxy';

const testUtils = __openClawTokenProxyTestUtils;

beforeEach(() => {
  consumeRecentOpenClawTokenProxyQuotaError();
});

test('extracts LobsterAI monthly quota error from proxy SSE packet', () => {
  const packet = [
    'event: error',
    'data: {"type":"error","error":{"type":"proxy_error","message":"本月积分已用完","code":40202}}',
  ].join('\n');

  expect(testUtils.extractQuotaErrorFromProxySSEPacket(packet)).toEqual({
    message: '本月积分已用完',
    code: 40202,
  });
});

test('ignores generic HTTP 402 without LobsterAI quota code or message', () => {
  const packet = [
    'event: error',
    'data: {"error":{"message":"Request failed with status 402"}}',
  ].join('\n');

  expect(testUtils.extractQuotaErrorFromProxySSEPacket(packet)).toBeNull();
});

test('scans split SSE chunks and stores a recent quota error', () => {
  const now = 1_000;
  let buffer = testUtils.scanProxySSEBufferForQuotaError(
    'event: error\ndata: {"type":"error","error":{"message":"本月',
    now,
  );

  buffer = testUtils.scanProxySSEBufferForQuotaError(
    `${buffer}积分已用完","code":40202}}\n\n`,
    now + 1,
  );

  expect(buffer).toBe('');
  expect(consumeRecentOpenClawTokenProxyQuotaError(now + 2)).toEqual({
    message: '本月积分已用完',
    code: 40202,
    capturedAt: now + 1,
  });
});

test('expires stale remembered quota errors', () => {
  testUtils.rememberQuotaError({ message: '本月积分已用完', code: 40202 }, 1_000);

  expect(consumeRecentOpenClawTokenProxyQuotaError(32_000)).toBeNull();
});

test('hydrates missing Gemini package model tool call thought signatures', () => {
  const requestBody = {
    model: 'gemini-3.5-flash-YoudaoInner',
    messages: [
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_memory',
            type: 'function',
            function: {
              name: 'memory_search',
              arguments: '{"query":"福利公告"}',
            },
          },
        ],
      },
    ],
  };

  expect(testUtils.hydrateGeminiToolCallThoughtSignatures(requestBody)).toBe(true);
  expect((requestBody.messages[0].tool_calls[0] as Record<string, unknown>).extra_content).toEqual({
    google: {
      thought_signature: 'skip_thought_signature_validator',
    },
  });
  expect(requestBody.messages[0].tool_calls[0].function.extra_content).toEqual({
    google: {
      thought_signature: 'skip_thought_signature_validator',
    },
  });
  expect(requestBody.messages[0].tool_calls[0].function.thought_signature).toBe(
    'skip_thought_signature_validator',
  );
});

test('mirrors existing Gemini package model tool call thought signatures into function fields', () => {
  const requestBody = {
    model: 'gemini-3.5-flash-YoudaoInner',
    messages: [
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_memory',
            type: 'function',
            extra_content: {
              google: {
                thought_signature: 'existing-signature',
              },
            },
            function: {
              name: 'memory_search',
              arguments: '{}',
            },
          },
        ],
      },
    ],
  };

  expect(testUtils.hydrateGeminiToolCallThoughtSignatures(requestBody)).toBe(true);
  expect(requestBody.messages[0].tool_calls[0].extra_content).toEqual({
    google: {
      thought_signature: 'existing-signature',
    },
  });
  expect(requestBody.messages[0].tool_calls[0].function.extra_content).toEqual({
    google: {
      thought_signature: 'existing-signature',
    },
  });
  expect(requestBody.messages[0].tool_calls[0].function.thought_signature).toBe('existing-signature');
});

test('keeps fully hydrated Gemini package model tool calls unchanged', () => {
  const requestBody = {
    model: 'gemini-3.5-flash-YoudaoInner',
    messages: [
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_memory',
            type: 'function',
            extra_content: {
              google: {
                thought_signature: 'existing-signature',
              },
            },
            function: {
              name: 'memory_search',
              arguments: '{}',
              extra_content: {
                google: {
                  thought_signature: 'existing-signature',
                },
              },
              thought_signature: 'existing-signature',
            },
          },
        ],
      },
    ],
  };

  expect(testUtils.hydrateGeminiToolCallThoughtSignatures(requestBody)).toBe(false);
});

test('leaves non-Gemini package model request bodies unchanged', () => {
  const requestBody = Buffer.from(JSON.stringify({
    model: 'qwen3.5-plus-YoudaoInner',
    messages: [
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_memory',
            type: 'function',
            function: {
              name: 'memory_search',
              arguments: '{}',
            },
          },
        ],
      },
    ],
  }));

  expect(testUtils.hydrateGeminiChatCompletionsBody(requestBody)).toBe(requestBody);
});
