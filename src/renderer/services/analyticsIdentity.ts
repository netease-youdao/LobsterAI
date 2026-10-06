import { AuthSubscriptionStatus } from '@shared/auth/constants';
import { EnterpriseAccountMode } from '@shared/enterpriseAccount/constants';
import {
  PublishingIdentityType,
  type PublishingIdentityType as PublishingIdentityTypeValue,
} from '@shared/publishing/constants';

import { store } from '../store';

export interface AnalyticsIdentitySnapshot {
  userId: string;
  isLoggedIn: boolean;
  identityType: PublishingIdentityTypeValue;
  isSubscriber: boolean;
  subscriptionStatus?: string;
}

export const getAnalyticsIdentitySnapshot = (): AnalyticsIdentitySnapshot => {
  const auth = store.getState().auth;
  const storedUserId = auth.user?.yid?.trim() ?? '';
  const userId = auth.isLoggedIn && storedUserId ? storedUserId : '';
  const isLoggedIn = userId.length > 0;
  const subscriptionStatus = auth.quota?.subscriptionStatus;
  const accountMode = auth.quota?.accountMode ?? auth.user?.accountMode;
  const isEnterprise = isLoggedIn && (
    accountMode === EnterpriseAccountMode.Enterprise
    || subscriptionStatus === AuthSubscriptionStatus.Enterprise
  );
  const isSubscriber = isLoggedIn
    && subscriptionStatus === AuthSubscriptionStatus.Active;

  return {
    userId,
    isLoggedIn,
    identityType: isEnterprise
      ? PublishingIdentityType.Enterprise
      : isSubscriber
        ? PublishingIdentityType.Subscription
        : PublishingIdentityType.Free,
    isSubscriber,
    ...(isLoggedIn && subscriptionStatus ? { subscriptionStatus } : {}),
  };
};
