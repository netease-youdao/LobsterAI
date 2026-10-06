import { afterEach, describe, expect, test, vi } from 'vitest';

import { LibraryChangeReason } from '../../../shared/library/constants';
import { LibraryRefreshCoordinator, LibraryRefreshOutcome } from './libraryRefreshCoordinator';

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('LibraryRefreshCoordinator', () => {
  test('coalesces an event storm into one quiet-window refresh', async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async batch => { batches.push(batch.itemIds); },
    });
    coordinator.setActive(true);

    for (let index = 0; index < 100; index += 1) {
      coordinator.enqueue({
        reason: LibraryChangeReason.Recorded,
        itemIds: [`item-${index}`],
      });
    }
    await vi.advanceTimersByTimeAsync(299);
    expect(batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(100);
  });

  test('flushes at the maximum wait while events continue arriving', async () => {
    vi.useFakeTimers();
    const batches: number[] = [];
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async batch => { batches.push(batch.eventCount); },
    });
    coordinator.setActive(true);

    coordinator.enqueue({ reason: LibraryChangeReason.FileChanged, itemIds: ['first'] });
    for (let index = 0; index < 4; index += 1) {
      await vi.advanceTimersByTimeAsync(250);
      if (index < 3) {
        coordinator.enqueue({
          reason: LibraryChangeReason.FileChanged,
          itemIds: [`next-${index}`],
        });
      }
    }

    expect(batches).toEqual([4]);
  });

  test('allows only one in-flight refresh and one aggregated trailing refresh', async () => {
    vi.useFakeTimers();
    let resolveFirst: (() => void) | undefined;
    const first = new Promise<void>(resolve => { resolveFirst = resolve; });
    const batches: string[][] = [];
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async batch => {
        batches.push(batch.itemIds);
        if (batches.length === 1) await first;
      },
    });
    coordinator.setActive(true);
    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['first'] });
    await vi.advanceTimersByTimeAsync(300);

    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['second'] });
    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['third'] });
    await vi.advanceTimersByTimeAsync(300);
    expect(batches).toEqual([['first']]);

    resolveFirst?.();
    await flushPromises();
    expect(batches).toEqual([['first'], ['second', 'third']]);
  });

  test('keeps a hidden page dirty and flushes once when it becomes active', async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async batch => { batches.push(batch.itemIds); },
    });
    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['hidden'] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(batches).toEqual([]);

    coordinator.setActive(true);
    await flushPromises();
    expect(batches).toEqual([['hidden']]);
  });

  test('marks repair and legacy ID-less changes for authoritative refresh', async () => {
    vi.useFakeTimers();
    const authoritative: boolean[] = [];
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async batch => { authoritative.push(batch.requiresAuthoritativeRefresh); },
    });
    coordinator.setActive(true);
    coordinator.enqueue({ reason: LibraryChangeReason.Repair, itemIds: ['known'] });
    coordinator.enqueue({ reason: LibraryChangeReason.SessionDeleted });
    await vi.advanceTimersByTimeAsync(300);

    expect(authoritative).toEqual([true]);
  });

  test('flushes an explicit refresh immediately without waiting for the quiet window', async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async batch => { batches.push(batch.itemIds); },
    });
    coordinator.setActive(true);
    coordinator.enqueue({ reason: LibraryChangeReason.Repair, itemIds: ['manual'] });

    coordinator.flushNow();
    await flushPromises();

    expect(batches).toEqual([['manual']]);
  });

  test('cancels scheduled work after disposal', async () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const coordinator = new LibraryRefreshCoordinator({ onFlush });
    coordinator.setActive(true);
    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['disposed'] });

    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onFlush).not.toHaveBeenCalled();
  });

  test('drops trailing work when an in-flight refresh settles after disposal', async () => {
    vi.useFakeTimers();
    let resolveFirst: (() => void) | undefined;
    const first = new Promise<void>(resolve => { resolveFirst = resolve; });
    const batches: string[][] = [];
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async batch => {
        batches.push(batch.itemIds);
        await first;
      },
    });
    coordinator.setActive(true);
    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['first'] });
    await vi.advanceTimersByTimeAsync(300);
    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['trailing'] });

    coordinator.dispose();
    resolveFirst?.();
    await flushPromises();

    expect(batches).toEqual([['first']]);
  });

  test('immediately invalidates favorites even while hidden or an external append is busy', async () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const onInvalidate = vi.fn();
    const coordinator = new LibraryRefreshCoordinator({ onFlush, onInvalidate });
    coordinator.setBusy(true);
    coordinator.enqueue({ reason: LibraryChangeReason.Favorite, itemIds: ['favorite'] });
    expect(onInvalidate).toHaveBeenCalledTimes(1);
    coordinator.setActive(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onFlush).not.toHaveBeenCalled();
    coordinator.setBusy(false);
    await flushPromises();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0].reasons).toEqual([LibraryChangeReason.Favorite]);
  });

  test('always revalidates session projections, including non-owner session IDs', async () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const coordinator = new LibraryRefreshCoordinator({ onFlush });
    coordinator.setActive(true);
    coordinator.enqueue({
      reason: LibraryChangeReason.SessionProjectionChanged,
      itemIds: ['known'], sessionIds: ['owner', 'non-owner'],
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(onFlush.mock.calls[0][0]).toMatchObject({
      requiresAuthoritativeRefresh: true, sessionIds: ['owner', 'non-owner'],
    });
  });

  test('shares one immediate retry then requires a full quiet period despite continuing events', async () => {
    vi.useFakeTimers();
    const attempts: boolean[] = [];
    let stable = false;
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async batch => {
        attempts.push(batch.immediateRetryAvailable);
        return stable ? LibraryRefreshOutcome.Committed : LibraryRefreshOutcome.Invalidated;
      },
    });
    coordinator.setActive(true);
    coordinator.enqueue({ reason: LibraryChangeReason.FileChanged, itemIds: ['first'] });
    await vi.advanceTimersByTimeAsync(300);
    expect(attempts).toEqual([true, false]);
    for (let index = 0; index < 8; index += 1) {
      await vi.advanceTimersByTimeAsync(250);
      coordinator.enqueue({ reason: LibraryChangeReason.FileChanged, itemIds: [`event-${index}`] });
    }
    expect(attempts).toEqual([true, false]);
    stable = true;
    await vi.advanceTimersByTimeAsync(999);
    expect(attempts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toEqual([true, false, true]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempts).toHaveLength(3);
  });

  test('does not let an already scheduled max-wait timer bypass invalidation backoff', async () => {
    vi.useFakeTimers();
    let finishSecond: (() => void) | undefined;
    const second = new Promise<void>(resolve => { finishSecond = resolve; });
    let attempts = 0;
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async () => {
        attempts += 1;
        if (attempts === 2) await second;
        return LibraryRefreshOutcome.Invalidated;
      },
    });
    coordinator.setActive(true);
    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['start'] });
    await vi.advanceTimersByTimeAsync(300);
    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['during-second'] });
    await vi.advanceTimersByTimeAsync(100);
    finishSecond?.();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(900);
    expect(attempts).toBe(2);
    coordinator.dispose();
  });

  test('does not repeat a stopped budget or request failure in the same epoch', async () => {
    vi.useFakeTimers();
    const onFlush = vi.fn(async () => LibraryRefreshOutcome.Stopped);
    const coordinator = new LibraryRefreshCoordinator({ onFlush });
    coordinator.setActive(true);
    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['first'] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFlush).toHaveBeenCalledTimes(1);
    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['new-epoch'] });
    await vi.advanceTimersByTimeAsync(300);
    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  test('query changes prevent a stale in-flight attempt from creating retry work', async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const onFlush = vi.fn(async () => {
      await pending;
      return LibraryRefreshOutcome.Invalidated;
    });
    const coordinator = new LibraryRefreshCoordinator({ onFlush });
    coordinator.setActive(true);
    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['old-query'] });
    await vi.advanceTimersByTimeAsync(300);
    coordinator.resetPending();
    finish?.();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  test('an explicit manual reset can leave backoff and refresh immediately', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async () => {
        attempts += 1;
        return attempts <= 2 ? LibraryRefreshOutcome.Invalidated : LibraryRefreshOutcome.Committed;
      },
    });
    coordinator.setActive(true);
    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['first'] });
    await vi.advanceTimersByTimeAsync(300);
    expect(attempts).toBe(2);
    coordinator.resetRetries();
    coordinator.flushNow();
    await flushPromises();
    expect(attempts).toBe(3);
  });

  test('an external append failure consumes the same immediate retry allowance', async () => {
    vi.useFakeTimers();
    const attempts: boolean[] = [];
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async batch => {
        attempts.push(batch.immediateRetryAvailable);
        return attempts.length === 1 ? LibraryRefreshOutcome.Invalidated : LibraryRefreshOutcome.Committed;
      },
    });
    coordinator.setActive(true);
    expect(coordinator.consumeImmediateRetry()).toBe(true);
    expect(coordinator.consumeImmediateRetry()).toBe(false);
    coordinator.enqueue({ reason: LibraryChangeReason.Repair });
    await vi.advanceTimersByTimeAsync(300);
    expect(attempts).toEqual([false]);
    await vi.advanceTimersByTimeAsync(999);
    expect(attempts).toEqual([false]);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toEqual([false, true]);
    expect(coordinator.consumeImmediateRetry()).toBe(true);
  });

  test('a repeated cursor failure after an external page failure can stop without a third read', async () => {
    vi.useFakeTimers();
    const attempts: boolean[] = [];
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async batch => {
        attempts.push(batch.immediateRetryAvailable);
        return batch.immediateRetryAvailable ? LibraryRefreshOutcome.Invalidated : LibraryRefreshOutcome.Stopped;
      },
    });
    coordinator.setActive(true);
    coordinator.consumeImmediateRetry();
    coordinator.enqueue({ reason: LibraryChangeReason.Repair });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toEqual([false]);
  });
});
