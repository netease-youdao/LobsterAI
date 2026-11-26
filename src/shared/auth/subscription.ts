export const SubscriptionProvider = {
  Legacy: 'legacy',
  Apple: 'apple',
  Mixed: 'mixed',
} as const;

export type SubscriptionProvider = typeof SubscriptionProvider[keyof typeof SubscriptionProvider];

/** Optional additions to legacy quota/profile responses; older servers omit them. */
export interface SubscriptionManagement {
  subscriptionProvider?: SubscriptionProvider | null;
  appleSubscriptionManagementUrl?: string | null;
  canCancelLegacySubscription?: boolean;
  hasAppleSubscription?: boolean;
  appleRenewalDate?: string | null;
}

export const APPLE_SUBSCRIPTION_MANAGEMENT_URL = 'https://apps.apple.com/account/subscriptions';

export function hasAppleSubscription(info?: SubscriptionManagement | null): boolean {
  if (typeof info?.hasAppleSubscription === 'boolean') return info.hasAppleSubscription;
  return info?.subscriptionProvider === SubscriptionProvider.Apple
    || info?.subscriptionProvider === SubscriptionProvider.Mixed;
}

export function getAppleSubscriptionManagementUrl(info?: SubscriptionManagement | null): string {
  // External navigation is restricted to the known Apple subscription page.
  return info?.appleSubscriptionManagementUrl === APPLE_SUBSCRIPTION_MANAGEMENT_URL
    ? info.appleSubscriptionManagementUrl
    : APPLE_SUBSCRIPTION_MANAGEMENT_URL;
}
