import { describe, expect, test } from 'vitest';

import {
  COWORK_SIDE_CHAT_TITLE_MAX_CHARS,
  deriveCoworkSideChatTitle,
  normalizeCoworkSideChatTitle,
} from './sideChat';

describe('shared/cowork/sideChat helpers', () => {
  test('normalizeCoworkSideChatTitle strips null chars, collapses whitespace, and caps length', () => {
    expect(normalizeCoworkSideChatTitle('  hello\0 \n  world  ')).toBe('hello world');
    const long = 'a'.repeat(COWORK_SIDE_CHAT_TITLE_MAX_CHARS + 20);
    expect(normalizeCoworkSideChatTitle(long).length).toBe(COWORK_SIDE_CHAT_TITLE_MAX_CHARS);
  });

  test('deriveCoworkSideChatTitle trims and truncates long prompts with ellipsis', () => {
    expect(deriveCoworkSideChatTitle('   ', 'Side chat')).toBe('Side chat');
    expect(deriveCoworkSideChatTitle('Explain retry logic', 'Side chat', 40)).toBe('Explain retry logic');
    expect(deriveCoworkSideChatTitle('Explain how the retry backoff algorithm works in detail', 'Side chat', 20))
      .toBe('Explain how the ret…');
  });
});
