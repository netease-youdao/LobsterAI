import {
  ActivityServerErrorCode,
  type DailyCheckInContextResponse,
  type DailyCheckInDescriptor,
} from '@shared/activity/constants';

export const DailyCheckInLoadResultStatus = {
  Ready: 'ready',
  Unavailable: 'unavailable',
  Failed: 'failed',
} as const;

export interface DailyCheckInSnapshot {
  descriptor: DailyCheckInDescriptor;
  context: DailyCheckInContextResponse;
}

export type DailyCheckInLoadResult =
  | {
      status: typeof DailyCheckInLoadResultStatus.Ready;
      snapshot: DailyCheckInSnapshot;
    }
  | {
      status: typeof DailyCheckInLoadResultStatus.Unavailable;
    }
  | {
      status: typeof DailyCheckInLoadResultStatus.Failed;
      code?: number;
    };

/** A refresh newer than this is reused instead of asking the server again. */
export const DAILY_CHECK_IN_SNAPSHOT_FRESH_MS = 15 * 1000;

export interface DailyCheckInSnapshotStore {
  /** The last known snapshot for this account scope, fresh or not. */
  get: (accountScope: string) => DailyCheckInSnapshot | null;
  /** Whether this account scope was refreshed (or replaced) recently. */
  isFresh: (accountScope: string) => boolean;
  /** Loads the snapshot, sharing a request already running for the scope. */
  refresh: (accountScope: string) => Promise<DailyCheckInLoadResult>;
  /** Stores a state the client knows is newer, such as a claim response. */
  replace: (accountScope: string, snapshot: DailyCheckInSnapshot | null) => void;
}

export interface DailyCheckInSnapshotStoreOptions {
  load: () => Promise<DailyCheckInLoadResult>;
  now?: () => number;
  freshMs?: number;
}

interface StoredDailyCheckInState {
  accountScope: string;
  snapshot: DailyCheckInSnapshot | null;
  updatedAt: number;
}

interface PendingDailyCheckInRefresh {
  accountScope: string;
  promise: Promise<DailyCheckInLoadResult>;
}

/**
 * Whether a load result means the activity is gone, as opposed to a transient
 * failure that should keep showing the last known snapshot.
 */
export const isDailyCheckInGone = (result: DailyCheckInLoadResult): boolean => (
  result.status === DailyCheckInLoadResultStatus.Unavailable
  || (result.status === DailyCheckInLoadResultStatus.Failed
    && (result.code === ActivityServerErrorCode.NotActive
      || result.code === ActivityServerErrorCode.NotFound))
);

export function createDailyCheckInSnapshotStore({
  load,
  now = Date.now,
  freshMs = DAILY_CHECK_IN_SNAPSHOT_FRESH_MS,
}: DailyCheckInSnapshotStoreOptions): DailyCheckInSnapshotStore {
  let stored: StoredDailyCheckInState | null = null;
  let pending: PendingDailyCheckInRefresh | null = null;
  // Bumped by replace() so a refresh that started before a claim response
  // cannot overwrite the claimed state with the older server answer.
  let replaceRevision = 0;

  const get = (accountScope: string): DailyCheckInSnapshot | null => (
    stored?.accountScope === accountScope ? stored.snapshot : null
  );

  const isFresh = (accountScope: string): boolean => (
    stored?.accountScope === accountScope
    && now() - stored.updatedAt < freshMs
  );

  const settle = (
    accountScope: string,
    result: DailyCheckInLoadResult | null,
  ): void => {
    let snapshot = get(accountScope);
    if (result?.status === DailyCheckInLoadResultStatus.Ready) {
      snapshot = result.snapshot;
    } else if (result && isDailyCheckInGone(result)) {
      snapshot = null;
    }
    stored = { accountScope, snapshot, updatedAt: now() };
  };

  const refresh = (accountScope: string): Promise<DailyCheckInLoadResult> => {
    if (pending?.accountScope === accountScope) return pending.promise;

    const startRevision = replaceRevision;
    const promise = (async (): Promise<DailyCheckInLoadResult> => {
      let result: DailyCheckInLoadResult | null = null;
      try {
        result = await load();
        return result;
      } finally {
        if (replaceRevision === startRevision) settle(accountScope, result);
      }
    })();
    const request: PendingDailyCheckInRefresh = { accountScope, promise };
    pending = request;
    const clearPending = (): void => {
      if (pending === request) pending = null;
    };
    // Also marks a rejection as handled for callers that only prefetch.
    promise.then(clearPending, clearPending);
    return promise;
  };

  const replace = (
    accountScope: string,
    snapshot: DailyCheckInSnapshot | null,
  ): void => {
    replaceRevision += 1;
    pending = null;
    stored = { accountScope, snapshot, updatedAt: now() };
  };

  return {
    get,
    isFresh,
    refresh,
    replace,
  };
}

/** Resolves with the request's value, or null once the wait runs out. */
export function waitForDailyCheckInRefresh<T>(
  request: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
