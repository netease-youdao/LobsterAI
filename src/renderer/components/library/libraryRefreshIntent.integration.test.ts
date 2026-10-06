import { afterEach, describe, expect, test, vi } from 'vitest';

import { LibraryChangeReason } from '../../../shared/library/constants';
import {
  type LibraryRefreshBatch,
  LibraryRefreshCoordinator,
  LibraryRefreshOutcome,
  LibraryRefreshTiming,
} from './libraryRefreshCoordinator';

afterEach(() => vi.useRealTimers());

describe('manual refresh superseding an in-flight background batch', () => {
  test.each([
    LibraryRefreshOutcome.Invalidated,
    LibraryRefreshOutcome.Committed,
    LibraryRefreshOutcome.Stopped,
  ])('old %s completion cannot consume or requeue into the new manual retry budget', async oldOutcome => {
    vi.useFakeTimers();
    let finishBackground!: () => void;
    const pendingBackground = new Promise<void>(resolve => { finishBackground = resolve; });
    const batches: LibraryRefreshBatch[] = [];
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async batch => {
        batches.push(batch);
        if (batches.length === 1) {
          await pendingBackground;
          return oldOutcome;
        }
        // The new manual read drifts once and must still have its own retry.
        return batches.length === 2
          ? LibraryRefreshOutcome.Invalidated
          : LibraryRefreshOutcome.Committed;
      },
    });
    coordinator.setActive(true);
    coordinator.enqueue({
      reason: LibraryChangeReason.SessionProjectionChanged,
      sessionIds: ['old-session'], itemIds: ['old-file'],
    });
    coordinator.flushNow();
    expect(batches).toHaveLength(1);

    // This is the public reset/enqueue/flush sequence used by handleRefresh.
    coordinator.resetPending();
    coordinator.enqueue({ reason: LibraryChangeReason.Repair });
    coordinator.flushNow();
    expect(batches).toHaveLength(1); // The old physical read still owns the slot.

    finishBackground();
    await vi.advanceTimersByTimeAsync(LibraryRefreshTiming.QuietWindowMs);
    expect(batches.map(batch => batch.immediateRetryAvailable)).toEqual([true, true, false]);
    for (const batch of batches.slice(1)) {
      expect(batch.reasons).toEqual([LibraryChangeReason.Repair]);
      expect(batch.sessionIds).toEqual([]);
      expect(batch.itemIds).toEqual([]);
      expect(batch.requiresAuthoritativeRefresh).toBe(true);
    }
    await vi.advanceTimersByTimeAsync(LibraryRefreshTiming.StableWindowMs * 2);
    expect(batches).toHaveLength(3);
    coordinator.dispose();
  });
});
