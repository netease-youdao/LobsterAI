import { PassThrough } from 'node:stream';

import http from 'http';
import { beforeEach, expect, test, vi } from 'vitest';

import { AuthRefreshOutcome } from '../../shared/auth/constants';

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
}));

import { net } from 'electron';

import {
  __openClawTokenProxyTestUtils,
  consumeRecentOpenClawTokenProxyQuotaError,
  startOpenClawTokenProxy,
  stopOpenClawTokenProxy,
} from './openclawTokenProxy';

const testUtils = __openClawTokenProxyTestUtils;

beforeEach(() => {
  consumeRecentOpenClawTokenProxyQuotaError();
});

test('refreshes LobsterAI credentials for 401 but not 403', () => {
  expect(testUtils.shouldRefreshLobsterAIToken(401)).toBe(true);
  expect(testUtils.shouldRefreshLobsterAIToken(200)).toBe(false);
  expect(testUtils.shouldRefreshLobsterAIToken(403)).toBe(false);
});

test('turns only transient refresh failures into temporary service errors', () => {
  expect(testUtils.isTemporaryAuthRefreshFailure({
    outcome: AuthRefreshOutcome.TransientFailure,
  })).toBe(true);
  expect(testUtils.isTemporaryAuthRefreshFailure({
    outcome: AuthRefreshOutcome.TerminalFailure,
  })).toBe(false);
});

type MockProxyResponse = {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  emitClose: () => void;
  destroyed: boolean;
  writableEnded: boolean;
  writableFinished: boolean;
};

function createMockProxyResponse(): MockProxyResponse {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const res: MockProxyResponse = {
    write: vi.fn(),
    end: vi.fn(() => {
      res.writableEnded = true;
      res.writableFinished = true;
    }),
    destroy: vi.fn(() => {
      res.destroyed = true;
      for (const listener of listeners.get('close') ?? []) {
        listener();
      }
    }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const eventListeners = listeners.get(event) ?? [];
      eventListeners.push(listener);
      listeners.set(event, eventListeners);
      return res;
    }),
    emitClose: () => {
      res.destroyed = true;
      for (const listener of listeners.get('close') ?? []) {
        listener();
      }
    },
    destroyed: false,
    writableEnded: false,
    writableFinished: false,
  };
  return res;
}

function asServerResponse(res: MockProxyResponse): http.ServerResponse {
  return res as unknown as http.ServerResponse;
}

