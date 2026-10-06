import {
  PublishingIdentityType,
} from '@shared/publishing/constants';
import { describe, expect, test } from 'vitest';

import { shouldShowPublishingTrialNotice } from './publishingTrialNoticePolicy';

describe('publishingTrialNoticePolicy', () => {
  test('shows the notice for an eligible free user creating a new resource', () => {
    expect(shouldShowPublishingTrialNotice({
      allowed: true,
      identityType: PublishingIdentityType.Free,
      hasExistingResource: false,
    })).toBe(true);
  });

  test('does not show the notice while managing an existing resource', () => {
    expect(shouldShowPublishingTrialNotice({
      allowed: true,
      identityType: PublishingIdentityType.Free,
      hasExistingResource: true,
    })).toBe(false);
  });

  test('does not replace the quota limit or paid-user paths', () => {
    expect(shouldShowPublishingTrialNotice({
      allowed: false,
      identityType: PublishingIdentityType.Free,
      hasExistingResource: false,
    })).toBe(false);
    expect(shouldShowPublishingTrialNotice({
      allowed: true,
      identityType: PublishingIdentityType.Subscription,
      hasExistingResource: false,
    })).toBe(false);
  });
});
