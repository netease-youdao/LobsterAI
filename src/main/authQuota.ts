import { AuthSubscriptionStatus } from '../shared/auth/constants';

export { AuthSubscriptionStatus };

export type NormalizeAuthQuotaLabels = {
  freePlanName: string;
  standardPlanName: string;
  fallbackSubscriptionStatus?: string;
};

export type NormalizedAuthQuota = Record<string, unknown> & {
  planName: string;
  subscriptionStatus: string;
  creditsLimit: number;
  creditsUsed: number;
  creditsRemaining: number;
  hasPaidCredits: boolean;
};

export type AuthQuotaGateState = {
  subscriptionStatus: string;
  mediaGenerationEntitled: boolean;
};

const readNumber = (value: unknown, fallback = 0): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

const readString = (value: unknown, fallback: string): string => (
  typeof value === 'string' && value.trim() ? value : fallback
);

export const hasMediaGenerationEntitlement = (quota: Record<string, unknown>): boolean => {
  const subscriptionStatus = typeof quota.subscriptionStatus === 'string'
    ? quota.subscriptionStatus
    : AuthSubscriptionStatus.Free;
  return quota.hasPaidCredits === true || subscriptionStatus === AuthSubscriptionStatus.Active;
};

export const createDefaultAuthQuotaGateState = (): AuthQuotaGateState => ({
  subscriptionStatus: AuthSubscriptionStatus.Free,
  mediaGenerationEntitled: false,
});

export const authQuotaGateStateFromQuota = (quota: Record<string, unknown>): AuthQuotaGateState => {
  const subscriptionStatus = typeof quota.subscriptionStatus === 'string'
    ? quota.subscriptionStatus
    : AuthSubscriptionStatus.Free;
  return {
    subscriptionStatus,
    mediaGenerationEntitled: hasMediaGenerationEntitlement(quota),
  };
};

export const normalizeAuthQuota = (
  raw: Record<string, unknown>,
  labels: NormalizeAuthQuotaLabels,
): NormalizedAuthQuota => {
  let creditsLimit = 0;
  let creditsUsed = 0;
  let planName = labels.freePlanName;
  let subscriptionStatus: string = AuthSubscriptionStatus.Free;

  if (typeof raw.freeCreditsTotal === 'number') {
    creditsLimit = raw.freeCreditsTotal;
    creditsUsed = readNumber(raw.freeCreditsUsed);
    planName = readString(raw.planName, labels.freePlanName);
    subscriptionStatus = readString(raw.subscriptionStatus, AuthSubscriptionStatus.Free);
  } else if (typeof raw.monthlyCreditsLimit === 'number') {
    creditsLimit = raw.monthlyCreditsLimit;
    creditsUsed = readNumber(raw.monthlyCreditsUsed);
    planName = readString(raw.planName, labels.standardPlanName);
    subscriptionStatus = readString(raw.subscriptionStatus, AuthSubscriptionStatus.Active);
  } else if (typeof raw.dailyCreditsLimit === 'number') {
    creditsLimit = raw.dailyCreditsLimit;
    creditsUsed = readNumber(raw.dailyCreditsUsed);
    planName = readString(raw.planName, labels.freePlanName);
    subscriptionStatus = readString(raw.subscriptionStatus, AuthSubscriptionStatus.Free);
  } else if (typeof raw.creditsLimit === 'number') {
    subscriptionStatus = readString(
      raw.subscriptionStatus,
      labels.fallbackSubscriptionStatus ?? AuthSubscriptionStatus.Free,
    );
    creditsLimit = readNumber(raw.creditsLimit);
    creditsUsed = readNumber(raw.creditsUsed);
    const normalizedRaw = {
      ...raw,
      planName: readString(raw.planName, labels.freePlanName),
      subscriptionStatus,
      creditsLimit,
      creditsUsed,
      creditsRemaining: typeof raw.creditsRemaining === 'number'
        ? raw.creditsRemaining
        : Math.max(0, creditsLimit - creditsUsed),
      hasPaidCredits: raw.hasPaidCredits === true || subscriptionStatus === AuthSubscriptionStatus.Active,
    } as NormalizedAuthQuota;
    return normalizedRaw;
  }

  const hasPaidCredits = raw.hasPaidCredits === true || subscriptionStatus === AuthSubscriptionStatus.Active;
  return {
    planName,
    subscriptionStatus,
    creditsLimit,
    creditsUsed,
    creditsRemaining: Math.max(0, creditsLimit - creditsUsed),
    hasPaidCredits,
  };
};