function flushStreamEvents(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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

test('extracts enterprise quota error from unified non-stream response', () => {
  expect(testUtils.extractQuotaErrorFromProxyErrorPayload(
    JSON.stringify({ code: 41607, message: '团队积分池已用完', data: null }),
  )).toEqual({
    message: '团队积分池已用完',
    code: 41607,
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

test('recognizes a structured enterprise membership revocation with numeric or string code', () => {
  expect(testUtils.extractStructuredProxyError(
    '{"type":"error","error":{"message":"removed","code":41602}}',
    'error',
  )).toEqual({ message: 'removed', code: 41602 });
  expect(testUtils.isEnterpriseMembershipRevocationError({
    message: 'removed',
    code: '41602',
  })).toBe(true);
});

test('notifies membership revocation once for an SSE error split across CRLF chunks', () => {
  const onEnterpriseMembershipRevoked = vi.fn();
  const requestEnterpriseSession = {
    enterpriseId: 1001,
    ownerAccountKey: 'enterprise:user@example.com:1001',
    accountGeneration: 7,
  };
  const scanState = testUtils.createProxySSEStreamScanState(1_000, {
    requestEnterpriseSession,
    onEnterpriseMembershipRevoked,
  });

  let buffer = testUtils.scanProxySSEBufferForQuotaError(
    'event: error\r\ndata: {"type":"error","error":{"message":"removed","code":"41',
    1_001,
    scanState,
  );
  buffer = testUtils.scanProxySSEBufferForQuotaError(
    `${buffer}602"}}\r\n\r\n`,
    1_002,
    scanState,
  );
  testUtils.scanProxySSEBufferForQuotaError(
    'event: error\ndata: {"error":{"message":"removed again","code":41602}}\n\n',
    1_003,
    scanState,
  );

  expect(buffer).toBe('');
  expect(onEnterpriseMembershipRevoked).toHaveBeenCalledOnce();
  expect(onEnterpriseMembershipRevoked).toHaveBeenCalledWith({
    code: 41602,
    requestSession: requestEnterpriseSession,
  });
  expect(scanState.terminalKind).toBe(testUtils.ProxySSETerminalKind.Error);
});

test('does not revoke enterprise membership for non-error events, malformed JSON, or quota errors', () => {
  const onEnterpriseMembershipRevoked = vi.fn();
  const scanState = testUtils.createProxySSEStreamScanState(1_000, {
    requestEnterpriseSession: {
      enterpriseId: 1001,
      ownerAccountKey: 'enterprise:user@example.com:1001',
      accountGeneration: 7,
    },
    onEnterpriseMembershipRevoked,
  });

  const packets = [
    'event: message\ndata: {"code":41602,"message":"not an error event"}\n\n',
    'event: error\ndata: {not-json}\n\n',
    'event: error\ndata: {"error":{"message":"quota exhausted","code":41606}}\n\n',
    'event: error\ndata: {"error":{"message":"pool exhausted","code":41607}}\n\n',
    'event: error\ndata: {"error":{"message":"credits expired","code":41608}}\n\n',
    'data: [DONE]\n\n',
  ];
  let buffer = '';
  for (const packet of packets) {
    buffer = testUtils.scanProxySSEBufferForQuotaError(buffer + packet, 1_001, scanState);
  }

  expect(buffer).toBe('');
  expect(onEnterpriseMembershipRevoked).not.toHaveBeenCalled();
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

test('keeps Kimi K3 package payloads byte-for-byte transparent', () => {
  const requestBody = Buffer.from(JSON.stringify({
    model: 'kimi-k3-YoudaoInner',
    reasoning_effort: 'max',
    messages: [
      {
        role: 'assistant',
        reasoning_content: 'private reasoning replay',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read', arguments: '{"path":"README.md"}' },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'result',
      },
    ],
  }));

  expect(testUtils.hydrateGeminiChatCompletionsBody(requestBody)).toBe(requestBody);
});

test('adds fixed capability, client version, and enterprise context headers without trusting incoming values', () => {
  expect(testUtils.buildUpstreamRequestHeaders(
    'access-token',
    {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'x-lobsterai-client-capabilities': 'attacker-controlled',
      'x-lobsterai-client-version': '0.0.0',
    },
    '2026.7.23',
    {
      'X-LobsterAI-Account-Mode': 'enterprise',
      'X-LobsterAI-Enterprise-Id': '1001',
    },
  )).toEqual({
    Authorization: 'Bearer access-token',
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    'X-LobsterAI-Client-Capabilities': 'kimi-k3-agentic-v1,thinking-level-control-v1',
    'X-LobsterAI-Client-Version': '2026.7.23',
    'X-LobsterAI-Account-Mode': 'enterprise',
    'X-LobsterAI-Enterprise-Id': '1001',
  });
});

test('classifies SSE packets as terminal only on [DONE], finish_reason, or error payloads', () => {
  const terminalPackets = [
    'data: [DONE]',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'event: error\ndata: {"message":"quota exhausted"}',
    'data: {"type":"error","error":{"message":"boom"}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ];
  for (const packet of terminalPackets) {
    expect(testUtils.isTerminalProxySSEPacket(testUtils.parseProxySSEPacket(packet))).toBe(true);
  }

  const nonTerminalPackets = [
    'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"content":"hi"}}]}',
    ': keep-alive comment',
    'data: not-json',
    '',
  ];
  for (const packet of nonTerminalPackets) {
    expect(testUtils.isTerminalProxySSEPacket(testUtils.parseProxySSEPacket(packet))).toBe(false);
  }
});

test('classifies the specific SSE terminal packet kind', () => {
  const cases = [
    ['data: [DONE]', testUtils.ProxySSETerminalKind.Done],
    [
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      testUtils.ProxySSETerminalKind.FinishReason,
    ],
    [
      'event: message_stop\ndata: {"type":"message_stop"}',
      testUtils.ProxySSETerminalKind.MessageStop,
    ],
    [
      'event: error\ndata: {"type":"error","error":{"message":"boom"}}',
      testUtils.ProxySSETerminalKind.Error,
    ],
  ] as const;

  for (const [packet, expectedKind] of cases) {
    expect(testUtils.classifyTerminalProxySSEPacket(testUtils.parseProxySSEPacket(packet)))
      .toBe(expectedKind);
  }
});

test('scan state observes a terminal packet split across chunk boundaries', () => {
  const scanState = testUtils.createProxySSEStreamScanState();

  let buffer = testUtils.scanProxySSEBufferForQuotaError(
    'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\ndata: [DO',
    1_000,
    scanState,
  );
  expect(scanState.sawTerminalPacket).toBe(false);

  buffer = testUtils.scanProxySSEBufferForQuotaError(`${buffer}NE]\n\n`, 1_001, scanState);
  expect(buffer).toBe('');
  expect(scanState.sawTerminalPacket).toBe(true);
  expect(scanState.terminalKind).toBe(testUtils.ProxySSETerminalKind.Done);
  expect(scanState.eventCount).toBe(2);
});

test('flush detects a terminal packet in a trailing partial SSE frame', () => {
  const scanState = testUtils.createProxySSEStreamScanState();
  testUtils.flushProxySSEBufferForQuotaError('data: [DONE]', 1_000, scanState);
  expect(scanState.sawTerminalPacket).toBe(true);
  expect(scanState.terminalKind).toBe(testUtils.ProxySSETerminalKind.Done);
});

test('node stream: complete SSE response ends the proxied response cleanly', async () => {
  const upstream = new PassThrough();
  const res = createMockProxyResponse();

  testUtils.pipeStreamingResponseWithQuotaScan(upstream, asServerResponse(res));
  upstream.write('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
  upstream.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  upstream.write('data: [DONE]\n\n');
  upstream.end();
  await flushStreamEvents();

  expect(res.end).toHaveBeenCalledTimes(1);
  expect(res.destroy).not.toHaveBeenCalled();
});

test('bounds an unterminated SSE packet to avoid unbounded scan memory', () => {
  const oversizedPacket = `data: ${'x'.repeat(1_048_576 + 128)}`;

  const remaining = testUtils.scanProxySSEBufferForQuotaError(oversizedPacket);

  expect(remaining).toHaveLength(1_048_576);
  expect(remaining.endsWith('x'.repeat(128))).toBe(true);
});

test('accepts token retries only while the authenticated session key is unchanged', () => {
  expect(testUtils.isProxySessionKeyCurrent('enterprise:6:1001:4', () => (
    'enterprise:6:1001:4'
  ))).toBe(true);
  expect(testUtils.isProxySessionKeyCurrent('enterprise:6:1001:4', () => (
    'personal:6:5'
  ))).toBe(false);
  expect(testUtils.isProxySessionKeyCurrent(null, null)).toBe(true);
});

test('node stream: SSE response truncated by a clean upstream end is aborted', async () => {
  const upstream = new PassThrough();
  const res = createMockProxyResponse();

  testUtils.pipeStreamingResponseWithQuotaScan(upstream, asServerResponse(res));
  upstream.write('data: {"choices":[{"delta":{"content":"partial plan **"},"finish_reason":null}]}\n\n');
  upstream.end();
  await flushStreamEvents();

  expect(res.destroy).toHaveBeenCalledTimes(1);
  expect(res.end).not.toHaveBeenCalled();
});

test('node stream: upstream read error aborts the proxied response instead of ending it', async () => {
  const upstream = new PassThrough();
  const res = createMockProxyResponse();

  testUtils.pipeStreamingResponseWithQuotaScan(upstream, asServerResponse(res));
  upstream.write('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
  await flushStreamEvents();
  upstream.destroy(new Error('net::ERR_CONNECTION_RESET'));
  await flushStreamEvents();

  expect(res.destroy).toHaveBeenCalledTimes(1);
  expect(res.end).not.toHaveBeenCalled();
});

test('node stream: upstream SSE error payload still passes through and ends cleanly', async () => {
  const upstream = new PassThrough();
  const res = createMockProxyResponse();

  testUtils.pipeStreamingResponseWithQuotaScan(upstream, asServerResponse(res));
  upstream.write('event: error\ndata: {"type":"error","error":{"type":"proxy_error","message":"本月积分已用完","code":40202}}\n\n');
  upstream.end();
  await flushStreamEvents();

  expect(res.end).toHaveBeenCalledTimes(1);
  expect(res.destroy).not.toHaveBeenCalled();
  expect(consumeRecentOpenClawTokenProxyQuotaError()).toMatchObject({
    message: '本月积分已用完',
    code: 40202,
  });
});

test('node stream: membership revocation notifies once and still terminates downstream cleanly', async () => {
  const upstream = new PassThrough();
  const res = createMockProxyResponse();
  const onEnterpriseMembershipRevoked = vi.fn();
  const requestEnterpriseSession = {
    enterpriseId: 1001,
    ownerAccountKey: 'enterprise:user@example.com:1001',
    accountGeneration: 7,
  };

  testUtils.pipeStreamingResponseWithQuotaScan(upstream, asServerResponse(res), {
    requestEnterpriseSession,
    onEnterpriseMembershipRevoked,
  });
  upstream.write('event: error\ndata: {"type":"error","error":{"message":"removed","code":41602}}\n\n');
  upstream.end();
  await flushStreamEvents();

  expect(onEnterpriseMembershipRevoked).toHaveBeenCalledOnce();
  expect(onEnterpriseMembershipRevoked).toHaveBeenCalledWith({
    code: 41602,
    requestSession: requestEnterpriseSession,
  });
  expect(res.write).toHaveBeenCalled();
  expect(res.end).toHaveBeenCalledOnce();
  expect(res.destroy).not.toHaveBeenCalled();
});

test('node stream: cancels the upstream when the downstream closes', async () => {
  const upstream = new PassThrough();
  const res = createMockProxyResponse();
  const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

  try {
    testUtils.pipeStreamingResponseWithQuotaScan(upstream, asServerResponse(res));
    upstream.write('data: {"choices":[{"delta":{"content":"working"},"finish_reason":null}]}\n\n');
    res.emitClose();
    await flushStreamEvents();

    expect(upstream.destroyed).toBe(true);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('outcome=downstream_closed_upstream_cancelled'),
    );
    expect(res.end).not.toHaveBeenCalled();
    expect(res.destroy).not.toHaveBeenCalled();
  } finally {
    debugSpy.mockRestore();
  }
});

test('web stream: truncated SSE response is aborted on clean close', async () => {
  const res = createMockProxyResponse();
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
      ));
      controller.close();
    },
  });

  testUtils.pipeWebReadableResponseWithQuotaScan(
    webStream,
    asServerResponse(res),
    testUtils.createProxySSEStreamScanState(),
  );
  await vi.waitFor(() => {
    expect(res.destroy).toHaveBeenCalledTimes(1);
  });
  expect(res.end).not.toHaveBeenCalled();
});

test('web stream: read failure aborts the proxied response', async () => {
  const res = createMockProxyResponse();
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
      controller.error(new Error('net::ERR_CONNECTION_RESET'));
    },
  });

  testUtils.pipeWebReadableResponseWithQuotaScan(
    webStream,
    asServerResponse(res),
    testUtils.createProxySSEStreamScanState(),
  );
  await vi.waitFor(() => {
    expect(res.destroy).toHaveBeenCalledTimes(1);
  });
  expect(res.end).not.toHaveBeenCalled();
});

test('web stream: cancels the reader when the downstream closes', async () => {
  const res = createMockProxyResponse();
  const cancel = vi.fn();
  const webStream = new ReadableStream<Uint8Array>({
    pull() {
      // Keep the read pending until the downstream response closes.
    },
    cancel,
  });

  testUtils.pipeWebReadableResponseWithQuotaScan(
    webStream,
    asServerResponse(res),
    testUtils.createProxySSEStreamScanState(),
  );
  res.emitClose();

  await vi.waitFor(() => {
    expect(cancel).toHaveBeenCalledWith('Downstream response closed');
  });
  expect(res.end).not.toHaveBeenCalled();
  expect(res.destroy).not.toHaveBeenCalled();
});

test('web stream: cancels after downstream close even when completion scanning is disabled', async () => {
  const res = createMockProxyResponse();
  const cancel = vi.fn();
  const webStream = new ReadableStream<Uint8Array>({
    pull() {
      // Keep the read pending until the downstream response closes.
    },
    cancel,
  });

  testUtils.pipeWebReadableResponseWithQuotaScan(webStream, asServerResponse(res));
  res.emitClose();

  await vi.waitFor(() => {
    expect(cancel).toHaveBeenCalledWith('Downstream response closed');
  });
});

test('web stream: completion check is skipped when no scan state is provided', async () => {
  const res = createMockProxyResponse();
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"object":"chat.completion","choices":[]}'));
      controller.close();
    },
  });

  testUtils.pipeWebReadableResponseWithQuotaScan(webStream, asServerResponse(res));
  await vi.waitFor(() => {
    expect(res.end).toHaveBeenCalledTimes(1);
  });
  expect(res.destroy).not.toHaveBeenCalled();
});

