import {
  PublishingIdentityType,
  type PublishingIdentityType as PublishingIdentityTypeValue,
} from '@shared/publishing/constants';

interface PublishingTrialNoticeEligibility {
  allowed: boolean;
  identityType: PublishingIdentityTypeValue;
  hasExistingResource: boolean;
}

export const shouldShowPublishingTrialNotice = ({
  allowed,
  identityType,
  hasExistingResource,
}: PublishingTrialNoticeEligibility): boolean => (
  allowed &&
  !hasExistingResource &&
  identityType === PublishingIdentityType.Free
);
