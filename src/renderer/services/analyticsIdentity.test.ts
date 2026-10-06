import { AuthSubscriptionStatus } from '@shared/auth/constants';
import { EnterpriseAccountMode } from '@shared/enterpriseAccount/constants';
import { PublishingIdentityType } from '@shared/publishing/constants';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  isLoggedIn: false,
  user: null as { yid: string; accountMode?: string } | null,
  quota: null as { subscriptionStatus?: string; accountMode?: string } | null,
}));

vi.mock('../store', () => ({
  store: {
    getState: () => ({ auth: authState }),
  },
}));

import { getAnalyticsIdentitySnapshot } from './analyticsIdentity';

beforeEach(() => {
  authState.isLoggedIn = false;
  authState.user = null;
  authState.quota = null;
});

describe('analytics identity', () => {
  test('uses a real yid only for an authenticated user', () => {
    authState.isLoggedIn = true;
    authState.user = { yid: ' real-yid ' };
    authState.quota = { subscriptionStatus: AuthSubscriptionStatus.Active };

    expect(getAnalyticsIdentitySnapshot()).toEqual({
      userId: 'real-yid',
      isLoggedIn: true,
      identityType: PublishingIdentityType.Subscription,
      isSubscriber: true,
      subscriptionStatus: AuthSubscriptionStatus.Active,
    });
  });

  test('does not leak a stale user id after logout', () => {
    authState.user = { yid: 'stale-yid' };
    authState.quota = { subscriptionStatus: AuthSubscriptionStatus.Active };

    expect(getAnalyticsIdentitySnapshot()).toEqual({
      userId: '',
      isLoggedIn: false,
      identityType: PublishingIdentityType.Free,
      isSubscriber: false,
    });
  });

  test('reports enterprise identity separately from subscription', () => {
    authState.isLoggedIn = true;
    authState.user = { yid: 'enterprise-yid', accountMode: EnterpriseAccountMode.Enterprise };
    authState.quota = { subscriptionStatus: AuthSubscriptionStatus.Enterprise };

    expect(getAnalyticsIdentitySnapshot()).toMatchObject({
      userId: 'enterprise-yid',
      isLoggedIn: true,
      identityType: PublishingIdentityType.Enterprise,
      isSubscriber: false,
    });
  });
});
