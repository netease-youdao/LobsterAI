import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  CONVERSATION_SEARCH_CENTER_TOLERANCE_PX,
  getConversationSearchCenterDelta,
  isUsableConversationSearchRect,
  scheduleConversationSearchSettle,
  shouldCorrectConversationSearchPosition,
} from './conversationSearchNavigation';

afterEach(() => {
  vi.useRealTimers();
});

describe('conversationSearchNavigation', () => {
  test('computes the delta required to center a search result', () => {
    expect(getConversationSearchCenterDelta(
      { top: 100 },
      600,
      { top: 700, height: 20 },
    )).toBe(310);
  });

  test('rejects hidden or invalid search ranges', () => {
    expect(isUsableConversationSearchRect({ top: 10, width: 20, height: 16 })).toBe(true);
    expect(isUsableConversationSearchRect({ top: 0, width: 0, height: 0 })).toBe(false);
    expect(isUsableConversationSearchRect({ top: Number.NaN, width: 20, height: 16 })).toBe(false);
  });

  test('only corrects layout drift outside the centering tolerance', () => {
    expect(shouldCorrectConversationSearchPosition(
      CONVERSATION_SEARCH_CENTER_TOLERANCE_PX,
    )).toBe(false);
    expect(shouldCorrectConversationSearchPosition(
      CONVERSATION_SEARCH_CENTER_TOLERANCE_PX + 1,
    )).toBe(true);
    expect(shouldCorrectConversationSearchPosition(
      -(CONVERSATION_SEARCH_CENTER_TOLERANCE_PX + 1),
    )).toBe(true);
  });

  test('corrects delayed layout drift and releases pagination after settling', () => {
    vi.useFakeTimers();
    let scrollTop = 0;
    let targetTop = 100;
    const onSettled = vi.fn();
    const onRelease = vi.fn();

    scheduleConversationSearchSettle({
      isCurrent: () => true,
      getContainer: () => ({
        scrollTop,
        clientHeight: 100,
        getBoundingClientRect: () => ({ top: 0, width: 100, height: 100 }),
        scrollTo: ({ top }) => {
          targetTop -= top - scrollTop;
          scrollTop = top;
        },
      }),
      getTargetRect: () => ({ top: targetTop, width: 20, height: 20 }),
      onSettled,
      onTargetUnavailable: vi.fn(),
      onError: vi.fn(),
      onRelease,
    });

    vi.advanceTimersByTime(1400);
    expect(scrollTop).toBe(60);
    expect(onSettled).toHaveBeenCalledWith({ correctionCount: 1, observedDelta: 0 });
    expect(onRelease).not.toHaveBeenCalled();

    vi.advanceTimersByTime(120);
    expect(onRelease).toHaveBeenCalledOnce();
  });

  test('cancels settle checks without retaining timers', () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    const onRelease = vi.fn();
    const cancel = scheduleConversationSearchSettle({
      isCurrent: () => true,
      getContainer: () => null,
      getTargetRect: () => null,
      onSettled,
      onTargetUnavailable: vi.fn(),
      onError: vi.fn(),
      onRelease,
    });

    cancel();
    vi.runAllTimers();

    expect(onSettled).not.toHaveBeenCalled();
    expect(onRelease).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('releases pagination when the navigation request becomes stale', () => {
    vi.useFakeTimers();
    const onRelease = vi.fn();
    scheduleConversationSearchSettle({
      isCurrent: () => false,
      getContainer: () => null,
      getTargetRect: () => null,
      onSettled: vi.fn(),
      onTargetUnavailable: vi.fn(),
      onError: vi.fn(),
      onRelease,
    });

    vi.advanceTimersByTime(120);

    expect(onRelease).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('releases pagination and clears timers when a geometry check fails', () => {
    vi.useFakeTimers();
    const error = new Error('detached viewport');
    const onError = vi.fn();
    const onRelease = vi.fn();
    scheduleConversationSearchSettle({
      isCurrent: () => true,
      getContainer: () => {
        throw error;
      },
      getTargetRect: () => null,
      onSettled: vi.fn(),
      onTargetUnavailable: vi.fn(),
      onError,
      onRelease,
    });

    vi.advanceTimersByTime(120);

    expect(onError).toHaveBeenCalledWith(error);
    expect(onRelease).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
