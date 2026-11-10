import { beforeEach, describe, expect, test } from 'vitest';

import {
  PENDING_CONVERSATION_SEARCH_TTL_MS,
  setPendingConversationSearch,
  takePendingConversationSearch,
} from './pendingConversationSearch';

describe('pendingConversationSearch', () => {
  beforeEach(() => {
    setPendingConversationSearch('', '');
  });

  test('hands the query to the target session once', () => {
    setPendingConversationSearch('session-a', '  拉链 ', 1000);
    expect(takePendingConversationSearch('session-a', 1500)).toBe('拉链');
    expect(takePendingConversationSearch('session-a', 1600)).toBeNull();
  });

  test('keeps a request for another session until that session claims it', () => {
    setPendingConversationSearch('session-b', 'zipper', 1000);
    expect(takePendingConversationSearch('session-a', 1100)).toBeNull();
    expect(takePendingConversationSearch('session-b', 1200)).toBe('zipper');
  });

  test('drops an expired request', () => {
    setPendingConversationSearch('session-a', 'zipper', 1000);
    expect(takePendingConversationSearch('session-a', 1001 + PENDING_CONVERSATION_SEARCH_TTL_MS)).toBeNull();
  });

  test('ignores an empty query', () => {
    setPendingConversationSearch('session-a', '   ', 1000);
    expect(takePendingConversationSearch('session-a', 1000)).toBeNull();
  });
});
