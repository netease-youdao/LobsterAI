import { describe, expect, test } from 'vitest';

import {
  readAnthropicStreamEvent,
  readGeminiStreamEvent,
  readOpenAIChatStreamEvent,
  readOpenAIResponsesStreamEvent,
  splitSseEvents,
} from './sse';

describe('server-sent events', () => {
  test('keeps an unfinished event for the next chunk', () => {
    const first = splitSseEvents('event: content_block_delta\ndata: {"a":1}\n\nevent: ping\ndata: {"b"');
    expect(first.events).toEqual([{ event: 'content_block_delta', data: '{"a":1}' }]);
    const second = splitSseEvents(`${first.rest}:2}\r\n\r\n`);
    expect(second.events).toEqual([{ event: 'ping', data: '{"b":2}' }]);
    expect(second.rest).toBe('');
  });

  test('joins multi-line data and ignores comments', () => {
    expect(splitSseEvents(': keep-alive\ndata: one\ndata: two\n\n').events).toEqual([{ event: undefined, data: 'one\ntwo' }]);
  });
});

describe('anthropic stream', () => {
  test('emits text deltas and ignores thinking', () => {
    expect(readAnthropicStreamEvent({ data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}' })).toEqual({ text: 'Hi' });
    expect(readAnthropicStreamEvent({ data: '{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}' })).toEqual({});
  });

  test('reports the end and errors', () => {
    expect(readAnthropicStreamEvent({ data: '{"type":"message_stop"}' })).toEqual({ done: true });
    expect(readAnthropicStreamEvent({ event: 'error', data: '{"type":"error","error":{"message":"overloaded"}}' })).toEqual({ error: 'overloaded' });
    expect(readAnthropicStreamEvent({ data: 'not json' })).toEqual({});
  });
});

describe('gemini stream', () => {
  test('joins visible parts and skips thoughts', () => {
    const data = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'Hello' }, { text: ' world' }] } }] });
    expect(readGeminiStreamEvent({ data })).toEqual({ text: 'Hello world' });
  });

  test('surfaces API errors', () => {
    expect(readGeminiStreamEvent({ data: '{"error":{"message":"quota"}}' })).toEqual({ error: 'quota' });
  });
});

describe('openai chat completions stream', () => {
  test('reads content deltas and ignores reasoning and tool deltas', () => {
    expect(readOpenAIChatStreamEvent({ data: '{"choices":[{"delta":{"content":"Hi"}}]}' })).toEqual({ text: 'Hi' });
    expect(readOpenAIChatStreamEvent({ data: '{"choices":[{"delta":{"reasoning_content":"hmm"}}]}' })).toEqual({});
    expect(readOpenAIChatStreamEvent({ data: '{"choices":[{"delta":{"tool_calls":[]}}]}' })).toEqual({});
  });

  test('reports the end and errors', () => {
    expect(readOpenAIChatStreamEvent({ data: '[DONE]' })).toEqual({ done: true });
    expect(readOpenAIChatStreamEvent({ data: '{"error":{"message":"rate limited"}}' })).toEqual({ error: 'rate limited' });
    expect(readOpenAIChatStreamEvent({ data: 'not json' })).toEqual({});
  });
});

describe('openai responses stream', () => {
  test('reads output text deltas and ignores reasoning', () => {
    expect(readOpenAIResponsesStreamEvent({ data: '{"type":"response.output_text.delta","delta":"Hi"}' })).toEqual({ text: 'Hi' });
    expect(readOpenAIResponsesStreamEvent({ event: 'response.output_text.delta', data: '{"delta":" there"}' })).toEqual({ text: ' there' });
    expect(readOpenAIResponsesStreamEvent({ data: '{"type":"response.reasoning_summary_text.delta","delta":"hmm"}' })).toEqual({});
  });

  test('reports the end and errors', () => {
    expect(readOpenAIResponsesStreamEvent({ data: '{"type":"response.completed"}' })).toEqual({ done: true });
    expect(readOpenAIResponsesStreamEvent({ data: '{"type":"response.failed","response":{"error":{"message":"bad model"}}}' }))
      .toEqual({ error: 'bad model' });
    expect(readOpenAIResponsesStreamEvent({ data: '{"type":"error","message":"overloaded"}' })).toEqual({ error: 'overloaded' });
  });
});
