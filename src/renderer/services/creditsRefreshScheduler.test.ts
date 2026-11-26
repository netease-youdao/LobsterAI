import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  CreditsRefreshReason,
  CreditsRefreshScheduler,
} from './creditsRefreshScheduler';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CreditsRefreshScheduler', () => {
  test('skips network refreshes while no surface is mounted and flushes on return to home', async () => {
    vi.useFakeTimers();
    let now = 10_000;
    const refresh = vi.fn().mockResolvedValue(true);
    const scheduler = new CreditsRefreshScheduler({
      canRefresh: () => true,
      refresh,
      isPageVisible: () => true,
      now: () => now,
      activityThrottleMs: 4_000,
      activityCoalesceMs: 600,
    });

    scheduler.notifyActivity();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).not.toHaveBeenCalled();

    const release = scheduler.acquireSurface();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    release();
  });

  test('coalesces burst activity and throttles trailing updates while a task runs', async () => {
    vi.useFakeTimers();
    let now = 10_000;
    const refresh = vi.fn().mockResolvedValue(true);
    const scheduler = new CreditsRefreshScheduler({
      canRefresh: () => true,
      refresh,
      isPageVisible: () => true,
      now: () => now,
      activityThrottleMs: 4_000,
      activityCoalesceMs: 600,
    });

    const release = scheduler.acquireSurface();

    // First step finishes: waits for short settle delay before refreshing.
    scheduler.notifyActivity();
    now += 300;
    await vi.advanceTimersByTimeAsync(300);
    expect(refresh).not.toHaveBeenCalled();

    now += 300;
    await vi.advanceTimersByTimeAsync(300);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Burst of steps inside the 4s throttle window collapses into one trailing refresh.
    now += 1_000;
    scheduler.notifyActivity();
    now += 1_000;
    scheduler.notifyActivity();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(refresh).toHaveBeenCalledTimes(1);

    now += 2_000;
    await vi.advanceTimersByTimeAsync(1_001);
    expect(refresh).toHaveBeenCalledTimes(2);

    release();
  });

  test('markSynced cancels a pending coalesce timer so short turns do not double-fetch', async () => {
    vi.useFakeTimers();
    let now = 10_000;
    const refresh = vi.fn().mockResolvedValue(true);
    const scheduler = new CreditsRefreshScheduler({
      canRefresh: () => true,
      refresh,
      isPageVisible: () => true,
      now: () => now,
      activityThrottleMs: 4_000,
      activityCoalesceMs: 600,
    });

    const release = scheduler.acquireSurface();
    scheduler.notifyActivity();
    now += 50;
    scheduler.markSynced(now);

    now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).not.toHaveBeenCalled();

    release();
  });

  test('pauses activity while page is hidden and flushes once visible again', async () => {
    vi.useFakeTimers();
    let visible = false;
    let now = 10_000;
    const refresh = vi.fn().mockResolvedValue(true);
    const scheduler = new CreditsRefreshScheduler({
      canRefresh: () => true,
      refresh,
      isPageVisible: () => visible,
      now: () => now,
    });

    const release = scheduler.acquireSurface();
    scheduler.notifyActivity();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).not.toHaveBeenCalled();

    visible = true;
    now += 10_000;
    scheduler.handleVisibilityChange();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    release();
  });

  test('throttles hover refreshes with a 2s cooldown while manual refresh bypasses cooldown', async () => {
    vi.useFakeTimers();
    let now = 20_000;
    const refresh = vi.fn().mockResolvedValue(true);
    const scheduler = new CreditsRefreshScheduler({
      canRefresh: () => true,
      refresh,
      isPageVisible: () => true,
      now: () => now,
      hoverThrottleMs: 2_000,
    });

    await expect(scheduler.requestRefresh(CreditsRefreshReason.Hover)).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Within 2s hover cooldown: skipped.
    now += 1_000;
    await expect(scheduler.requestRefresh(CreditsRefreshReason.Hover)).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Manual refresh bypasses hover cooldown immediately.
    await expect(scheduler.requestRefresh(CreditsRefreshReason.Manual)).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);

    // After 2s cooldown: hover refreshes again.
    now += 2_000;
    await expect(scheduler.requestRefresh(CreditsRefreshReason.Hover)).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  test('schedules one follow-up refresh when activity arrives during an in-flight request', async () => {
    vi.useFakeTimers();
    let now = 30_000;
    let resolveFirst!: (value: boolean) => void;
    const refresh = vi.fn<() => Promise<boolean>>()
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(true);

    const scheduler = new CreditsRefreshScheduler({
      canRefresh: () => true,
      refresh,
      isPageVisible: () => true,
      now: () => now,
      activityThrottleMs: 4_000,
      activityCoalesceMs: 600,
    });

    const states: boolean[] = [];
    const unsubscribe = scheduler.subscribeRefreshing(state => states.push(state));
    const release = scheduler.acquireSurface();

    const firstPromise = scheduler.requestRefresh(CreditsRefreshReason.Manual);
    expect(scheduler.isRefreshing()).toBe(true);
    scheduler.notifyActivity();

    resolveFirst(true);
    await firstPromise;
    expect(scheduler.isRefreshing()).toBe(false);

    now += 4_000;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(states).toEqual([true, false, true, false]);

    unsubscribe();
    release();
  });

  test('reset cancels pending timers and drops stale in-flight completion', async () => {
    vi.useFakeTimers();
    let now = 40_000;
    let resolvePending!: (value: boolean) => void;
    const refresh = vi.fn<() => Promise<boolean>>()
      .mockImplementationOnce(() => new Promise(resolve => { resolvePending = resolve; }));

    const scheduler = new CreditsRefreshScheduler({
      canRefresh: () => true,
      refresh,
      isPageVisible: () => true,
      now: () => now,
    });

    const release = scheduler.acquireSurface();
    const pending = scheduler.requestRefresh(CreditsRefreshReason.Manual);
    scheduler.notifyActivity();

    scheduler.reset();
    expect(scheduler.isRefreshing()).toBe(false);

    resolvePending(true);
    await expect(pending).resolves.toBe(false);

    now += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    release();
  });
});
