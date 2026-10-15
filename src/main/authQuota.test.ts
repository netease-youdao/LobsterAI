import { describe, expect, test } from 'vitest';

import {
  authQuotaGateStateFromQuota,
  AuthSubscriptionStatus,
  createDefaultAuthQuotaGateState,
  normalizeAuthQuota,
} from './authQuota';

const labels = {
  freePlanName: 'Free',
  standardPlanName: 'Standard',
};

describe('normalizeAuthQuota', () => {
  test('treats boost or invitation credits as media generation entitlement for free users', () => {
    const quota = normalizeAuthQuota({
      planName: 'Free',
      subscriptionStatus: AuthSubscriptionStatus.Free,
      freeCreditsTotal: 300,
      freeCreditsUsed: 300,
      hasPaidCredits: true,
    }, labels);

    expect(quota).toEqual(expect.objectContaining({
      subscriptionStatus: AuthSubscriptionStatus.Free,
      creditsRemaining: 0,
      hasPaidCredits: true,
      mediaGenerationEntitled: true,
    }));
    expect(authQuotaGateStateFromQuota(quota)).toEqual({
      subscriptionStatus: AuthSubscriptionStatus.Free,
      mediaGenerationEntitled: true,
    });
  });

  test('treats an active subscription as paid entitlement even without hasPaidCredits in the raw response', () => {
    const quota = normalizeAuthQuota({
      planName: 'Standard',
      subscriptionStatus: AuthSubscriptionStatus.Active,
      monthlyCreditsLimit: 5000,
      monthlyCreditsUsed: 100,
    }, labels);

    expect(quota).toEqual(expect.objectContaining({
      subscriptionStatus: AuthSubscriptionStatus.Active,
      creditsRemaining: 4900,
      hasPaidCredits: true,
      mediaGenerationEntitled: true,
    }));
    expect(authQuotaGateStateFromQuota(quota).mediaGenerationEntitled).toBe(true);
  });

  test('fills hasPaidCredits for already-normalized quota responses', () => {
    const quota = normalizeAuthQuota({
      planName: 'Free',
      subscriptionStatus: AuthSubscriptionStatus.Free,
      creditsLimit: 300,
      creditsUsed: 300,
      hasPaidCredits: true,
    }, labels);

    expect(quota).toEqual(expect.objectContaining({
      creditsRemaining: 0,
      hasPaidCredits: true,
      mediaGenerationEntitled: true,
    }));
    expect(authQuotaGateStateFromQuota(quota).mediaGenerationEntitled).toBe(true);
  });

  test('normalizes enterprise member quota without enabling out-of-scope media models', () => {
    const quota = normalizeAuthQuota({
      planName: '团队版',
      subscriptionStatus: 'enterprise',
      creditsLimit: 8000,
      creditsUsed: 4480,
      creditsRemaining: 3520,
      hasPaidCredits: false,
      mediaGenerationEntitled: false,
    }, labels);

    expect(quota).toEqual(expect.objectContaining({
      planName: '团队版',
      subscriptionStatus: 'enterprise',
      creditsLimit: 8000,
      creditsUsed: 4480,
      creditsRemaining: 3520,
    }));
    expect(authQuotaGateStateFromQuota(quota).mediaGenerationEntitled).toBe(false);
  });

  test('uses the Team display name when an enterprise quota omits planName', () => {
    const quota = normalizeAuthQuota({
      subscriptionStatus: 'enterprise',
      creditsLimit: 8000,
      creditsUsed: 0,
    }, labels);

    expect(quota.planName).toBe('Team');
    expect(quota.subscriptionStatus).toBe('enterprise');
  });

  test('honors explicit enterprise media entitlement without a personal subscription', () => {
    const quota = normalizeAuthQuota({
      planName: '团队版',
      subscriptionStatus: 'enterprise',
      creditsLimit: 8000,
      creditsUsed: 4480,
      hasPaidCredits: true,
      mediaGenerationEntitled: true,
    }, labels);

    expect(quota).toEqual(expect.objectContaining({
      subscriptionStatus: 'enterprise',
      hasPaidCredits: true,
      mediaGenerationEntitled: true,
    }));
    expect(authQuotaGateStateFromQuota(quota).mediaGenerationEntitled).toBe(true);
  });

  test('does not infer enterprise media entitlement from paid credits alone', () => {
    const quota = normalizeAuthQuota({
      planName: '团队版',
      subscriptionStatus: AuthSubscriptionStatus.Enterprise,
      creditsLimit: 8000,
      creditsUsed: 0,
      hasPaidCredits: true,
    }, labels);

    expect(quota.hasPaidCredits).toBe(true);
    expect(quota.mediaGenerationEntitled).toBe(false);
  });

  test('lets an explicit false entitlement override paid-credit compatibility', () => {
    const quota = normalizeAuthQuota({
      planName: '团队版',
      subscriptionStatus: 'enterprise',
      creditsLimit: 8000,
      creditsUsed: 0,
      hasPaidCredits: true,
      mediaGenerationEntitled: false,
    }, labels);

    expect(quota.mediaGenerationEntitled).toBe(false);
    expect(authQuotaGateStateFromQuota(quota).mediaGenerationEntitled).toBe(false);
  });

  test('uses a non-entitled free state as the default reset state', () => {
    expect(createDefaultAuthQuotaGateState()).toEqual({
      subscriptionStatus: AuthSubscriptionStatus.Free,
      mediaGenerationEntitled: false,
    });
  });
});


