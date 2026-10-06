import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./config', () => ({
  configService: {
    getConfig: vi.fn(() => ({ usageAnalyticsEnabled: true })),
  },
}));

vi.mock('./logReporter', async () => {
  const actual = await vi.importActual<typeof import('./logReporter')>('./logReporter');
  return { ...actual, reportYdAnalyzer: vi.fn() };
});

import { EnterpriseAccountMode } from '@shared/enterpriseAccount/constants';
import { PublishingIdentityType } from '@shared/publishing/constants';

import { defaultConfig } from '../config';
import { configService } from './config';
import { LogReporterAction, reportYdAnalyzer } from './logReporter';
import {
  clearPendingPublishingConversionAttribution,
  PublishingSubscriptionObservationConfidence,
  rememberPublishingConversionAttribution,
  reportPendingPublishingSubscriptionObserved,
} from './publishingConversionAttribution';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const attribution = {
  ownerAccountKey: 'personal:user-1',
  attemptId: 'attempt-1',
  operationId: 'operation-1',
  feature: 'share',
  resourceKind: 'file',
  operationType: 'create',
  source: 'library_list',
  entryPoint: 'library_menu',
  surface: 'my_files',
  pageViewId: 'page-view-1',
  hasExistingResource: false,
  dialogType: 'trial_notice',
  exposureId: 'exposure-1',
  identityType: PublishingIdentityType.Free,
  countMode: 'total',
  quotaUsed: 2,
  quotaLimit: 10,
  canReleaseByClosing: false,
  trialAccessTtlSeconds: 7_200,
  ctaId: 'secondary',
  target: 'learn_benefits',
  dialogVisibleMs: 1_500,
};

const activePersonalSnapshot = {
  ownerAccountKey: 'personal:user-1',
  accountMode: EnterpriseAccountMode.Personal,
  subscriptionStatus: 'active',
};

const recoveryAttribution = {
  ...attribution,
  resourceKey: 'local-share:share-1',
  interactionType: 'recovery_cta',
  operationType: 'subscription_recovery',
  entryPoint: 'subscription_recovery_cta',
  recoverySurface: 'library_cloud_list',
  hasExistingResource: true,
  subscriptionRecoveryMode: 'automatic',
  ctaId: 'primary',
  target: 'pricing',
  exposureToClickMs: 750,
};

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.mocked(reportYdAnalyzer).mockReset();
  vi.mocked(configService.getConfig).mockReturnValue({
    ...defaultConfig,
    usageAnalyticsEnabled: true,
  });
  clearPendingPublishingConversionAttribution();
});

afterEach(() => {
  clearPendingPublishingConversionAttribution();
  vi.unstubAllGlobals();
});

