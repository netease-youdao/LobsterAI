import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DAILY_CHECK_IN_AUTO_REFRESH_COOLDOWN_MS,
  DAILY_CHECK_IN_AUTO_REFRESH_INTERVAL_MS,
  DAILY_CHECK_IN_AUTO_REFRESH_JITTER_MS,
  DAILY_CHECK_IN_DAY_BOUNDARY_BUFFER_MS,
  type DailyCheckInAutoRefreshEnvironment,
  getDailyCheckInDayBoundaryDelay,
  startDailyCheckInAutoRefresh,
} from './dailyCheckInAutoRefresh';

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  focused = true;

  hasFocus(): boolean {
    return this.focused;
  }
}

const createEnvironment = (
  windowTarget: EventTarget,
  documentTarget: FakeDocument,
  overrides: Partial<DailyCheckInAutoRefreshEnvironment> = {},
): Partial<DailyCheckInAutoRefreshEnvironment> => ({
  windowTarget: windowTarget as unknown as Window,
  documentTarget: documentTarget as unknown as Document,
  now: Date.now,
  random: () => 0,
  ...overrides,
});

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('daily check-in auto refresh', () => {
  test('refreshes on focus and visible transitions with a one-minute cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const windowTarget = new EventTarget();
    const documentTarget = new FakeDocument();
    const refresh = vi.fn(() => Promise.resolve());
    const stop = startDailyCheckInAutoRefresh(
      refresh,
      createEnvironment(windowTarget, documentTarget),
    );

    windowTarget.dispatchEvent(new Event('focus'));
    expect(refresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DAILY_CHECK_IN_AUTO_REFRESH_COOLDOWN_MS - 1);
    windowTarget.dispatchEvent(new Event('focus'));
    expect(refresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    windowTarget.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(1);
    await flushPromises();

    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    documentTarget.visibilityState = 'visible';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(DAILY_CHECK_IN_AUTO_REFRESH_COOLDOWN_MS);
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
  });

  test('keeps only one refresh in flight across repeated triggers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const windowTarget = new EventTarget();
    const documentTarget = new FakeDocument();
    let resolveRefresh: (() => void) | undefined;
    const refresh = vi.fn(() => new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    }));
    const stop = startDailyCheckInAutoRefresh(
      refresh,
      createEnvironment(windowTarget, documentTarget),
    );

    vi.advanceTimersByTime(DAILY_CHECK_IN_AUTO_REFRESH_COOLDOWN_MS);
    windowTarget.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(DAILY_CHECK_IN_AUTO_REFRESH_COOLDOWN_MS);
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    windowTarget.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(1);

    resolveRefresh?.();
    await flushPromises();
    windowTarget.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
  });

  test('runs the jittered fallback only while visible and focused', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const windowTarget = new EventTarget();
    const documentTarget = new FakeDocument();
    const refresh = vi.fn(() => Promise.resolve());
    const fallbackDelay = DAILY_CHECK_IN_AUTO_REFRESH_INTERVAL_MS
      + DAILY_CHECK_IN_AUTO_REFRESH_JITTER_MS / 2;
    const stop = startDailyCheckInAutoRefresh(
      refresh,
      createEnvironment(windowTarget, documentTarget, {
        random: () => 0.5,
      }),
    );

    await vi.advanceTimersByTimeAsync(fallbackDelay - 1);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    documentTarget.focused = false;
    await vi.advanceTimersByTimeAsync(fallbackDelay);
    expect(refresh).toHaveBeenCalledTimes(1);

    documentTarget.focused = true;
    documentTarget.visibilityState = 'hidden';
    await vi.advanceTimersByTimeAsync(fallbackDelay);
    expect(refresh).toHaveBeenCalledTimes(1);

    documentTarget.visibilityState = 'visible';
    await vi.advanceTimersByTimeAsync(fallbackDelay);
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
  });

  test('calculates the next Asia/Shanghai business-day boundary', () => {
    expect(getDailyCheckInDayBoundaryDelay(
      '2026-08-11T15:59:59.500Z',
      'Asia/Shanghai',
    )).toBe(500 + DAILY_CHECK_IN_DAY_BOUNDARY_BUFFER_MS);
    expect(getDailyCheckInDayBoundaryDelay(
      '2026-08-11T16:00:00.000Z',
      'Asia/Shanghai',
    )).toBe(24 * 60 * 60 * 1000 + DAILY_CHECK_IN_DAY_BOUNDARY_BUFFER_MS);
    expect(getDailyCheckInDayBoundaryDelay('invalid', 'Asia/Shanghai')).toBeNull();
    expect(getDailyCheckInDayBoundaryDelay(
      '2026-08-11T16:00:00.000Z',
      'Invalid/Timezone',
    )).toBeNull();
  });
});
