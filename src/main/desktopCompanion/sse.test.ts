import { describe, expect, test } from 'vitest';

import { readAnthropicStreamEvent, readGeminiStreamEvent, splitSseEvents } from './sse';

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