describe('publishing conversion attribution', () => {
  test('reports a paid subscription observed within the last-touch window once', async () => {
    vi.mocked(reportYdAnalyzer).mockResolvedValue(true);
    rememberPublishingConversionAttribution(attribution, 1_000);

    await expect(reportPendingPublishingSubscriptionObserved(activePersonalSnapshot, 4_000))
      .resolves.toBe(true);

    expect(reportYdAnalyzer).toHaveBeenCalledOnce();
    expect(vi.mocked(reportYdAnalyzer).mock.calls[0][0]).toMatchObject({
      action: LogReporterAction.PublishingSubscriptionObserved,
      actionType: 'subscription_observed',
      attemptId: 'attempt-1',
      operationId: 'operation-1',
      exposureId: 'exposure-1',
      feature: 'share',
      source: 'library_list',
      entryPoint: 'library_menu',
      surface: 'my_files',
      pageViewId: 'page-view-1',
      target: 'learn_benefits',
      attributionAgeSeconds: 3,
      subscriptionStatus: 'active',
      confidence: PublishingSubscriptionObservationConfidence.KnownFree,
    });

    await expect(reportPendingPublishingSubscriptionObserved(activePersonalSnapshot, 5_000))
      .resolves.toBe(false);
    expect(reportYdAnalyzer).toHaveBeenCalledOnce();
  });

  test('does not report an expired attribution', async () => {
    vi.mocked(reportYdAnalyzer).mockResolvedValue(true);
    rememberPublishingConversionAttribution(attribution, 1_000);

    const eightDaysLater = 1_000 + 8 * 24 * 60 * 60 * 1_000;
    await expect(reportPendingPublishingSubscriptionObserved(
      activePersonalSnapshot,
      eightDaysLater,
    ))
      .resolves.toBe(false);

    expect(reportYdAnalyzer).not.toHaveBeenCalled();
  });

  test('retains attribution when delivery fails so a later quota refresh can retry', async () => {
    vi.mocked(reportYdAnalyzer)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    rememberPublishingConversionAttribution(attribution, 1_000);

    await expect(reportPendingPublishingSubscriptionObserved(activePersonalSnapshot, 2_000))
      .resolves.toBe(false);
    await expect(reportPendingPublishingSubscriptionObserved(activePersonalSnapshot, 3_000))
      .resolves.toBe(true);

    expect(reportYdAnalyzer).toHaveBeenCalledTimes(2);
  });

  test('clears pending attribution instead of reporting after analytics is disabled', async () => {
    rememberPublishingConversionAttribution(attribution, 1_000);
    vi.mocked(configService.getConfig).mockReturnValue({
      ...defaultConfig,
      usageAnalyticsEnabled: false,
    });

    await expect(reportPendingPublishingSubscriptionObserved(activePersonalSnapshot, 2_000))
      .resolves.toBe(false);

    expect(reportYdAnalyzer).not.toHaveBeenCalled();
    expect(globalThis.localStorage.length).toBe(0);
  });

  test('reports recovery conversion only for the same personal owner becoming active', async () => {
    vi.mocked(reportYdAnalyzer).mockResolvedValue(true);
    rememberPublishingConversionAttribution(recoveryAttribution, 1_000);

    await expect(reportPendingPublishingSubscriptionObserved({
      ...activePersonalSnapshot,
      accountMode: EnterpriseAccountMode.Enterprise,
      subscriptionStatus: 'enterprise',
    }, 2_000)).resolves.toBe(false);
    expect(reportYdAnalyzer).not.toHaveBeenCalled();

    await expect(reportPendingPublishingSubscriptionObserved(activePersonalSnapshot, 3_000))
      .resolves.toBe(true);

    const payload = vi.mocked(reportYdAnalyzer).mock.calls[0][0];
    expect(payload).toMatchObject({
      action: LogReporterAction.PublishingSubscriptionObserved,
      interactionType: 'recovery_cta',
      operationType: 'subscription_recovery',
      recoverySurface: 'library_cloud_list',
      subscriptionRecoveryMode: 'automatic',
      exposureToClickMs: 750,
      subscriptionStatus: 'active',
      confidence: PublishingSubscriptionObservationConfidence.KnownFree,
    });
    expect(payload).not.toHaveProperty('ownerAccountKey');
    expect(payload).not.toHaveProperty('resourceKey');
    expect(payload).not.toHaveProperty('clickedAt');
    expect(payload).not.toHaveProperty('expiresAt');
    expect(vi.mocked(reportYdAnalyzer).mock.calls[0][1]).toEqual({
      touchpointIdentityType: PublishingIdentityType.Free,
    });
  });

  test('preserves enterprise observations for legacy non-recovery publishing CTAs', async () => {
    vi.mocked(reportYdAnalyzer).mockResolvedValue(true);
    rememberPublishingConversionAttribution({
      ...attribution,
      ownerAccountKey: 'enterprise:user-1:42',
      identityType: PublishingIdentityType.Enterprise,
    }, 1_000);

    await expect(reportPendingPublishingSubscriptionObserved({
      ownerAccountKey: 'enterprise:user-1:42',
      accountMode: EnterpriseAccountMode.Enterprise,
      subscriptionStatus: 'enterprise',
    }, 2_000)).resolves.toBe(true);

    expect(vi.mocked(reportYdAnalyzer).mock.calls[0][0]).toEqual(expect.objectContaining({
      action: LogReporterAction.PublishingSubscriptionObserved,
      operationType: 'create',
      subscriptionStatus: 'enterprise',
    }));
  });

  test('clears last-touch without reporting when the authoritative owner changes', async () => {
    vi.mocked(reportYdAnalyzer).mockResolvedValue(true);
    rememberPublishingConversionAttribution(recoveryAttribution, 1_000);

    await expect(reportPendingPublishingSubscriptionObserved({
      ...activePersonalSnapshot,
      ownerAccountKey: 'personal:user-2',
    }, 2_000)).resolves.toBe(false);
    await expect(reportPendingPublishingSubscriptionObserved(activePersonalSnapshot, 3_000))
      .resolves.toBe(false);

    expect(reportYdAnalyzer).not.toHaveBeenCalled();
    expect(globalThis.localStorage.length).toBe(0);
  });

  test('drops ownerless legacy attribution records', async () => {
    globalThis.localStorage.setItem(
      'lobsterai_publishing_conversion_attribution_v2',
      JSON.stringify({
        ...attribution,
        ownerAccountKey: undefined,
        attributionVersion: 2,
        clickedAt: 1_000,
        expiresAt: 10_000,
      }),
    );

    await expect(reportPendingPublishingSubscriptionObserved(activePersonalSnapshot, 2_000))
      .resolves.toBe(false);

    expect(reportYdAnalyzer).not.toHaveBeenCalled();
    expect(globalThis.localStorage.length).toBe(0);
  });
});
