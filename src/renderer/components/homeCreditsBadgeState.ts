import type { EnterpriseAccountContext } from '@shared/enterpriseAccount/types';

import type { CreditQuotaSnapshot } from '../services/lowCreditPurchaseOffer';
import type { CreditItem, ProfileSummary } from '../store/slices/authSlice';
import type { AccountConnectionState } from './accountConnectionState';

export const HomeCreditsMode = {
  Personal: 'personal',
  Enterprise: 'enterprise',
} as const;

export type HomeCreditsMode = typeof HomeCreditsMode[keyof typeof HomeCreditsMode];

export const HomeCreditsDisplayStatus = {
  Ready: 'ready',
  Loading: 'loading',
  Unavailable: 'unavailable',
} as const;

export type HomeCreditsDisplayStatus =
  typeof HomeCreditsDisplayStatus[keyof typeof HomeCreditsDisplayStatus];

export interface HomeCreditsPersonalViewModel {
  mode: typeof HomeCreditsMode.Personal;
  status: HomeCreditsDisplayStatus;
  remaining: number | null;
  compactText: string;
  exactText: string;
  creditItems: CreditItem[];
  hasProfileSummary: boolean;
  needsInitialLoad: boolean;
}

export interface HomeCreditsEnterpriseViewModel {
  mode: typeof HomeCreditsMode.Enterprise;
  status: typeof HomeCreditsDisplayStatus.Ready;
  remaining: number;
  limit: number;
  used: number;
  usageRatio: number;
  compactText: string;
  exactText: string;
  limitText: string;
  periodEndDate: string | null;
  needsInitialLoad: false;
}

export type HomeCreditsViewModel =
  | HomeCreditsPersonalViewModel
  | HomeCreditsEnterpriseViewModel;

const COMPACT_THRESHOLD = 10_000;

const sanitizeCredits = (value: number): number => (
  Number.isFinite(value) ? Math.max(0, value) : 0
);

const trimTrailingFractionZeros = (formatted: string): string => (
  formatted.replace(/\.0+$/, '').replace(/(\.\d*?[1-9])0+$/, '$1')
);

const formatDecimalFloor = (scaled: number): string => {
  const floored = Math.floor((scaled + Number.EPSILON) * 10) / 10;
  return trimTrailingFractionZeros(floored.toFixed(1));
};

/**
 * Formats credits for the compact header pill. Values above 10,000 collapse to
 * K/M/B (floored to 1 decimal) so the header capsule never jumps in width.
 */
export function formatCompactCredits(rawValue: number): string {
  const value = sanitizeCredits(rawValue);
  if (value > COMPACT_THRESHOLD) {
    if (value >= 1_000_000_000) {
      return `${formatDecimalFloor(value / 1_000_000_000)}B`;
    }
    if (value >= 1_000_000) {
      return `${formatDecimalFloor(value / 1_000_000)}M`;
    }
    return `${formatDecimalFloor(value / 1_000)}K`;
  }
  return formatExactCredits(value);
}

/**
 * Formats exact credit numbers with grouping separators for popovers/tooltips.
 */
export function formatExactCredits(rawValue: number): string {
  const value = sanitizeCredits(rawValue);
  const rounded = Math.round(value * 100) / 100;
  if (Number.isInteger(rounded)) {
    return rounded.toLocaleString('en-US');
  }
  return rounded.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

export function formatCreditExpiryDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return dateStr.trim() || null;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export function resolveHomeCreditsViewModel(input: {
  isLoggedIn: boolean;
  isAuthLoading: boolean;
  connectionState: AccountConnectionState | null;
  profileSummary: ProfileSummary | null;
  creditQuotaSnapshot: CreditQuotaSnapshot | null;
  enterpriseContext: EnterpriseAccountContext | null;
  isRefreshing: boolean;
}): HomeCreditsViewModel | null {
  if (!input.isLoggedIn) return null;

  if (input.enterpriseContext) {
    const remaining = sanitizeCredits(input.enterpriseContext.memberQuota.remaining);
    const limit = sanitizeCredits(input.enterpriseContext.memberQuota.limit);
    const used = sanitizeCredits(input.enterpriseContext.memberQuota.used);
    const usageRatio = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;
    return {
      mode: HomeCreditsMode.Enterprise,
      status: HomeCreditsDisplayStatus.Ready,
      remaining,
      limit,
      used,
      usageRatio,
      compactText: formatCompactCredits(remaining),
      exactText: formatExactCredits(remaining),
      limitText: formatExactCredits(limit),
      periodEndDate: formatCreditExpiryDate(
        input.enterpriseContext.memberQuota.periodEndExclusive,
      ),
      needsInitialLoad: false,
    };
  }

  const remainingCandidate = input.profileSummary?.totalCreditsRemaining
    ?? input.creditQuotaSnapshot?.creditsRemaining
    ?? null;
  const remaining = typeof remainingCandidate === 'number' && Number.isFinite(remainingCandidate)
    ? sanitizeCredits(remainingCandidate)
    : null;

  let status: HomeCreditsDisplayStatus;
  if (remaining !== null) {
    status = HomeCreditsDisplayStatus.Ready;
  } else if (!input.connectionState && (input.isAuthLoading || input.isRefreshing)) {
    status = HomeCreditsDisplayStatus.Loading;
  } else {
    status = HomeCreditsDisplayStatus.Unavailable;
  }

  return {
    mode: HomeCreditsMode.Personal,
    status,
    remaining,
    compactText: remaining !== null ? formatCompactCredits(remaining) : '--',
    exactText: remaining !== null ? formatExactCredits(remaining) : '--',
    creditItems: input.profileSummary?.creditItems ?? [],
    hasProfileSummary: input.profileSummary !== null,
    needsInitialLoad: input.profileSummary === null,
  };
}
