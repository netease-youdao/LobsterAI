import { describe, expect, it } from 'vitest';

import type { CoworkSession } from '../../types/cowork';
import { getFollowUpContext, isFollowUpAcceptKey, parseFollowUpSuggestion } from './followUpSuggestion';

const session = (overrides: Partial<CoworkSession> = {}) => ({
  id: 'a', status: 'completed', messages: [
    { id: 'u', type: 'user', content: '怎么连接浏览器？' },
    { id: 't', type: 'tool_result', content: 'private tool log' },
    { id: 'r', type: 'assistant', content: '<think>private reasoning</think>先连接 Chrome，再检查页面。' },
  ], ...overrides,
}) as CoworkSession;

describe('follow-up suggestion context', () => {
  it('uses the latest user and answer without tool logs or reasoning', () => {
    const context = getFollowUpContext(session())!;
    expect(context.question).toBe('怎么连接浏览器？');
    expect(context.answer).toBe('先连接 Chrome，再检查页面。');
    expect(context.key).not.toContain('private');
  });
  it.each(['running', 'error'] as const)('does not suggest during %s turns', status => {
    expect(getFollowUpContext(session({ status }))).toBeNull();
  });
  it('does not reuse an old answer while a new question awaits an answer', () => {
    const current = session();
    current.messages.push({ id: 'u2', type: 'user', content: '现在能访问吗？', timestamp: 2 });
    expect(getFollowUpContext(current)).toBeNull();
  });
  it('ignores thinking, failed, streaming and question receipt messages', () => {
    for (const metadata of [{ isThinking: true }, { isError: true }, { isStreaming: true }, { isGenerating: true }, { questionReceipt: {} }]) {
      const current = session();
      current.messages[2].metadata = metadata as never;
      expect(getFollowUpContext(current)).toBeNull();
    }
  });
  it('bounds the context and invalidates the identity after answer corrections', () => {
    const current = session();
    const first = getFollowUpContext(current)!;
    current.messages[2].content = '新答案'.repeat(5000);
    const second = getFollowUpContext(current)!;
    expect(second.answer.length).toBe(6000);
    expect(first.key).not.toBe(second.key);
  });
  it('does not copy fenced code or data URLs into the suggestion request', () => {
    const current = session();
    current.messages[2].content = '```js\nsecret\n```\n看这张图 data:image/png;base64,abc';
    expect(getFollowUpContext(current)?.answer).toBe('看这张图');
  });
});

describe('follow-up output and keyboard', () => {
  it('accepts one bounded JSON suggestion and rejects prose, lists and excessive output', () => {
    expect(parseFollowUpSuggestion('```json\n{"suggestion":"请再检查 Chrome 连接。"}\n```')).toBe('请再检查 Chrome 连接。');
    for (const output of ['plain answer', '{"suggestion":""}', '{"suggestion":["a","b"]}', JSON.stringify({ suggestion: 'x'.repeat(181) }), JSON.stringify({ suggestion: 'one\ntwo' })]) {
      expect(parseFollowUpSuggestion(output)).toBeNull();
    }
  });
  it('only accepts a fresh unmodified Tab outside IME composition', () => {
    const event = { key: 'Tab', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false, nativeEvent: {} };
    expect(isFollowUpAcceptKey(event)).toBe(true);
    for (const override of [{ key: 'Enter' }, { shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { repeat: true }, { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }]) {
      expect(isFollowUpAcceptKey({ ...event, ...override })).toBe(false);
    }
  });
});
