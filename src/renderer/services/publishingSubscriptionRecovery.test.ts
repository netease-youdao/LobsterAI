import { PublishingRecoveryAnalyticsOutcome } from '@shared/analytics/constants';
import { AuthSubscriptionStatus } from '@shared/auth/constants';
import { HtmlShareAccessMode, HtmlShareSourceType, HtmlShareStatus } from '@shared/htmlShare/constants';
import { LibraryCategory, LibraryItemKind } from '@shared/library/constants';
import type { LibraryCloudListData } from '@shared/library/types';
import {
  PublishingResourceKind,
  PublishingSubscriptionRecoveryMode,
} from '@shared/publishing/constants';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  type PublishingSubscriptionRecoveryAuthSnapshot,
  PublishingSubscriptionRecoveryCoordinator,
  type PublishingSubscriptionRecoveryDependencies,
  PublishingSubscriptionRecoveryRefreshOutcome,
  resolvePublishingSubscriptionRecoveryRefreshOutcome,
} from './publishingSubscriptionRecovery';

const OWNER = 'personal:42';
const OTHER_OWNER = 'personal:84';

const createCloudData = (
  recoveryPending = false,
  includeResource = true,
): LibraryCloudListData => ({
  list: includeResource ? [{
    itemKind: LibraryItemKind.SharedFile,
    itemId: 'share-1',
    shareId: 'share-1',
    title: 'index.html',
    url: 'https://example.test/share-1',
    category: LibraryCategory.Web,
    sortTime: 1,
    createdAt: 1,
    isFavorite: false,
    sourceType: HtmlShareSourceType.HtmlFile,
    accessMode: HtmlShareAccessMode.Public,
    status: HtmlShareStatus.Disabled,
    accessExpiresAt: 1,
    effectiveAvailable: false,
    subscriptionRecoveryMode: PublishingSubscriptionRecoveryMode.Automatic,
  }] : [],
  hasMore: false,
  counts: { sharedFile: includeResource ? 1 : 0, deployedSite: 0 },
  sharedStatusCounts: { all: includeResource ? 1 : 0, live: 0, disabled: includeResource ? 1 : 0 },
  recoveryPending,
});

const createHarness = (
  listCloud: PublishingSubscriptionRecoveryDependencies['listCloud'],
  reportImplementation: PublishingSubscriptionRecoveryDependencies['reportResult'] = async () => true,
) => {
  let snapshot: PublishingSubscriptionRecoveryAuthSnapshot = {
    ownerAccountKey: OWNER,
    subscriptionStatus: AuthSubscriptionStatus.Free,
  };
  const reportResult = vi.fn(reportImplementation);
  const clearAnalyticsState = vi.fn();
  const emitLibraryInvalidated = vi.fn();
  const coordinator = new PublishingSubscriptionRecoveryCoordinator({
    now: () => 10,
    listCloud,
    getAuthSnapshot: () => snapshot,
    emitLibraryInvalidated,
    reportResult,
    clearAnalyticsState,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: timer => clearTimeout(timer),
  });
  return {
    coordinator,
    emitLibraryInvalidated,
    reportResult,
    clearAnalyticsState,
    setSnapshot: (next: PublishingSubscriptionRecoveryAuthSnapshot) => {
      snapshot = next;
    },
  };
};

const arm = (coordinator: PublishingSubscriptionRecoveryCoordinator): void => {
  coordinator.arm({
    ownerAccountKey: OWNER,
    resourceKind: PublishingResourceKind.File,
    resourceKey: 'share-1',
    recoveryMode: PublishingSubscriptionRecoveryMode.Automatic,
    traceId: 'attempt-1',
  });
};

afterEach(() => {
  vi.useRealTimers();
});

