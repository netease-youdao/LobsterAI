import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  alignRailTargetInContainer,
  getRailTargetScrollTop,
  RAIL_NAVIGATION_PAGINATION_RELEASE_DELAY_MS,
  RAIL_NAVIGATION_SETTLE_DELAYS_MS,
  RAIL_NAVIGATION_TOP_OFFSET_PX,
  RailNavigationMode,
  type RailNavigationScrollContainer,
  resolveRailNavigationMode,
  scheduleRailNavigationSettle,
  shouldAdjustRailTargetScroll,
} from './conversationRailNavigation';

afterEach(() => {
  vi.useRealTimers();
});

const createMockContainer = (
  initial: { scrollTop: number; scrollHeight: number; clientHeight: number; top?: number },
) => {
  const listeners = new Map<string, Set<EventListener>>();
  const scrollCalls: Array<{ top: number; behavior: ScrollBehavior }> = [];
  const container: RailNavigationScrollContainer = {
    scrollTop: initial.scrollTop,
    scrollHeight: initial.scrollHeight,
    clientHeight: initial.clientHeight,
    getBoundingClientRect: () => ({ top: initial.top ?? 100 }),
    scrollTo: ({ top, behavior }) => {
      scrollCalls.push({ top, behavior });
      container.scrollTop = top;
    },
    addEventListener: (type, listener) => {
      let bucket = listeners.get(type);
      if (!bucket) {
        bucket = new Set();
        listeners.set(type, bucket);
      }
      bucket.add(listener);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
  };

  const dispatch = (type: string) => {
    listeners.get(type)?.forEach(listener => listener({} as Event));
  };

  return { container, scrollCalls, dispatch, listeners };
};

describe('resolveRailNavigationMode', () => {
  test('never falls back to DOM scroll when an indexed turn is outside the loaded page window', () => {
    expect(resolveRailNavigationMode({
      messageId: 'turn-1-user',
      turnIndex: -1,
      isLoaded: false,
    }, false)).toBe(RailNavigationMode.LoadMessageWindow);
  });

  test('scrolls mounted DOM immediately when the exact message element is rendered', () => {
    expect(resolveRailNavigationMode({
      messageId: 'turn-23-user',
      turnIndex: 0,
      isLoaded: true,
    }, true)).toBe(RailNavigationMode.ScrollLoadedDom);
  });

  test('force-renders a loaded turn that is currently collapsed by LazyRenderTurn', () => {
    expect(resolveRailNavigationMode({
      messageId: 'turn-20-user',
      turnIndex: 0,
      isLoaded: true,
    }, false)).toBe(RailNavigationMode.ForceRenderLoadedTurn);
  });

  test('refreshes the full rail index first when clicking a placeholder item', () => {
    expect(resolveRailNavigationMode({
      messageId: null,
      turnIndex: -1,
      isLoaded: false,
      isPlaceholder: true,
    }, false)).toBe(RailNavigationMode.RefreshRailIndex);
  });
});

describe('getRailTargetScrollTop & alignRailTargetInContainer', () => {
  test('aligns the target element with the container top inset and clamps within scroll bounds', () => {
    const { container, scrollCalls } = createMockContainer({
      scrollTop: 500,
      scrollHeight: 2000,
      clientHeight: 600,
      top: 100,
    });

    // Target is 250px below the container top -> desired scrollTop = 500 + 250 - 12 = 738
    expect(getRailTargetScrollTop(container, 350)).toBe(738);
    expect(alignRailTargetInContainer(container, { top: 350 }, 'auto')).toBe(true);
    expect(scrollCalls).toEqual([{ top: 738, behavior: 'auto' }]);

    // Clamps to 0 at the top and maxScrollTop at the bottom
    expect(getRailTargetScrollTop(container, 100)).toBe(726);
    container.scrollTop = 0;
    expect(getRailTargetScrollTop(container, 100 + RAIL_NAVIGATION_TOP_OFFSET_PX)).toBe(0);
    expect(getRailTargetScrollTop(container, 5000)).toBe(1400);
  });

  test('skips redundant adjustments within tolerance', () => {
    expect(shouldAdjustRailTargetScroll(100, 103)).toBe(false);
    expect(shouldAdjustRailTargetScroll(100, 105)).toBe(true);
  });
});

describe('scheduleRailNavigationSettle', () => {
  test('re-pins the jumped-to target after layout shifts and releases once settled', () => {
    vi.useFakeTimers();
    const { container, scrollCalls } = createMockContainer({
      scrollTop: 400,
      scrollHeight: 3000,
      clientHeight: 600,
      top: 100,
    });
    // Simulate a lazy turn above expanding by 320px right after landing
    let targetTop = 100 + RAIL_NAVIGATION_TOP_OFFSET_PX + 320;
    const onRelease = vi.fn();

    scheduleRailNavigationSettle({
      isCurrent: () => true,
      getContainer: () => container,
      getContentElement: () => null,
      getTargetRect: () => ({ top: targetTop }),
      allowContinuousCorrection: true,
      onRelease,
    });

    vi.advanceTimersByTime(RAIL_NAVIGATION_SETTLE_DELAYS_MS[0]);
    expect(scrollCalls).toEqual([{ top: 720, behavior: 'auto' }]);
    targetTop = 100 + RAIL_NAVIGATION_TOP_OFFSET_PX;

    vi.advanceTimersByTime(
      RAIL_NAVIGATION_SETTLE_DELAYS_MS[RAIL_NAVIGATION_SETTLE_DELAYS_MS.length - 1]
      + RAIL_NAVIGATION_PAGINATION_RELEASE_DELAY_MS,
    );
    expect(scrollCalls).toHaveLength(1);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  test('yields immediately when the user scrolls manually', () => {
    vi.useFakeTimers();
    const { container, scrollCalls, dispatch } = createMockContainer({
      scrollTop: 400,
      scrollHeight: 3000,
      clientHeight: 600,
      top: 100,
    });
    const onRelease = vi.fn();

    scheduleRailNavigationSettle({
      isCurrent: () => true,
      getContainer: () => container,
      getContentElement: () => null,
      getTargetRect: () => ({ top: 420 }),
      allowContinuousCorrection: true,
      onRelease,
    });

    dispatch('wheel');
    expect(onRelease).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    expect(scrollCalls).toHaveLength(0);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  test('cancels cleanly without invoking onRelease when superseded by a newer click', () => {
    vi.useFakeTimers();
    const { container, scrollCalls } = createMockContainer({
      scrollTop: 400,
      scrollHeight: 3000,
      clientHeight: 600,
      top: 100,
    });
    const onRelease = vi.fn();

    const cancel = scheduleRailNavigationSettle({
      isCurrent: () => true,
      getContainer: () => container,
      getContentElement: () => null,
      getTargetRect: () => ({ top: 420 }),
      allowContinuousCorrection: true,
      onRelease,
    });

    cancel();
    vi.advanceTimersByTime(2000);
    expect(scrollCalls).toHaveLength(0);
    expect(onRelease).not.toHaveBeenCalled();
  });
});