test('accepts only loopback Host headers', () => {
  expect(testUtils.isLoopbackHostHeader('127.0.0.1:54061')).toBe(true);
  expect(testUtils.isLoopbackHostHeader('localhost:54061')).toBe(true);
  expect(testUtils.isLoopbackHostHeader('[::1]:54061')).toBe(true);
  expect(testUtils.isLoopbackHostHeader('LOCALHOST')).toBe(true);
  expect(testUtils.isLoopbackHostHeader('attacker.example:54061')).toBe(false);
  expect(testUtils.isLoopbackHostHeader('127.0.0.1.attacker.example')).toBe(false);
  expect(testUtils.isLoopbackHostHeader(undefined)).toBe(false);
});

test('requires the proxy token through any provider API key header', () => {
  const token = 'a'.repeat(48);
  const authorized = (headers: http.IncomingHttpHeaders) => testUtils.isInboundRequestAuthorized(headers, token);
  expect(authorized({ authorization: `Bearer ${token}` })).toBe(true);
  expect(authorized({ authorization: `bearer ${token}` })).toBe(true);
  expect(authorized({ 'x-api-key': token })).toBe(true);
  expect(authorized({ 'x-goog-api-key': token })).toBe(true);
  expect(authorized({ 'api-key': token })).toBe(true);
  expect(authorized({})).toBe(false);
  expect(authorized({ authorization: 'Bearer proxy-managed' })).toBe(false);
  expect(authorized({ authorization: `Bearer ${token}x` })).toBe(false);
  expect(authorized({ authorization: token })).toBe(false);
  // Without a configured token the proxy keeps its previous open behavior.
  expect(testUtils.isInboundRequestAuthorized({}, null)).toBe(true);
});

