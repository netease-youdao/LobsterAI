import { describe, expect, test } from 'vitest';

import { AuthSubscriptionStatus } from '../../../shared/auth/constants';
import { shouldShowFreePublishingDeleteQuotaNotice } from './publishingDeleteNoticePolicy';

describe('publishing delete notice policy', () => {
  test.each<[string | null | undefined, boolean]>([
    [AuthSubscriptionStatus.Free, true],
    [AuthSubscriptionStatus.Active, false],
    [AuthSubscriptionStatus.Enterprise, false],
    [undefined, false],
    [null, false],
    ['unexpected', false],
  ])('maps subscription status %s to free quota notice visibility %s', (
    subscriptionStatus,
    expected,
  ) => {
    expect(shouldShowFreePublishingDeleteQuotaNotice(subscriptionStatus)).toBe(expected);
  });
});
