import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { CoworkSearchMessagePage } from '../../../shared/cowork/search';

// A minimal React dispatcher that, unlike a no-op `useEffect`, re-runs an effect
// only when its dependencies change. The bug covered here depends on exactly that.
const reactHookHarness = vi.hoisted(() => {
  type EffectCleanup = void | (() => void);
  interface EffectSlot {
    deps?: unknown[];
    cleanup?: EffectCleanup;
    pending?: () => EffectCleanup;
  }
  let stateCursor = 0;
  let refCursor = 0;
  let effectCursor = 0;
  let callbackCursor = 0;
  let states: unknown[] = [];
  let callbacks: Array<{ value: unknown; deps?: unknown[] }> = [];
  let refs: Array<{ current: unknown }> = [];
  let effects: EffectSlot[] = [];

  const depsChanged = (previous: unknown[] | undefined, next: unknown[] | undefined): boolean => (
    !previous
    || !next
    || previous.length !== next.length
    || previous.some((value, index) => !Object.is(value, next[index]))
  );

  return {
    beginRender: () => {
      stateCursor = 0;
      refCursor = 0;
      effectCursor = 0;
      callbackCursor = 0;
    },
    commitEffects: () => {
      for (const slot of effects) {
        if (!slot.pending) continue;
        const run = slot.pending;
        slot.pending = undefined;
        if (typeof slot.cleanup === 'function') slot.cleanup();
        slot.cleanup = run();
      }
    },
    reset: () => {
      stateCursor = 0;
      refCursor = 0;
      effectCursor = 0;
      callbackCursor = 0;
      states = [];
      refs = [];
      effects = [];
      callbacks = [];
    },
    useCallback: <T,>(callback: T, deps?: unknown[]): T => {
      const index = callbackCursor;
      callbackCursor += 1;
      if (index >= callbacks.length || depsChanged(callbacks[index].deps, deps)) {
        callbacks[index] = { value: callback, deps };
      }
      return callbacks[index].value as T;
    },
    useEffect: (effect: () => EffectCleanup, deps?: unknown[]) => {
      const index = effectCursor;
      effectCursor += 1;
      if (index >= effects.length) effects.push({});
      const slot = effects[index];
      if (depsChanged(slot.deps, deps)) {
        slot.deps = deps;
        slot.pending = effect;
      }
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
  useCallback: reactHookHarness.useCallback,
  useEffect: reactHookHarness.useEffect,
  useMemo: <T,>(factory: () => T): T => factory(),
  useRef: reactHookHarness.useRef,
  useState: reactHookHarness.useState,
}));

import { useCoworkConversationSearch } from './useCoworkConversationSearch';

const QUERY = '新版本多久能被用户接受';

const page: CoworkSearchMessagePage = {
  messages: [{
    id: 'summary',
    type: 'assistant',
    content: '总结：这张图回答的核心问题就是——**新版本多久能被用户接受、哪个版本接受得最快**。',
    timestamp: 1,
    absoluteMessageIndex: 0,
  }],
  offset: 0,
  nextOffset: 1,
  nextCursor: { sortValue: 1, createdAt: 1, rowId: 1 },
  total: 1,
};

const flushPromiseChain = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
};

describe('useCoworkConversationSearch re-applied query', () => {
  beforeEach(() => {
    reactHookHarness.reset();
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('keeps its matches when the open search is given the same query again', async () => {
    const loadMessagePage = vi.fn(async () => page);
    const render = () => {
      reactHookHarness.beginRender();
      // The test supplies a deterministic mocked React dispatcher.
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const controller = useCoworkConversationSearch({
        sessionId: 'session-1',
        currentMessages: [],
        currentTotalMessages: 1,
        loadMessagePage,
        debounceMs: 0,
      });
      reactHookHarness.commitEffects();
      return controller;
    };
    const settle = async () => {
      await flushPromiseChain();
      render();
      await vi.advanceTimersByTimeAsync(0);
      await flushPromiseChain();
      return render();
    };

    let controller = render();
    controller.open();
    controller.setQuery(QUERY);
    controller = await settle();
    expect(controller.matches).toHaveLength(1);
    expect(controller.activeMatchIndex).toBe(0);

    // Picking the same task-search hit again re-applies the query to the open search.
    controller.open();
    controller.setQuery(QUERY);
    controller = await settle();
    expect(controller.matches).toHaveLength(1);
    expect(controller.activeMatchIndex).toBe(0);
    expect(loadMessagePage).toHaveBeenCalledTimes(1);
  });
});
