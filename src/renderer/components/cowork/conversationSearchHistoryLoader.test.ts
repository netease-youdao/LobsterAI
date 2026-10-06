import { describe, expect, test, vi } from 'vitest';

import {
  COWORK_SEARCH_HISTORY_MAX_CONTENT_CODE_UNITS,
  COWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS,
  COWORK_SEARCH_HISTORY_MAX_MIXED_ROWS,
} from '../../../shared/cowork/constants';
import type { CoworkSearchMessagePage } from '../../../shared/cowork/search';
import {
  ConversationSearchHistoryLimitError,
  ConversationSearchHistoryLimitKind,
  isConversationSearchHistoryLimitError,
  loadConversationSearchHistory,
  mergeConversationSearchHistoryMessages,
} from './conversationSearchHistoryLoader';

const makePage = (
  offset: number,
  nextOffset: number,
  total: number,
  visibleIndexes: number[],
): CoworkSearchMessagePage => ({
  offset,
  nextOffset,
  nextCursor: nextOffset > offset
    ? { sortValue: nextOffset - 1, createdAt: nextOffset - 1, rowId: nextOffset }
    : undefined,
  total,
  messages: visibleIndexes.map(index => ({
    id: `message-${index}`,
    type: index % 2 === 0 ? 'user' : 'assistant',
    content: `content ${index}`,
    timestamp: index,
    absoluteMessageIndex: index,
  })),
});

