import { describe, expect, test } from 'vitest';

import type { CoworkMessage } from '../../types/cowork';
import {
  findConversationSearchMatches,
  getConversationSearchMessageText,
  getVisibleMarkdownSearchText,
  normalizeConversationSearchQuery,
} from './conversationSearch';

const message = (
  id: string,
  type: CoworkMessage['type'],
  content: string,
  metadata?: CoworkMessage['metadata'],
): CoworkMessage => ({ id, type, content, timestamp: 1, metadata });

describe('conversation search', () => {
  test('normalizes outer whitespace, line endings, and case', () => {
    expect(normalizeConversationSearchQuery('  HeLLo\r\nWorld  ')).toBe('hello\nworld');
  });

  test('searches user and visible assistant messages only', () => {
    const matches = findConversationSearchMatches([
      message('user', 'user', 'needle'),
      message('assistant', 'assistant', 'Needle'),
      message('silent', 'assistant', '**NO_REPLY**'),
      message('thinking', 'assistant', 'needle', { isThinking: true }),
      message('tool', 'tool_result', 'needle'),
      message('system', 'system', 'needle'),
    ], 'NEEDLE');

    expect(matches.map(match => match.messageId)).toEqual(['user', 'assistant']);
    expect(getConversationSearchMessageText(message(
      'silent',
      'assistant',
      '**NO_REPLY**',
    ))).toBeNull();
  });

  test('matches Chinese and mixed-language text literally', () => {
    const matches = findConversationSearchMatches([
      message('mixed', 'assistant', '这是 LobsterAI 的当前对话搜索。'),
    ], 'LobsterAI 的当前对话');

    expect(matches).toHaveLength(1);
  });

  test('counts non-overlapping occurrences in chronological order', () => {
    const matches = findConversationSearchMatches([
      message('first', 'user', 'foo foofoo'),
      message('second', 'assistant', 'foo'),
    ], 'foo', 12);

    expect(matches).toMatchObject([
      { messageId: 'first', occurrenceIndex: 0, absoluteMessageIndex: 12 },
      { messageId: 'first', occurrenceIndex: 1, absoluteMessageIndex: 12 },
      { messageId: 'first', occurrenceIndex: 2, absoluteMessageIndex: 12 },
      { messageId: 'second', occurrenceIndex: 0, absoluteMessageIndex: 13 },
    ]);
  });

  test('keeps absolute indexes aligned with excluded tool messages', () => {
    const matches = findConversationSearchMatches([
      message('user', 'user', 'before'),
      message('tool', 'tool_result', 'needle'),
      message('assistant', 'assistant', 'needle'),
    ], 'needle', 20);

    expect(matches).toMatchObject([
      { messageId: 'assistant', absoluteMessageIndex: 22 },
    ]);
  });

  test('keeps punctuation that is visibly rendered in user bubbles', () => {
    const matches = findConversationSearchMatches([
      message('user-markdown-like', 'user', '- literal [label](visible-url)'),
    ], '[label](visible-url)');

    expect(matches).toHaveLength(1);
  });

  test('treats regular-expression characters literally', () => {
    const matches = findConversationSearchMatches([
      message('literal', 'user', 'Use [a-z].* literally, then [a-z].* again.'),
    ], '[a-z].*');

    expect(matches).toHaveLength(2);
  });

  test('does not duplicate query text into match identity keys', () => {
    const matches = findConversationSearchMatches([
      message('privacy-safe-key', 'assistant', 'sensitive-query sensitive-query'),
    ], 'sensitive-query');

    expect(matches).toHaveLength(2);
    expect(matches.every(match => !match.key.includes('sensitive-query'))).toBe(true);
  });

  test('caps collected matches to protect long conversations from unbounded allocations', () => {
    const matches = findConversationSearchMatches([
      message('many-matches', 'assistant', 'x x x x x'),
    ], 'x', 0, 3);

    expect(matches).toHaveLength(3);
    expect(matches.map(match => match.occurrenceIndex)).toEqual([0, 1, 2]);
  });

  test('enforces the match cap across multiple messages', () => {
    const matches = findConversationSearchMatches([
      message('first', 'assistant', 'x x'),
      message('second', 'user', 'x x'),
      message('third', 'assistant', 'x x'),
    ], 'x', 0, 3);

    expect(matches).toHaveLength(3);
    expect(matches.map(match => match.messageId)).toEqual(['first', 'first', 'second']);
  });

  test('searches visible Markdown labels and code but not hidden link or image URLs', () => {
    const text = getVisibleMarkdownSearchText([
      '# **Title**',
      '[OpenAI](https://openai.com/hidden)',
      '![diagram](https://example.com/private.png)',
      '`const value = 1`',
      '```ts',
      'console.log(value);',
      '```',
    ].join('\n'));

    expect(text).toContain('Title');
    expect(text).toContain('OpenAI');
    expect(text).toContain('const value = 1');
    expect(text).toContain('console.log(value);');
    expect(text).not.toContain('openai.com/hidden');
    expect(text).not.toContain('private.png');
  });

  test('preserves Markdown and HTML literals inside multi-backtick inline code', () => {
    const content = [
      'Before ``literal ` [x](https://inline.example/path) <div> **stars**`` after',
      '[outside](https://outside.example/hidden)',
    ].join('\n');
    const text = getVisibleMarkdownSearchText(content);

    expect(text).toContain('literal ` [x](https://inline.example/path) <div> **stars**');
    expect(text).toContain('outside');
    expect(text).not.toContain('outside.example/hidden');
    expect(findConversationSearchMatches([
      message('inline-code', 'assistant', content),
    ], 'inline.example/path')).toHaveLength(1);
  });

  test('preserves Markdown and HTML literals inside longer fenced code', () => {
    const content = [
      '````markdown',
      '```',
      '[x](https://fenced.example/path)',
      '<section>**literal**</section>',
      '```',
      '````',
      '[outside](https://outside.example/hidden)',
    ].join('\n');
    const text = getVisibleMarkdownSearchText(content);

    expect(text).toContain('```\n[x](https://fenced.example/path)');
    expect(text).toContain('<section>**literal**</section>');
    expect(text).not.toContain('````markdown');
    expect(text).not.toContain('outside.example/hidden');
    expect(findConversationSearchMatches([
      message('fenced-code', 'assistant', content),
    ], 'fenced.example/path')).toHaveLength(1);
  });

  test('removes paired emphasis markers without consuming literal asterisks', () => {
    expect(getVisibleMarkdownSearchText('alpha **bold phrase** omega')).toContain('alpha bold phrase omega');
    expect(getVisibleMarkdownSearchText('Use [a-z].* literally')).toContain('[a-z].*');
  });

  test('includes proposed plan text without transport tags', () => {
    const text = getConversationSearchMessageText(message(
      'plan',
      'assistant',
      'Before\n<proposed_plan>\n## Implementation Approach\nShip it\n</proposed_plan>',
    ));

    expect(text).toContain('Before');
    expect(text).toContain('Implementation Approach');
    expect(text).toContain('Ship it');
    expect(text).not.toContain('proposed_plan');
  });
});
