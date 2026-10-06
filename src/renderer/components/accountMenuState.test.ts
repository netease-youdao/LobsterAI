import { AuthSubscriptionStatus } from '@shared/auth/constants';
import { describe, expect, test } from 'vitest';

import type {
  CreditItem,
  CreditsResetCampaignStatus,
  FreeCreditsReward,
} from '../store/slices/authSlice';
import {
  AccountPlanAnalyticsTier,
  getAccountMenuDisplayName,
  getAccountPlanAnalyticsContext,
  getAccountPlanPresentation,
  getFinalRewards,
  maskPhoneLikeAccountName,
} from './accountMenuState';

const creditItem = (
  overrides: Partial<CreditItem> = {},
): CreditItem => ({
  type: 'free',
  label: '每周免费积分',
  labelEn: 'Weekly free credits',
  creditsRemaining: 100,
  expiresAt: null,
  ...overrides,
});

const reward = (
  campaignCode: string,
  claimDeadline: string,
): FreeCreditsReward => ({
  campaignCode,
  credits: 500,
  claimDeadline,
  validityDays: 30,
});

const mobilePrefix = '188';
const mobileMiddle = '0000';
const mobileSuffix = '0000';
const mobileFixture = `${mobilePrefix}${mobileMiddle}${mobileSuffix}`;
const maskedMobileFixture = `${mobilePrefix}****${mobileSuffix}`;

const fallbackMobilePrefix = '199';
const fallbackMobileMiddle = '0000';
const fallbackMobileSuffix = '1234';
const fallbackMobileFixture = `${fallbackMobilePrefix}${fallbackMobileMiddle}${fallbackMobileSuffix}`;