describe('loadConversationSearchHistory', () => {
  test('advances over mixed-message pages while retaining exact absolute indexes', async () => {
    const loadPage = vi.fn(async ({ offset }: { offset: number; limit: number }) => (
      offset === 0
        ? makePage(0, 3, 6, [0, 2])
        : makePage(3, 6, 6, [4, 5])
    ));
    const yieldBetweenPages = vi.fn(async () => undefined);

    const result = await loadConversationSearchHistory({
      loadPage,
      isRequestCurrent: () => true,
      pageSize: 3,
      yieldBetweenPages,
    });

    expect(loadPage).toHaveBeenNthCalledWith(1, {
      offset: 0,
      limit: 3,
      cursor: undefined,
      knownTotal: undefined,
    });
    expect(loadPage).toHaveBeenNthCalledWith(2, {
      offset: 3,
      limit: 3,
      cursor: { sortValue: 2, createdAt: 2, rowId: 3 },
      knownTotal: 6,
    });
    expect(yieldBetweenPages).toHaveBeenCalledTimes(1);
    expect(result?.messages.map(message => message.absoluteMessageIndex)).toEqual([0, 2, 4, 5]);
    expect(result?.endOffset).toBe(6);
    expect(result?.endCursor).toEqual({ sortValue: 5, createdAt: 5, rowId: 6 });
    expect(result?.total).toBe(6);
    expect(result?.cumulativeContentCodeUnits).toBe(
      result?.messages.reduce((total, message) => total + message.content.length, 0),
    );
  });

  test('stops requesting pages and discards partial results when cancelled', async () => {
    let current = true;
    const loadPage = vi.fn(async () => {
      current = false;
      return makePage(0, 2, 5, [0]);
    });

    await expect(loadConversationSearchHistory({
      loadPage,
      isRequestCurrent: () => current,
      pageSize: 2,
      yieldBetweenPages: async () => undefined,
    })).resolves.toBeNull();
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  test('fails once when a non-terminal page makes no progress', async () => {
    const loadPage = vi.fn(async () => makePage(0, 0, 4, []));

    await expect(loadConversationSearchHistory({
      loadPage,
      isRequestCurrent: () => true,
      yieldBetweenPages: async () => undefined,
    })).rejects.toThrow('made no progress');
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  test('accepts an empty terminal session without retrying', async () => {
    const loadPage = vi.fn(async () => makePage(0, 0, 0, []));

    await expect(loadConversationSearchHistory({
      loadPage,
      isRequestCurrent: () => true,
      yieldBetweenPages: async () => undefined,
    })).resolves.toEqual({
      messages: [],
      endOffset: 0,
      endCursor: undefined,
      total: 0,
      cumulativeContentCodeUnits: 0,
    });
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  test('continues when the tail grows between bounded pages', async () => {
    const loadPage = vi.fn(async ({ offset }: { offset: number; limit: number }) => {
      if (offset === 0) return makePage(0, 2, 4, [0]);
      if (offset === 2) return makePage(2, 4, 6, [3]);
      return makePage(4, 6, 6, [5]);
    });

    const result = await loadConversationSearchHistory({
      loadPage,
      isRequestCurrent: () => true,
      pageSize: 2,
      yieldBetweenPages: async () => undefined,
    });

    expect(loadPage).toHaveBeenCalledTimes(3);
    expect(result?.messages.map(message => message.absoluteMessageIndex)).toEqual([0, 3, 5]);
    expect(result?.endOffset).toBe(6);
    expect(result?.total).toBe(6);
  });

  test('fails safely if the timeline shrinks between pages', async () => {
    const loadPage = vi.fn(async ({ offset }: { offset: number; limit: number }) => (
      offset === 0
        ? makePage(0, 2, 5, [0])
        : makePage(2, 4, 4, [3])
    ));

    await expect(loadConversationSearchHistory({
      loadPage,
      isRequestCurrent: () => true,
      pageSize: 2,
      yieldBetweenPages: async () => undefined,
    })).rejects.toThrow('timeline changed');
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  test('fails safely if a shifted page repeats an id at a different absolute index', async () => {
    const firstPage = makePage(0, 2, 4, [1]);
    const shiftedPage = makePage(2, 4, 5, [2]);
    shiftedPage.messages[0] = {
      ...shiftedPage.messages[0],
      id: firstPage.messages[0].id,
    };
    const loadPage = vi.fn(async ({ offset }: { offset: number; limit: number }) => (
      offset === 0 ? firstPage : shiftedPage
    ));

    await expect(loadConversationSearchHistory({
      loadPage,
      isRequestCurrent: () => true,
      pageSize: 2,
      yieldBetweenPages: async () => undefined,
    })).rejects.toThrow('timeline shifted');
  });

  test('rejects an initial history whose mixed-row total exceeds the limit', async () => {
    const loadPage = vi.fn(async () => makePage(
      0,
      0,
      COWORK_SEARCH_HISTORY_MAX_MIXED_ROWS + 1,
      [],
    ));

    const promise = loadConversationSearchHistory({
      loadPage,
      isRequestCurrent: () => true,
      yieldBetweenPages: async () => undefined,
    });

    await expect(promise).rejects.toMatchObject({
      kind: ConversationSearchHistoryLimitKind.MixedRows,
      limit: COWORK_SEARCH_HISTORY_MAX_MIXED_ROWS,
      actual: COWORK_SEARCH_HISTORY_MAX_MIXED_ROWS + 1,
    });
  });

  test('rejects an incremental history before loading when its known total exceeds the limit', async () => {
    const loadPage = vi.fn(async () => makePage(1, 1, 1, []));

    const promise = loadConversationSearchHistory({
      startOffset: 1,
      startCursor: { sortValue: 0, createdAt: 0, rowId: 1 },
      knownTotal: COWORK_SEARCH_HISTORY_MAX_MIXED_ROWS + 1,
      loadPage,
      isRequestCurrent: () => true,
      yieldBetweenPages: async () => undefined,
    });

    await expect(promise).rejects.toMatchObject({
      kind: ConversationSearchHistoryLimitKind.MixedRows,
    });
    expect(loadPage).not.toHaveBeenCalled();
  });

  test('rejects a single oversized message with a typed limit error', async () => {
    const page = makePage(0, 1, 1, [0]);
    page.messages[0].content = 'x'.repeat(
      COWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS + 1,
    );

    let caughtError: unknown;
    try {
      await loadConversationSearchHistory({
        loadPage: async () => page,
        isRequestCurrent: () => true,
        yieldBetweenPages: async () => undefined,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(ConversationSearchHistoryLimitError);
    expect(isConversationSearchHistoryLimitError(caughtError)).toBe(true);
    expect(caughtError).toMatchObject({
      kind: ConversationSearchHistoryLimitKind.MessageContentCodeUnits,
      limit: COWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS,
      actual: COWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS + 1,
    });
  });

  test('rejects an initial history whose cumulative content exceeds the limit', async () => {
    const visibleIndexes = Array.from({ length: 17 }, (_, index) => index);
    const page = makePage(0, visibleIndexes.length, visibleIndexes.length, visibleIndexes);
    const maxMessage = 'x'.repeat(COWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS);
    page.messages.forEach((message, index) => {
      message.content = index < 16 ? maxMessage : 'x';
    });

    await expect(loadConversationSearchHistory({
      pageSize: visibleIndexes.length,
      loadPage: async () => page,
      isRequestCurrent: () => true,
      yieldBetweenPages: async () => undefined,
    })).rejects.toMatchObject({
      kind: ConversationSearchHistoryLimitKind.TotalContentCodeUnits,
      limit: COWORK_SEARCH_HISTORY_MAX_CONTENT_CODE_UNITS,
      actual: COWORK_SEARCH_HISTORY_MAX_CONTENT_CODE_UNITS + 1,
    });
  });

  test('includes retained incremental content when enforcing the cumulative limit', async () => {
    const page = makePage(1, 2, 2, [1]);
    page.messages[0].content = 'xx';

    await expect(loadConversationSearchHistory({
      startOffset: 1,
      startCursor: { sortValue: 0, createdAt: 0, rowId: 1 },
      knownTotal: 2,
      existingContentCodeUnits: COWORK_SEARCH_HISTORY_MAX_CONTENT_CODE_UNITS - 1,
      loadPage: async () => page,
      isRequestCurrent: () => true,
      yieldBetweenPages: async () => undefined,
    })).rejects.toMatchObject({
      kind: ConversationSearchHistoryLimitKind.TotalContentCodeUnits,
      actual: COWORK_SEARCH_HISTORY_MAX_CONTENT_CODE_UNITS + 1,
    });
  });

  test('accepts exact mixed-row, per-message, and cumulative content boundaries', async () => {
    const startOffset = COWORK_SEARCH_HISTORY_MAX_MIXED_ROWS - 1;
    const page = makePage(
      startOffset,
      COWORK_SEARCH_HISTORY_MAX_MIXED_ROWS,
      COWORK_SEARCH_HISTORY_MAX_MIXED_ROWS,
      [startOffset],
    );
    page.messages[0].content = 'x'.repeat(
      COWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS,
    );

    const result = await loadConversationSearchHistory({
      startOffset,
      startCursor: {
        sortValue: startOffset - 1,
        createdAt: startOffset - 1,
        rowId: startOffset,
      },
      knownTotal: COWORK_SEARCH_HISTORY_MAX_MIXED_ROWS,
      existingContentCodeUnits: COWORK_SEARCH_HISTORY_MAX_CONTENT_CODE_UNITS
        - COWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS,
      loadPage: async () => page,
      isRequestCurrent: () => true,
      yieldBetweenPages: async () => undefined,
    });

    expect(result).toMatchObject({
      endOffset: COWORK_SEARCH_HISTORY_MAX_MIXED_ROWS,
      total: COWORK_SEARCH_HISTORY_MAX_MIXED_ROWS,
      cumulativeContentCodeUnits: COWORK_SEARCH_HISTORY_MAX_CONTENT_CODE_UNITS,
    });
  });

  test('rejects more than 500 pages with a typed page safety error', async () => {
    const loadPage = vi.fn(async ({ offset }: { offset: number; limit: number }) => (
      makePage(offset, offset + 1, 501, [])
    ));

    await expect(loadConversationSearchHistory({
      pageSize: 1,
      loadPage,
      isRequestCurrent: () => true,
      yieldBetweenPages: async () => undefined,
    })).rejects.toMatchObject({
      kind: ConversationSearchHistoryLimitKind.Pages,
      limit: 500,
      actual: 501,
    });
    expect(loadPage).toHaveBeenCalledTimes(500);
  });
});

describe('mergeConversationSearchHistoryMessages', () => {
  test('deduplicates streamed tail rows by id and preserves main-process indexes', () => {
    const existing = makePage(0, 10, 10, [2, 7]).messages;
    const updatedAtSeven = {
      ...existing[1],
      content: 'streamed final content',
    };
    const newTail = makePage(10, 12, 12, [11]).messages[0];

    const result = mergeConversationSearchHistoryMessages(
      existing,
      [updatedAtSeven, newTail],
    );

    expect(result.map(message => message.absoluteMessageIndex)).toEqual([2, 7, 11]);
    expect(result.find(message => message.id === updatedAtSeven.id)?.content)
      .toBe('streamed final content');
  });

  test('rejects the same id at a shifted absolute index', () => {
    const existing = makePage(0, 10, 10, [7]).messages;
    const shifted = { ...existing[0], absoluteMessageIndex: 8 };

    expect(() => mergeConversationSearchHistoryMessages(existing, [shifted]))
      .toThrow('timeline shifted');
  });
});