describe('temporarily unavailable quota during authenticated login', () => {
  test('keeps unknown membership and complete balance distinct from free and zero', () => {
    const quota = normalizeAuthQuota({ quotaUnavailable: true, freeCreditsTotal: 300, freeCreditsUsed: 20 }, {
      ...labels, fallbackSubscriptionStatus: AuthSubscriptionStatus.Active, unavailablePlanName: 'Unavailable',
    });
    expect(quota).toMatchObject({ quotaUnavailable: true, planName: 'Unavailable',
      subscriptionStatus: AuthSubscriptionStatus.Unavailable, creditsLimit: null, creditsUsed: null, creditsRemaining: null,
      freeCreditsTotal: 300, freeCreditsUsed: 20 });
    expect(authQuotaGateStateFromQuota(quota)).toEqual({ subscriptionStatus: AuthSubscriptionStatus.Unavailable, mediaGenerationEntitled: false });
  });
  test('does not turn partial or cached membership into media or publishing permission', () => {
    const quota = normalizeAuthQuota({ quotaUnavailable: true, subscriptionStatus: AuthSubscriptionStatus.Active,
      hasPaidCredits: false }, labels);
    expect(quota).toMatchObject({ mediaGenerationEntitled: false, shareEntitled: false, deploymentEntitled: false });
  });
  test('accepts the existing explicit independent media entitlement but not a membership inference', () => {
    expect(normalizeAuthQuota({ quotaUnavailable: true, hasPaidCredits: true }, labels).mediaGenerationEntitled).toBe(true);
    expect(normalizeAuthQuota({ quotaUnavailable: true, hasPaidCredits: true, mediaGenerationEntitled: false }, labels).mediaGenerationEntitled).toBe(false);
  });
  test('preserves only independently confirmed explicit server entitlements', () => {
    const quota = normalizeAuthQuota({ quotaUnavailable: true, subscriptionStatus: AuthSubscriptionStatus.Active,
      hasPaidCredits: true, mediaGenerationEntitled: true, shareEntitled: true, deploymentEntitled: false }, labels);
    expect(quota).toMatchObject({ subscriptionStatus: AuthSubscriptionStatus.Unavailable, creditsRemaining: null,
      hasPaidCredits: true, mediaGenerationEntitled: true, shareEntitled: true, deploymentEntitled: false });
  });
});
