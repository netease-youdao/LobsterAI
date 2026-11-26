import { OwnershipSyncState, OwnershipTargetKind } from '@shared/ownership/constants';
import type { OwnershipDetail, OwnershipTarget } from '@shared/ownership/types';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => {
  let state: unknown = null;
  let dependencies: unknown[] | undefined;
  let cleanup: (() => void) | void;
  return {
    revision: 0,
    getDetail: vi.fn(),
    useState: () => [state, (value: unknown) => { state = value; }],
    useEffect: (effect: () => (() => void) | void, next: unknown[]) => {
      if (dependencies?.every((value, index) => Object.is(value, next[index]))) return;
      cleanup?.();
      dependencies = next;
      cleanup = effect();
    },
    reset: () => {
      cleanup?.();
      cleanup = undefined;
      dependencies = undefined;
      state = null;
    },
  };
});
vi.mock('react', () => ({
  useState: harness.useState,
  useEffect: harness.useEffect,
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => number) => getSnapshot(),
}));
vi.mock('../../services/ownership', () => ({ ownershipService: {
  subscribeChange: vi.fn(),
  getRevision: () => harness.revision,
  getDetail: harness.getDetail,
} }));

import { useOwnershipDetail } from './useOwnershipDetail';

const target: OwnershipTarget = { kind: OwnershipTargetKind.Task, id: 'task-a' };
const pending: OwnershipDetail = {
  ...target, title: 'Task A', ownership: { kind: 'owned', label: 'A', scopeLabel: 'Personal' },
  deviceName: 'Desktop', syncState: OwnershipSyncState.Pending, canAssociate: false, accountPartition: 'account-a',
};
const synced: OwnershipDetail = { ...pending, syncState: OwnershipSyncState.Synced };
const listeners = new Set<() => void>();
const unsubscribe = vi.fn();
const onChanged = vi.fn((listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); unsubscribe(); };
});
function render(enabled = true, nextTarget = target) {
  // The deterministic dispatcher above runs effect cleanup on dependency changes.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useOwnershipDetail(nextTarget, enabled);
}
function emit() { listeners.forEach(listener => listener()); }
function deferred() {
  let resolve!: (detail: OwnershipDetail) => void;
  const promise = new Promise<OwnershipDetail>(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  vi.clearAllMocks();
  harness.revision = 0;
  harness.getDetail.mockReset().mockResolvedValue(pending);
  vi.stubGlobal('window', { electron: { remote: { onChanged } } });
});
afterEach(() => {
  harness.reset();
  listeners.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ownership hover detail refresh', () => {
  test('does no work while the hover is closed', async () => {
    expect(render(false)).toBeNull();
    emit();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.getDetail).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  test('coalesces remote events and keeps detail visible until the refreshed status arrives', async () => {
    expect(render()).toBeNull();
    await settle();
    expect(render()).toEqual(pending);
    const refreshing = deferred();
    harness.getDetail.mockReturnValueOnce(refreshing.promise);
    for (let i = 0; i < 50; i++) emit();
    await vi.advanceTimersByTimeAsync(2999);
    expect(harness.getDetail).toHaveBeenCalledTimes(1);
    expect(render()).toEqual(pending);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.getDetail).toHaveBeenCalledTimes(2);
    expect(render()).toEqual(pending);
    refreshing.resolve(synced);
    await settle();
    expect(render()).toEqual(synced);
    expect(harness.revision).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.getDetail).toHaveBeenCalledTimes(2);
  });

  test('serializes reads and retains a notification received during an in-flight read', async () => {
    const initial = deferred();
    harness.getDetail.mockReturnValueOnce(initial.promise).mockResolvedValueOnce(synced);
    render();
    for (let i = 0; i < 10; i++) emit();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.getDetail).toHaveBeenCalledTimes(1);
    initial.resolve(pending);
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.getDetail).toHaveBeenCalledTimes(2);
    expect(render()).toEqual(synced);
  });

  test('unsubscribes and cancels queued refreshes when the hover closes', async () => {
    render();
    await settle();
    emit();
    expect(render(false)).toBeNull();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    emit();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.getDetail).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  test('ignores a response arriving after the hover closes', async () => {
    const initial = deferred();
    harness.getDetail.mockReturnValueOnce(initial.promise);
    render();
    render(false);
    initial.resolve(synced);
    await settle();
    expect(render()).toBeNull();
    await settle();
    expect(render()).toEqual(pending);
  });

  test('hides old detail on target changes and ignores the previous target response', async () => {
    render();
    await settle();
    const stale = deferred();
    harness.getDetail.mockReturnValueOnce(stale.promise);
    emit();
    await vi.advanceTimersByTimeAsync(3000);
    const nextTarget = { ...target, id: 'task-b' };
    const nextDetail = { ...pending, ...nextTarget, title: 'Task B' };
    harness.getDetail.mockResolvedValueOnce(nextDetail);
    expect(render(true, nextTarget)).toBeNull();
    await settle();
    expect(render(true, nextTarget)).toEqual(nextDetail);
    stale.resolve(synced);
    await settle();
    expect(render(true, nextTarget)).toEqual(nextDetail);
  });

  test('immediately hides detail across ownership revisions and rejects a stale account response', async () => {
    render();
    await settle();
    const stale = deferred();
    harness.getDetail.mockReturnValueOnce(stale.promise);
    emit();
    await vi.advanceTimersByTimeAsync(3000);
    harness.revision++;
    const current = deferred();
    harness.getDetail.mockReturnValueOnce(current.promise);
    expect(render()).toBeNull();
    stale.resolve(synced);
    await settle();
    expect(render()).toBeNull();
    const unavailable = { ...pending, syncState: OwnershipSyncState.WaitingService, accountPartition: 'account-b' };
    current.resolve(unavailable);
    await settle();
    expect(render()).toEqual(unavailable);
  });

  test('clears detail when the authoritative detail lookup rejects access', async () => {
    render();
    await settle();
    harness.getDetail.mockRejectedValueOnce(new Error('NOT_AVAILABLE'));
    emit();
    await vi.advanceTimersByTimeAsync(3000);
    expect(render()).toBeNull();
  });
});