test('keeps the Chromium net error name when the upstream request fails before headers', () => {
  expect(JSON.parse(testUtils.buildUpstreamRequestFailureBody(
    new Error('net::ERR_HTTP2_PING_FAILED'),
  ))).toEqual({
    error: {
      message: 'LobsterAI proxy upstream request failed: net::ERR_HTTP2_PING_FAILED',
      type: 'upstream_network_error',
      code: 'ERR_HTTP2_PING_FAILED',
    },
  });
  expect(JSON.parse(testUtils.buildUpstreamRequestFailureBody(new TypeError('boom'))))
    .toEqual({ error: 'Token proxy upstream error' });
});

test('the running proxy relays an upstream network failure as a structured 502', async () => {
  const token = 'c'.repeat(48);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(net.fetch).mockRejectedValueOnce(new Error('net::ERR_HTTP2_PING_FAILED'));
  const { port } = await startOpenClawTokenProxy({
    getAuthTokens: () => ({ accessToken: 'access', refreshToken: 'refresh' }),
    refreshToken: vi.fn(),
    getServerBaseUrl: () => 'https://server.example',
    getClientVersion: () => 'test',
    getInboundAuthToken: () => token,
  });
  try {
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { authorization: `Bearer ${token}` },
      }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end('{}');
    });
    expect(response.status).toBe(502);
    expect(JSON.parse(response.body).error).toMatchObject({
      type: 'upstream_network_error',
      code: 'ERR_HTTP2_PING_FAILED',
    });
  } finally {
    stopOpenClawTokenProxy();
    errorSpy.mockRestore();
  }
});

test('the running proxy rejects foreign hosts and missing tokens before touching the account', async () => {
  const token = 'b'.repeat(48);
  const getAuthTokens = vi.fn(() => null);
  const { port } = await startOpenClawTokenProxy({
    getAuthTokens,
    refreshToken: vi.fn(),
    getServerBaseUrl: () => 'https://server.example',
    getClientVersion: () => 'test',
    getInboundAuthToken: () => token,
  });
  const send = (headers: http.OutgoingHttpHeaders) => new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', headers }, res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end('{}');
  });
  try {
    expect(await send({ host: 'attacker.example', authorization: `Bearer ${token}` })).toBe(403);
    expect(await send({ authorization: 'Bearer proxy-managed' })).toBe(401);
    expect(getAuthTokens).not.toHaveBeenCalled();
    // Authorized requests reach the account layer (no signed-in account here).
    expect(await send({ authorization: `Bearer ${token}` })).toBe(503);
    expect(getAuthTokens).toHaveBeenCalledOnce();
  } finally {
    stopOpenClawTokenProxy();
  }
});
