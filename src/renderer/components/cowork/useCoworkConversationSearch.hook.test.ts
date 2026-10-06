import { beforeEach, describe, expect, test, vi } from 'vitest';

import { COWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS } from '../../../shared/cowork/constants';
import type { CoworkSearchMessagePage } from '../../../shared/cowork/search';
import {
  ConversationSearchErrorReason,
  ConversationSearchStatus,
} from './conversationSearch';

const reactHookHarness = vi.hoisted(() => {
  let stateCursor = 0;
  let refCursor = 0;
  let states: unknown[] = [];
  let refs: Array<{ current: unknown }> = [];

  return {
    beginRender: () => {
      stateCursor = 0;
      refCursor = 0;
    },
    reset: () => {
      stateCursor = 0;
      refCursor = 0;
      states = [];
      refs = [];
    },
    useState: <T,>(initialValue: T) => {
      const index = stateCursor;
      stateCursor += 1;
      if (index >= states.length) states.push(initialValue);
      const setValue = (value: T | ((previous: T) => T)) => {
        const previous = states[index] as T;
        states[index] = typeof value === 'function'
          ? (value as (current: T) => T)(previous)
          : value;
      };
      return [states[index] as T, setValue] as const;
    },
    useRef: <T,>(initialValue: T) => {
      const index = refCursor;
      refCursor += 1;
      if (index >= refs.length) refs.push({ current: initialValue });
      return refs[index] as { current: T };
    },
  };
});

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(callback: T): T => callback,
  useEffect: () => undefined,
  useMemo: <T,>(factory: () => T): T => factory(),
  useRef: reactHookHarness.useRef,
  useState: reactHookHarness.useState,
}));

import { useCoworkConversationSearch } from './useCoworkConversationSearch';

const flushPromiseChain = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
};

describe('useCoworkConversationSearch history limits', () => {
  beforeEach(() => {
    reactHookHarness.reset();
  });

  test('enters the explicit too-large error state and permits a clean retry', async () => {
    const oversizedPage: CoworkSearchMessagePage = {
      messages: [{
        id: 'oversized',
        type: 'assistant',
        content: 'x'.repeat(COWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS + 1),
        timestamp: 1,
        absoluteMessageIndex: 0,
      }],
      offset: 0,
      nextOffset: 1,
      nextCursor: { sortValue: 1, createdAt: 1, rowId: 1 },
      total: 1,
    };
    const loadMessagePage = vi.fn(async () => oversizedPage);
    const renderController = () => {
      reactHookHarness.beginRender();
      // The test supplies a deterministic mocked React dispatcher.
      // eslint-disable-next-line react-hooks/rules-of-hooks
      return useCoworkConversationSearch({
        sessionId: 'session-1',
        currentMessages: [],
        currentTotalMessages: 1,
        loadMessagePage,
      });
    };

    let controller = renderController();
    controller.open();
    await flushPromiseChain();
    controller = renderController();

    expect(controller.status).toBe(ConversationSearchStatus.Error);
    expect(controller.errorReason).toBe(ConversationSearchErrorReason.HistoryTooLarge);
    expect(controller.matches).toEqual([]);
    expect(loadMessagePage).toHaveBeenCalledTimes(1);

    controller.open();
    await flushPromiseChain();
    expect(loadMessagePage).toHaveBeenCalledTimes(2);
  });
});
