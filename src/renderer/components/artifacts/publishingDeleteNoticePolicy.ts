import { AuthSubscriptionStatus } from '../../../shared/auth/constants';

export const shouldShowFreePublishingDeleteQuotaNotice = (
  subscriptionStatus: string | null | undefined,
): boolean => subscriptionStatus === AuthSubscriptionStatus.Free;
