import { EnterpriseMemberRole } from '@shared/enterpriseAccount/constants';
import type { EnterpriseAccountContext } from '@shared/enterpriseAccount/types';
import { describe, expect, test } from 'vitest';

import { AccountConnectionState } from './accountConnectionState';
import {
  formatCompactCredits,
  formatCreditExpiryDate,
  formatExactCredits,
  HomeCreditsDisplayStatus,
  HomeCreditsMode,
  resolveHomeCreditsViewModel,
} from './homeCreditsBadgeState';

const makeEnterpriseContext = (
  overrides: Partial<EnterpriseAccountContext['memberQuota']> = {},
): EnterpriseAccountContext => ({
  accountMode: 'enterprise',
  enterpriseId: 1001,
  memberId: 42,
  enterpriseName: 'Acme Corp',
  role: EnterpriseMemberRole.Member,
  permissions: {
    manageEnterprise: false,
    adjustMemberQuota: false,
    rechargeEnterprise: false,
  },
  enterprisePool: {
    total: 50_000,
    used: 10_000,
    remaining: 40_000,
  },
  quotaStatus: {
    available: true,
    reason: null,
    errorCode: null,
  },
  memberQuota: {
    limit: 5_000,
    used: 1_250,
    remaining: 3_750,
    periodEndExclusive: '2026-12-01T00:00:00.000Z',
    ...overrides,
  },
});

describe('credit number formatting', () => {
  test('formats compact credits with grouping up to 10,000 and floored K/M suffixes above', () => {
    expect(formatCompactCredits(-5)).toBe('0');
    expect(formatCompactCredits(0)).toBe('0');
    expect(formatCompactCredits(99.5)).toBe('99.5');
    expect(formatCompactCredits(1_250)).toBe('1,250');
    expect(formatCompactCredits(10_000)).toBe('10,000');
    expect(formatCompactCredits(10_050)).toBe('10K');
    expect(formatCompactCredits(12_390)).toBe('12.3K');
    expect(formatCompactCredits(1_250_000)).toBe('1.2M');
    expect(formatCompactCredits(2_000_000_000)).toBe('2B');
  });

  test('formats exact credits with commas and trims trailing decimal zeros', () => {
    expect(formatExactCredits(12_345)).toBe('12,345');
    expect(formatExactCredits(1_234.5)).toBe('1,234.5');
    expect(formatExactCredits(1_234.25)).toBe('1,234.25');
    expect(formatExactCredits(1_234.00)).toBe('1,234');
  });

  test('formats ISO dates as YYYY.MM.DD', () => {
    expect(formatCreditExpiryDate('2026-12-31T23:59:59Z')).toBe('2026.12.31');
    expect(formatCreditExpiryDate(null)).toBeNull();
    expect(formatCreditExpiryDate('')).toBeNull();
  });
});

describe('resolveHomeCreditsViewModel', () => {
  test('returns null when logged out', () => {
    expect(resolveHomeCreditsViewModel({
      isLoggedIn: false,
      isAuthLoading: false,
      connectionState: null,
      profileSummary: null,
      creditQuotaSnapshot: null,
      enterpriseContext: null,
      isRefreshing: false,
    })).toBeNull();
  });

  test('resolves personal account from profileSummary with breakdown items', () => {
    const vm = resolveHomeCreditsViewModel({
      isLoggedIn: true,
      isAuthLoading: false,
      connectionState: null,
      profileSummary: {
        id: 1,
        nickname: 'Alice',
        avatarUrl: null,
        totalCreditsRemaining: 12_480,
        creditItems: [
          {
            type: 'subscription',
            label: '标准套餐',
            labelEn: 'Standard',
            creditsRemaining: 10_000,
            expiresAt: '2026-12-15T00:00:00Z',
          },
          {
            type: 'boost',
            label: '加油包',
            labelEn: 'Boost Pack',
            creditsRemaining: 2_480,
            expiresAt: null,
          },
        ],
      },
      creditQuotaSnapshot: null,
      enterpriseContext: null,
      isRefreshing: false,
    });

    expect(vm).toEqual({
      mode: HomeCreditsMode.Personal,
      status: HomeCreditsDisplayStatus.Ready,
      remaining: 12_480,
      compactText: '12.4K',
      exactText: '12,480',
      creditItems: expect.arrayContaining([
        expect.objectContaining({ type: 'subscription', creditsRemaining: 10_000 }),
        expect.objectContaining({ type: 'boost', creditsRemaining: 2_480 }),
      ]),
      hasProfileSummary: true,
      needsInitialLoad: false,
    });
  });

  test('uses creditQuotaSnapshot while profileSummary is still loading', () => {
    const vm = resolveHomeCreditsViewModel({
      isLoggedIn: true,
      isAuthLoading: false,
      connectionState: null,
      profileSummary: null,
      creditQuotaSnapshot: {
        creditsRemaining: 880,
        purchaseOffer: null,
      },
      enterpriseContext: null,
      isRefreshing: true,
    });

    expect(vm).toMatchObject({
      mode: HomeCreditsMode.Personal,
      status: HomeCreditsDisplayStatus.Ready,
      remaining: 880,
      compactText: '880',
      hasProfileSummary: false,
      needsInitialLoad: true,
    });
  });

  test('reports loading vs unavailable states accurately when no balance is cached yet', () => {
    const loadingVm = resolveHomeCreditsViewModel({
      isLoggedIn: true,
      isAuthLoading: false,
      connectionState: null,
      profileSummary: null,
      creditQuotaSnapshot: null,
      enterpriseContext: null,
      isRefreshing: true,
    });
    expect(loadingVm?.status).toBe(HomeCreditsDisplayStatus.Loading);

    const offlineVm = resolveHomeCreditsViewModel({
      isLoggedIn: true,
      isAuthLoading: false,
      connectionState: AccountConnectionState.Unavailable,
      profileSummary: null,
      creditQuotaSnapshot: null,
      enterpriseContext: null,
      isRefreshing: false,
    });
    expect(offlineVm?.status).toBe(HomeCreditsDisplayStatus.Unavailable);
    expect(offlineVm?.compactText).toBe('--');
  });

  test('resolves enterprise account member quota and usage ratio', () => {
    const vm = resolveHomeCreditsViewModel({
      isLoggedIn: true,
      isAuthLoading: false,
      connectionState: null,
      profileSummary: null,
      creditQuotaSnapshot: null,
      enterpriseContext: makeEnterpriseContext(),
      isRefreshing: false,
    });

    expect(vm).toEqual({
      mode: HomeCreditsMode.Enterprise,
      status: HomeCreditsDisplayStatus.Ready,
      remaining: 3_750,
      limit: 5_000,
      used: 1_250,
      usageRatio: 0.25,
      compactText: '3,750',
      exactText: '3,750',
      limitText: '5,000',
      periodEndDate: '2026.12.01',
      needsInitialLoad: false,
    });
  });
});
