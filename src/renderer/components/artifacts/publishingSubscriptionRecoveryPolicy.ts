import { AccountOwnerKeyPrefix } from '@shared/auth/accountOwner';
import { AuthSubscriptionStatus } from '@shared/auth/constants';
import {
  PublishingSubscriptionRecoveryMode,
  type PublishingSubscriptionRecoveryMode as PublishingSubscriptionRecoveryModeValue,
} from '@shared/publishing/constants';

export interface PublishingSubscriptionRecoveryEligibility {
  ownerAccountKey?: string | null;
  subscriptionStatus?: string | null;
  recoveryMode?: PublishingSubscriptionRecoveryModeValue;
  isExpired: boolean;
  isAvailable: boolean;
}

export const shouldShowPublishingSubscriptionRecovery = (
  input: PublishingSubscriptionRecoveryEligibility,
): boolean => (
  input.ownerAccountKey?.startsWith(AccountOwnerKeyPrefix.Personal) === true
  && input.subscriptionStatus === AuthSubscriptionStatus.Free
  && input.isExpired
  && !input.isAvailable
  && (
    input.recoveryMode === PublishingSubscriptionRecoveryMode.Automatic
    || input.recoveryMode === PublishingSubscriptionRecoveryMode.RedeployRequired
  )
);

export const getPublishingSubscriptionRecoveryLabelKey = (
  recoveryMode?: PublishingSubscriptionRecoveryModeValue,
): 'publishingSubscriptionRecoveryAction' | 'publishingSubscriptionRedeployAction' => (
  recoveryMode === PublishingSubscriptionRecoveryMode.RedeployRequired
    ? 'publishingSubscriptionRedeployAction'
    : 'publishingSubscriptionRecoveryAction'
);
