import { AuthSubscriptionStatus } from '@shared/auth/constants';
import { PublishingSubscriptionRecoveryMode } from '@shared/publishing/constants';
import { describe, expect, test } from 'vitest';

import {
  getPublishingSubscriptionRecoveryLabelKey,
  shouldShowPublishingSubscriptionRecovery,
} from './publishingSubscriptionRecoveryPolicy';

describe('publishing subscription recovery policy', () => {
  const eligible = {
    ownerAccountKey: 'personal:42',
    subscriptionStatus: AuthSubscriptionStatus.Free,
    recoveryMode: PublishingSubscriptionRecoveryMode.Automatic,
    isExpired: true,
    isAvailable: false,
  } as const;

  test('shows only for expired unavailable free personal resources with an explicit mode', () => {
    expect(shouldShowPublishingSubscriptionRecovery(eligible)).toBe(true);
    expect(shouldShowPublishingSubscriptionRecovery({
      ...eligible,
      ownerAccountKey: 'enterprise:42:7',
    })).toBe(false);
    expect(shouldShowPublishingSubscriptionRecovery({
      ...eligible,
      subscriptionStatus: AuthSubscriptionStatus.Active,
    })).toBe(false);
    expect(shouldShowPublishingSubscriptionRecovery({
      ...eligible,
      recoveryMode: PublishingSubscriptionRecoveryMode.None,
    })).toBe(false);
    expect(shouldShowPublishingSubscriptionRecovery({ ...eligible, isExpired: false })).toBe(false);
    expect(shouldShowPublishingSubscriptionRecovery({ ...eligible, isAvailable: true })).toBe(false);
  });

  test('uses a distinct label for resources that require redeployment', () => {
    expect(getPublishingSubscriptionRecoveryLabelKey(
      PublishingSubscriptionRecoveryMode.Automatic,
    )).toBe('publishingSubscriptionRecoveryAction');
    expect(getPublishingSubscriptionRecoveryLabelKey(
      PublishingSubscriptionRecoveryMode.RedeployRequired,
    )).toBe('publishingSubscriptionRedeployAction');
  });
});
