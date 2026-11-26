import { describe, expect, test } from 'vitest';

import {
  APPLE_SUBSCRIPTION_MANAGEMENT_URL,
  getAppleSubscriptionManagementUrl,
  hasAppleSubscription,
  SubscriptionProvider,
} from './subscription';

describe('Apple subscription management compatibility', () => {
  test('preserves old-server behavior and recognizes Apple and mixed sources', () => {
    expect(hasAppleSubscription()).toBe(false);
    expect(hasAppleSubscription({})).toBe(false);
    expect(hasAppleSubscription({ subscriptionProvider: SubscriptionProvider.Legacy })).toBe(false);
    expect(hasAppleSubscription({ subscriptionProvider: SubscriptionProvider.Apple })).toBe(true);
    expect(hasAppleSubscription({ subscriptionProvider: SubscriptionProvider.Mixed })).toBe(true);
    expect(hasAppleSubscription({ hasAppleSubscription: true })).toBe(true);
    expect(hasAppleSubscription({ hasAppleSubscription: false, subscriptionProvider: SubscriptionProvider.Apple })).toBe(false);
  });

  test('never forwards an arbitrary external navigation URL', () => {
    for (const url of [null, 'javascript:alert(1)', 'https://apps.apple.com.attacker.invalid/account/subscriptions']) {
      expect(getAppleSubscriptionManagementUrl({ appleSubscriptionManagementUrl: url }))
        .toBe(APPLE_SUBSCRIPTION_MANAGEMENT_URL);
    }
    expect(getAppleSubscriptionManagementUrl({ appleSubscriptionManagementUrl: APPLE_SUBSCRIPTION_MANAGEMENT_URL }))
      .toBe(APPLE_SUBSCRIPTION_MANAGEMENT_URL);
  });
});
