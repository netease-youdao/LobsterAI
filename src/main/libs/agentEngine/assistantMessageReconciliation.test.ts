import { describe, expect, test } from 'vitest';

import type { CoworkMessage } from '../../coworkStore';
import {
  extractThinkingFromCurrentTurn,
  findMatchingThinkingMessageIdInCurrentTurn,
  findRedundantFinalPrefixMessageId,
  findReusableCommittedAssistantMessageId,
  findReusableFinalAssistantMessageId,
  isRedundantFinalPrefixSegment,
} from './assistantMessageReconciliation';

const message = (
  id: string,
  type: CoworkMessage['type'],
  content: string,
  metadata?: CoworkMessage['metadata'],
): CoworkMessage => ({
  id,
  type,
  content,
  metadata,
  timestamp: Number(id.replace(/\D/g, '')) || 1,
});

describe('assistant message reconciliation', () => {
  test('extractThinkingFromCurrentTurn only reads assistant thinking after the last user', () => {
    const result = extractThinkingFromCurrentTurn([
      { role: 'user', content: 'old turn' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'old thinking' }] },
      { role: 'user', content: 'new turn' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'first new thought' },
          { type: 'text', text: 'visible text' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'second new thought' }],
      },
    ]);

    expect(result).toBe('first new thought\n\nsecond new thought');
  });

  test('findMatchingThinkingMessageIdInCurrentTurn stops at the current user boundary', () => {
    const messages = [
      message('msg-1', 'assistant', 'same', { isThinking: true }),
      message('msg-2', 'user', 'new turn'),
      message('msg-3', 'assistant', 'visible'),
      message('msg-4', 'assistant', 'same', { isThinking: true }),
    ];

    expect(findMatchingThinkingMessageIdInCurrentTurn(messages, 'same')).toBe('msg-4');
    expect(findMatchingThinkingMessageIdInCurrentTurn(messages, 'missing')).toBeNull();
  });

  test('findReusableCommittedAssistantMessageId ignores thinking and mismatched content', () => {
    const messages = [
      message('msg-1', 'assistant', 'committed text'),
      message('msg-2', 'assistant', 'committed text', { isThinking: true }),
    ];

    expect(findReusableCommittedAssistantMessageId(messages, 'msg-1', ' committed text ')).toBe('msg-1');
    expect(findReusableCommittedAssistantMessageId(messages, 'msg-2', 'committed text')).toBeNull();
    expect(findReusableCommittedAssistantMessageId(messages, 'msg-1', 'other text')).toBeNull();
  });

  test('findReusableFinalAssistantMessageId allows one trailing non-assistant message', () => {
    const messages = [
      message('msg-1', 'user', 'hello'),
      message('msg-2', 'assistant', 'final text'),
      message('msg-3', 'tool_result', 'ok'),
    ];

    expect(findReusableFinalAssistantMessageId(messages, 'final text')).toBe('msg-2');
    expect(findReusableFinalAssistantMessageId([...messages, message('msg-4', 'tool_use', 'tool')], 'final text')).toBeNull();
  });

  test('redundant prefix detection keeps short prefixes and finds long partial final segments', () => {
    const shortPrefix = 'short prefix';
    const longPrefix = 'A'.repeat(90);
    const finalText = `${longPrefix} ${'B'.repeat(80)}`;

    expect(isRedundantFinalPrefixSegment(shortPrefix, `${shortPrefix} tail`)).toBe(false);
    expect(isRedundantFinalPrefixSegment(longPrefix, finalText)).toBe(true);
    expect(findRedundantFinalPrefixMessageId([
      message('msg-1', 'user', 'start'),
      message('msg-2', 'assistant', longPrefix),
      message('msg-3', 'assistant', finalText),
    ], 'msg-3', finalText)).toBe('msg-2');
  });
});