describe('publishing subscription recovery coordinator', () => {
  test('consumes the armed focus refresh once and isolates it by owner', () => {
    const { coordinator } = createHarness(vi.fn(async () => ({
      success: true,
      data: createCloudData(),
    })));
    arm(coordinator);
    expect(coordinator.consumeFocusRefreshRequest(OTHER_OWNER)).toBe(false);
    expect(coordinator.consumeFocusRefreshRequest(OWNER)).toBe(true);
    expect(coordinator.consumeFocusRefreshRequest(OWNER)).toBe(false);
  });

  test('does not fetch for an unrelated active snapshot, but a Library reconcile can start it', async () => {
    const listCloud = vi.fn(async () => ({ success: true, data: createCloudData(false, false) }));
    const { coordinator, setSnapshot } = createHarness(listCloud);
    setSnapshot({ ownerAccountKey: OWNER, subscriptionStatus: AuthSubscriptionStatus.Active });
    coordinator.observeAuthSnapshot({
      ownerAccountKey: OWNER,
      subscriptionStatus: AuthSubscriptionStatus.Active,
    });
    await Promise.resolve();
    expect(listCloud).not.toHaveBeenCalled();

    coordinator.reconcile(OWNER);
    await Promise.resolve();
    expect(listCloud).toHaveBeenCalledTimes(1);
    expect(listCloud).toHaveBeenCalledWith(OWNER);
  });

  test('uses 3/10/30 second bounded retries and reports exhaustion', async () => {
    vi.useFakeTimers();
    const listCloud = vi.fn(async () => ({ success: true, data: createCloudData(true) }));
    const { coordinator, reportResult, setSnapshot } = createHarness(listCloud);
    arm(coordinator);
    setSnapshot({ ownerAccountKey: OWNER, subscriptionStatus: AuthSubscriptionStatus.Active });
    coordinator.observeAuthSnapshot({
      ownerAccountKey: OWNER,
      subscriptionStatus: AuthSubscriptionStatus.Active,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(listCloud).toHaveBeenCalledTimes(4);
    expect(reportResult).toHaveBeenCalledWith({
      ownerAccountKey: OWNER,
      resourceKey: 'share-1',
      outcome: PublishingRecoveryAnalyticsOutcome.RetryExhausted,
    });
  });

  test('clears the waiting intent after bounded cloud request failures', async () => {
    vi.useFakeTimers();
    const listCloud = vi.fn(async () => ({ success: false }));
    const { coordinator, reportResult, setSnapshot } = createHarness(listCloud);
    arm(coordinator);
    setSnapshot({ ownerAccountKey: OWNER, subscriptionStatus: AuthSubscriptionStatus.Active });
    coordinator.observeAuthSnapshot({
      ownerAccountKey: OWNER,
      subscriptionStatus: AuthSubscriptionStatus.Active,
    });

    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(listCloud).toHaveBeenCalledTimes(4);
    expect(reportResult).toHaveBeenCalledWith({
      ownerAccountKey: OWNER,
      resourceKey: 'share-1',
      outcome: PublishingRecoveryAnalyticsOutcome.RetryExhausted,
    });
    expect(coordinator.consumeFocusRefreshRequest(OWNER)).toBe(false);
  });

  test('treats a rejected target refresh as pending for the bounded retry window', async () => {
    vi.useFakeTimers();
    const listCloud = vi.fn(async () => ({ success: true, data: createCloudData(false) }));
    const refresh = vi.fn(async () => {
      throw new Error('temporary detail failure');
    });
    const { coordinator, reportResult, setSnapshot } = createHarness(listCloud);
    coordinator.registerTarget({
      ownerAccountKey: OWNER,
      resourceKind: PublishingResourceKind.File,
      resourceKey: 'share-1',
      recoveryMode: PublishingSubscriptionRecoveryMode.Automatic,
      traceId: 'attempt-1',
      refresh,
    });
    arm(coordinator);
    setSnapshot({ ownerAccountKey: OWNER, subscriptionStatus: AuthSubscriptionStatus.Active });
    coordinator.observeAuthSnapshot({
      ownerAccountKey: OWNER,
      subscriptionStatus: AuthSubscriptionStatus.Active,
    });

    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(listCloud).toHaveBeenCalledTimes(4);
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(reportResult).toHaveBeenCalledWith({
      ownerAccountKey: OWNER,
      resourceKey: 'share-1',
      outcome: PublishingRecoveryAnalyticsOutcome.RetryExhausted,
    });
  });

  test('retries a failed terminal analytics result on the next active auth snapshot', async () => {
    const restoredData = createCloudData();
    const item = restoredData.list[0];
    if (item?.itemKind === LibraryItemKind.SharedFile) {
      item.status = HtmlShareStatus.Live;
      item.accessExpiresAt = null;
      item.effectiveAvailable = true;
      item.subscriptionRecoveryMode = PublishingSubscriptionRecoveryMode.None;
    }
    const reportImplementation = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { coordinator, reportResult, setSnapshot } = createHarness(
      vi.fn(async () => ({ success: true, data: restoredData })),
      reportImplementation,
    );
    arm(coordinator);
    setSnapshot({ ownerAccountKey: OWNER, subscriptionStatus: AuthSubscriptionStatus.Active });
    coordinator.observeAuthSnapshot({
      ownerAccountKey: OWNER,
      subscriptionStatus: AuthSubscriptionStatus.Active,
    });
    await vi.waitFor(() => expect(reportResult).toHaveBeenCalledTimes(1));

    coordinator.observeAuthSnapshot({
      ownerAccountKey: OWNER,
      subscriptionStatus: AuthSubscriptionStatus.Active,
    });
    await vi.waitFor(() => expect(reportResult).toHaveBeenCalledTimes(2));
    expect(reportResult).toHaveBeenLastCalledWith({
      ownerAccountKey: OWNER,
      resourceKey: 'share-1',
      outcome: PublishingRecoveryAnalyticsOutcome.Restored,
    });
  });

  test('drops pending analytics results without interrupting business recovery on opt-out', async () => {
    const restoredData = createCloudData();
    const item = restoredData.list[0];
    if (item?.itemKind === LibraryItemKind.SharedFile) {
      item.status = HtmlShareStatus.Live;
      item.accessExpiresAt = null;
      item.effectiveAvailable = true;
      item.subscriptionRecoveryMode = PublishingSubscriptionRecoveryMode.None;
    }
    const { coordinator, clearAnalyticsState, reportResult, setSnapshot } = createHarness(
      vi.fn(async () => ({ success: true, data: restoredData })),
      vi.fn(async () => false),
    );
    arm(coordinator);
    setSnapshot({ ownerAccountKey: OWNER, subscriptionStatus: AuthSubscriptionStatus.Active });
    coordinator.observeAuthSnapshot({
      ownerAccountKey: OWNER,
      subscriptionStatus: AuthSubscriptionStatus.Active,
    });
    await vi.waitFor(() => expect(reportResult).toHaveBeenCalledTimes(1));

    coordinator.clearAnalytics();
    coordinator.observeAuthSnapshot({
      ownerAccountKey: OWNER,
      subscriptionStatus: AuthSubscriptionStatus.Active,
    });
    await Promise.resolve();

    expect(clearAnalyticsState).toHaveBeenCalledWith();
    expect(reportResult).toHaveBeenCalledTimes(1);
  });

  test('keeps a missing first-page intent and clears exposure state on owner change', async () => {
    const listCloud = vi.fn(async () => ({ success: true, data: createCloudData(false, false) }));
    const { coordinator, clearAnalyticsState, setSnapshot } = createHarness(listCloud);
    arm(coordinator);
    setSnapshot({ ownerAccountKey: OWNER, subscriptionStatus: AuthSubscriptionStatus.Active });
    coordinator.observeAuthSnapshot({
      ownerAccountKey: OWNER,
      subscriptionStatus: AuthSubscriptionStatus.Active,
    });
    await Promise.resolve();
    expect(coordinator.consumeFocusRefreshRequest(OWNER)).toBe(true);

    setSnapshot({ ownerAccountKey: OTHER_OWNER, subscriptionStatus: AuthSubscriptionStatus.Free });
    coordinator.observeAuthSnapshot({
      ownerAccountKey: OTHER_OWNER,
      subscriptionStatus: AuthSubscriptionStatus.Free,
    });
    expect(clearAnalyticsState).toHaveBeenCalledWith(OWNER);
  });

  test('uses the refreshed authoritative mode instead of the captured mode', () => {
    expect(resolvePublishingSubscriptionRecoveryRefreshOutcome({
      expectedMode: PublishingSubscriptionRecoveryMode.RedeployRequired,
      currentMode: PublishingSubscriptionRecoveryMode.RedeployRequired,
      isRestored: false,
    })).toBe(PublishingSubscriptionRecoveryRefreshOutcome.RedeployReady);
    expect(resolvePublishingSubscriptionRecoveryRefreshOutcome({
      expectedMode: PublishingSubscriptionRecoveryMode.RedeployRequired,
      currentMode: PublishingSubscriptionRecoveryMode.None,
      isRestored: false,
    })).toBe(PublishingSubscriptionRecoveryRefreshOutcome.ResourceUnavailable);
    expect(resolvePublishingSubscriptionRecoveryRefreshOutcome({
      expectedMode: PublishingSubscriptionRecoveryMode.Automatic,
      currentMode: PublishingSubscriptionRecoveryMode.None,
      isRestored: true,
    })).toBe(PublishingSubscriptionRecoveryRefreshOutcome.Restored);
  });
});
