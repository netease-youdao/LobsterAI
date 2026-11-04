import { ActivityServerErrorCode } from '@shared/activity/constants';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createDailyCheckInSnapshotStore,
  DAILY_CHECK_IN_SNAPSHOT_FRESH_MS,
  type DailyCheckInLoadResult,
  DailyCheckInLoadResultStatus,
  type DailyCheckInSnapshot,
  waitForDailyCheckInRefresh,
} from './dailyCheckInSnapshotStore';

const ACCOUNT_A = 'account-a:1';
const ACCOUNT_B = 'account-b:2';

const makeSnapshot = (label: string): DailyCheckInSnapshot => ({
  descriptor: { activityCode: label },
  context: { activityCode: label },
}) as unknown as DailyCheckInSnapshot;

const ready = (snapshot: DailyCheckInSnapshot): DailyCheckInLoadResult => ({
  status: DailyCheckInLoadResultStatus.Ready,
  snapshot,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('createDailyCheckInSnapshotStore', () => {
  test('keeps the loaded snapshot for its own account scope only', async () => {
    const snapshot = makeSnapshot('first');
    const store = createDailyCheckInSnapshotStore({
      load: async () => ready(snapshot),
    });

    expect(store.get(ACCOUNT_A)).toBeNull();
    await store.refresh(ACCOUNT_A);

    expect(store.get(ACCOUNT_A)).toBe(snapshot);
    expect(store.get(ACCOUNT_B)).toBeNull();
  });

  test('shares one request between concurrent refreshes of the same scope', async () => {
    const request = deferred<DailyCheckInLoadResult>();
    const load = vi.fn(() => request.promise);
    const store = createDailyCheckInSnapshotStore({ load });

    const first = store.refresh(ACCOUNT_A);
    const second = store.refresh(ACCOUNT_A);
    request.resolve(ready(makeSnapshot('shared')));

    expect(first).toBe(second);
    await first;
    expect(load).toHaveBeenCalledTimes(1);

    await store.refresh(ACCOUNT_A);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('reports freshness until the window passes', async () => {
    let now = 1_000;
    const store = createDailyCheckInSnapshotStore({
      load: async () => ready(makeSnapshot('fresh')),
      now: () => now,
    });

    expect(store.isFresh(ACCOUNT_A)).toBe(false);
    await store.refresh(ACCOUNT_A);
    expect(store.isFresh(ACCOUNT_A)).toBe(true);
    expect(store.isFresh(ACCOUNT_B)).toBe(false);

    now += DAILY_CHECK_IN_SNAPSHOT_FRESH_MS;
    expect(store.isFresh(ACCOUNT_A)).toBe(false);
    expect(store.get(ACCOUNT_A)).not.toBeNull();
  });

  test('keeps the last snapshot through a transient failure', async () => {
    const snapshot = makeSnapshot('kept');
    const load = vi.fn<() => Promise<DailyCheckInLoadResult>>()
      .mockResolvedValueOnce(ready(snapshot))
      .mockResolvedValueOnce({ status: DailyCheckInLoadResultStatus.Failed, code: 500 });
    const store = createDailyCheckInSnapshotStore({ load });

    await store.refresh(ACCOUNT_A);
    const result = await store.refresh(ACCOUNT_A);

    expect(result.status).toBe(DailyCheckInLoadResultStatus.Failed);
    expect(store.get(ACCOUNT_A)).toBe(snapshot);
    expect(store.isFresh(ACCOUNT_A)).toBe(true);
  });

  test.each([
    { status: DailyCheckInLoadResultStatus.Unavailable },
    { status: DailyCheckInLoadResultStatus.Failed, code: ActivityServerErrorCode.NotActive },
    { status: DailyCheckInLoadResultStatus.Failed, code: ActivityServerErrorCode.NotFound },
  ] satisfies DailyCheckInLoadResult[])('drops the snapshot when the activity is gone: %o', async (goneResult) => {
    const load = vi.fn<() => Promise<DailyCheckInLoadResult>>()
      .mockResolvedValueOnce(ready(makeSnapshot('gone')))
      .mockResolvedValueOnce(goneResult);
    const store = createDailyCheckInSnapshotStore({ load });

    await store.refresh(ACCOUNT_A);
    await store.refresh(ACCOUNT_A);

    expect(store.get(ACCOUNT_A)).toBeNull();
  });

  test('does not let a refresh started before a claim overwrite the claimed state', async () => {
    const staleRequest = deferred<DailyCheckInLoadResult>();
    const load = vi.fn<() => Promise<DailyCheckInLoadResult>>()
      .mockReturnValueOnce(staleRequest.promise)
      .mockResolvedValueOnce(ready(makeSnapshot('after-claim')));
    const store = createDailyCheckInSnapshotStore({ load });
    const claimed = makeSnapshot('claimed');

    const pending = store.refresh(ACCOUNT_A);
    store.replace(ACCOUNT_A, claimed);
    staleRequest.resolve(ready(makeSnapshot('before-claim')));
    await pending;

    expect(store.get(ACCOUNT_A)).toBe(claimed);

    // Refreshing after the claim must start a new request, not reuse the old one.
    await store.refresh(ACCOUNT_A);
    expect(load).toHaveBeenCalledTimes(2);
    expect(store.get(ACCOUNT_A)?.descriptor.activityCode).toBe('after-claim');
  });

  test('passes a load error to the caller and allows the next refresh to retry', async () => {
    const snapshot = makeSnapshot('before-error');
    const load = vi.fn<() => Promise<DailyCheckInLoadResult>>()
      .mockResolvedValueOnce(ready(snapshot))
      .mockRejectedValueOnce(new Error('ipc unavailable'))
      .mockResolvedValueOnce(ready(makeSnapshot('retried')));
    const store = createDailyCheckInSnapshotStore({ load });

    await store.refresh(ACCOUNT_A);
    await expect(store.refresh(ACCOUNT_A)).rejects.toThrow('ipc unavailable');
    expect(store.get(ACCOUNT_A)).toBe(snapshot);

    await store.refresh(ACCOUNT_A);
    expect(load).toHaveBeenCalledTimes(3);
  });
});

describe('waitForDailyCheckInRefresh', () => {
  test('resolves with the request value when it settles in time', async () => {
    vi.useFakeTimers();
    const request = deferred<string>();
    const waiting = waitForDailyCheckInRefresh(request.promise, 250);

    request.resolve('done');

    await expect(waiting).resolves.toBe('done');
  });

  test('resolves with null once the wait runs out', async () => {
    vi.useFakeTimers();
    const request = deferred<string>();
    const waiting = waitForDailyCheckInRefresh(request.promise, 250);

    await vi.advanceTimersByTimeAsync(250);

    await expect(waiting).resolves.toBeNull();
    request.resolve('late');
  });
});
