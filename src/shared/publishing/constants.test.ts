import { describe, expect, test } from 'vitest';

import {
  normalizePublishingSubscriptionRecoveryMode,
  PublishingSubscriptionRecoveryMode,
} from './constants';

describe('publishing subscription recovery mode', () => {
  test.each([
    PublishingSubscriptionRecoveryMode.None,
    PublishingSubscriptionRecoveryMode.Automatic,
    PublishingSubscriptionRecoveryMode.RedeployRequired,
  ])('accepts the supported %s mode', mode => {
    expect(normalizePublishingSubscriptionRecoveryMode(mode)).toBe(mode);
  });

  test.each([undefined, null, '', 'future_mode', 1, {}])(
    'fails closed for unsupported value %j',
    value => {
      expect(normalizePublishingSubscriptionRecoveryMode(value))
        .toBe(PublishingSubscriptionRecoveryMode.None);
    },
  );
});