describe('accountMenuState', () => {
  test('masks phone-like account names with prefix and suffix visible', () => {
    expect(maskPhoneLikeAccountName(mobileFixture)).toBe(maskedMobileFixture);
    expect(maskPhoneLikeAccountName(`+86${mobileFixture}`)).toBe(maskedMobileFixture);
    expect(maskPhoneLikeAccountName(`${mobilePrefix}-${mobileMiddle}-${mobileSuffix}`)).toBe(maskedMobileFixture);
    expect(maskPhoneLikeAccountName('Lobster User')).toBe('Lobster User');
  });

  test('keeps nickname priority while masking phone display values', () => {
    expect(getAccountMenuDisplayName({
      fallback: 'My Account',
      profileNickname: mobileFixture,
      userNickname: 'Tester',
      userPhone: fallbackMobileFixture,
    })).toBe(maskedMobileFixture);

    expect(getAccountMenuDisplayName({
      fallback: 'My Account',
      profileNickname: 'Tester',
      userPhone: fallbackMobileFixture,
    })).toBe('Tester');

    expect(getAccountMenuDisplayName({
      fallback: 'My Account',
      userPhone: `+86 ${fallbackMobilePrefix} ${fallbackMobileMiddle} ${fallbackMobileSuffix}`,
    })).toBe(`${fallbackMobilePrefix}****${fallbackMobileSuffix}`);

    expect(getAccountMenuDisplayName({
      fallback: 'My Account',
      userPhone: '1234',
    })).toBe('****1234');
  });

  test('uses the subscription item for the account plan even when its credits are exhausted', () => {
    const plan = getAccountPlanPresentation([
      creditItem(),
      creditItem({
        type: 'subscription',
        label: '标准',
        labelEn: 'Standard',
        creditsRemaining: 0,
        expiresAt: '2026-08-06',
      }),
    ], false);

    expect(plan).toEqual({
      label: '标准套餐',
      expiresAt: '2026-08-06',
      canUpgrade: true,
    });
  });

  test('hides the upgrade action for the highest excellent plan', () => {
    expect(getAccountPlanPresentation([
      creditItem({
        type: 'subscription',
        label: '卓越套餐',
        labelEn: 'Excellent',
      }),
    ], false)).toMatchObject({
      label: '卓越套餐',
      canUpgrade: false,
    });
  });

  test('uses the English plan label and hides the plan row for users without a subscription', () => {
    expect(getAccountPlanPresentation([
      creditItem({
        type: 'subscription',
        label: '标准',
        labelEn: 'Standard',
      }),
    ], true)?.label).toBe('Standard');
    expect(getAccountPlanPresentation([creditItem()], false)).toBeNull();
  });

  test('normalizes long English subscription labels for the compact account menu', () => {
    expect(getAccountPlanPresentation([
      creditItem({
        type: 'subscription',
        label: '专业套餐',
        labelEn: 'Professional Plan',
      }),
    ], true)?.label).toBe('Professional');

    expect(getAccountPlanPresentation([
      creditItem({
        type: 'subscription',
        label: '卓越套餐',
        labelEn: 'Excellent Plan',
      }),
    ], true)).toMatchObject({
      label: 'Elite',
      canUpgrade: false,
    });
  });

  test('does not duplicate the plan suffix for Chinese subscription labels', () => {
    expect(getAccountPlanPresentation([
      creditItem({
        type: 'subscription',
        label: '进阶套餐',
        labelEn: 'Advanced',
      }),
    ], false)?.label).toBe('进阶套餐');
  });

  test('reports basic tier analytics when no subscription plan is present', () => {
    expect(getAccountPlanAnalyticsContext({
      accountMode: 'personal',
      creditItems: [creditItem()],
      planName: '免费',
      subscriptionStatus: AuthSubscriptionStatus.Free,
    })).toEqual({
      accountMode: 'personal',
      subscriptionStatus: AuthSubscriptionStatus.Free,
      planTier: AccountPlanAnalyticsTier.Basic,
      hasSubscriptionPlan: false,
      canUpgrade: true,
    });
  });

  test('reports subscription tier analytics without exposing the display label', () => {
    expect(getAccountPlanAnalyticsContext({
      accountMode: 'personal',
      creditItems: [
        creditItem({
          type: 'subscription',
          label: '进阶套餐',
          labelEn: 'Advanced',
        }),
      ],
      planName: '进阶',
      subscriptionStatus: AuthSubscriptionStatus.Active,
    })).toEqual({
      accountMode: 'personal',
      subscriptionStatus: AuthSubscriptionStatus.Active,
      planTier: AccountPlanAnalyticsTier.Advanced,
      hasSubscriptionPlan: true,
      canUpgrade: true,
    });
  });

  test('marks excellent tier analytics as not upgradeable', () => {
    expect(getAccountPlanAnalyticsContext({
      accountMode: 'personal',
      creditItems: [
        creditItem({
          type: 'subscription',
          label: '卓越套餐',
          labelEn: 'Excellent',
        }),
      ],
      planName: 'Excellent',
      subscriptionStatus: AuthSubscriptionStatus.Active,
    })).toMatchObject({
      planTier: AccountPlanAnalyticsTier.Excellent,
      hasSubscriptionPlan: true,
      canUpgrade: false,
    });
  });

  test('falls back to unknown tier for unrecognized active subscriptions', () => {
    expect(getAccountPlanAnalyticsContext({
      accountMode: 'personal',
      creditItems: [
        creditItem({
          type: 'subscription',
          label: '内部套餐',
          labelEn: 'Internal',
        }),
      ],
      planName: null,
      subscriptionStatus: AuthSubscriptionStatus.Active,
    })).toMatchObject({
      subscriptionStatus: AuthSubscriptionStatus.Active,
      planTier: AccountPlanAnalyticsTier.Unknown,
      hasSubscriptionPlan: true,
    });
  });

  test('returns every available final reward ordered by claim deadline', () => {
    const status = {
      freeCreditsRewards: [
        reward('reward-later', '2026-08-31T16:00:00Z'),
        reward('reward-sooner', '2026-08-20T16:00:00Z'),
      ],
    } as CreditsResetCampaignStatus;

    expect(getFinalRewards(status).map(item => item.campaignCode)).toEqual([
      'reward-sooner',
      'reward-later',
    ]);
  });

  test('keeps compatibility with the legacy single final reward field', () => {
    const legacyReward = reward('legacy-reward', '2026-08-20T16:00:00Z');
    const status = {
      freeCreditsReward: legacyReward,
    } as CreditsResetCampaignStatus;

    expect(getFinalRewards(status)).toEqual([legacyReward]);
  });
});
