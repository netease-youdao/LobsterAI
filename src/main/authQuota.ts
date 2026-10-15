import { AuthSubscriptionStatus } from '../shared/auth/constants';

export { AuthSubscriptionStatus };

export type NormalizeAuthQuotaLabels = {
  freePlanName: string;
  standardPlanName: string;
  fallbackSubscriptionStatus?: string;
  unavailablePlanName?: string;
};

export type NormalizedAuthQuota = Record<string, unknown> & {
  planName: string;
  subscriptionStatus: string;
  creditsLimit: number | null;
  creditsUsed: number | null;
  creditsRemaining: number | null;
  quotaUnavailable?: boolean;
  hasPaidCredits: boolean;
  mediaGenerationEntitled: boolean;
  shareEntitled: boolean;
  deploymentEntitled: boolean;
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
  if (quota.quotaUnavailable === true) return typeof quota.mediaGenerationEntitled === 'boolean'
    ? quota.mediaGenerationEntitled : quota.hasPaidCredits === true;
  if (typeof quota.mediaGenerationEntitled === 'boolean') {
    return quota.mediaGenerationEntitled;
  }
  const subscriptionStatus = typeof quota.subscriptionStatus === 'string'
    ? quota.subscriptionStatus
    : AuthSubscriptionStatus.Free;
  if (subscriptionStatus === AuthSubscriptionStatus.Enterprise) {
    return false;
  }
  return quota.hasPaidCredits === true || subscriptionStatus === AuthSubscriptionStatus.Active;
};

export const hasPublishingEntitlement = (
  quota: Record<string, unknown>,
  field: 'shareEntitled' | 'deploymentEntitled',
): boolean => {
  if (quota.quotaUnavailable === true) return quota[field] === true;
  if (typeof quota[field] === 'boolean') {
    return quota[field] as boolean;
  }
  const subscriptionStatus = typeof quota.subscriptionStatus === 'string'
    ? quota.subscriptionStatus
    : AuthSubscriptionStatus.Free;
  if (subscriptionStatus === AuthSubscriptionStatus.Enterprise) {
    return false;
  }
  return subscriptionStatus === AuthSubscriptionStatus.Active;
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
  if (raw.quotaUnavailable === true) {
    // Partial components never prove a total balance; only explicit server entitlements survive.
    return { ...raw, quotaUnavailable: true,
      planName: labels.unavailablePlanName ?? '—', subscriptionStatus: AuthSubscriptionStatus.Unavailable,
      creditsLimit: null, creditsUsed: null, creditsRemaining: null,
      hasPaidCredits: raw.hasPaidCredits === true, mediaGenerationEntitled: hasMediaGenerationEntitlement(raw),
      shareEntitled: hasPublishingEntitlement(raw, 'shareEntitled'), deploymentEntitled: hasPublishingEntitlement(raw, 'deploymentEntitled') };
  }
  let creditsLimit = 0;
  let creditsUsed = 0;
  let planName = labels.freePlanName;
  let subscriptionStatus: string = AuthSubscriptionStatus.Free;

  if (typeof raw.limit === 'number') {
    creditsLimit = raw.limit;
    creditsUsed = readNumber(raw.used);
    planName = readString(raw.planName, 'Team');
    subscriptionStatus = readString(
      raw.subscriptionStatus,
      AuthSubscriptionStatus.Enterprise,
    );
  } else if (typeof raw.freeCreditsTotal === 'number') {
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
    const hasPaidCredits = raw.hasPaidCredits === true
      || subscriptionStatus === AuthSubscriptionStatus.Active;
    const normalizedRaw = {
      ...raw,
      planName: readString(
        raw.planName,
        subscriptionStatus === AuthSubscriptionStatus.Enterprise ? 'Team' : labels.freePlanName,
      ),
      subscriptionStatus,
      creditsLimit,
      creditsUsed,
      creditsRemaining: typeof raw.creditsRemaining === 'number'
        ? raw.creditsRemaining
        : Math.max(0, creditsLimit - creditsUsed),
      hasPaidCredits,
      mediaGenerationEntitled: hasMediaGenerationEntitlement({
        ...raw,
        subscriptionStatus,
        hasPaidCredits,
      }),
      shareEntitled: hasPublishingEntitlement({ ...raw, subscriptionStatus }, 'shareEntitled'),
      deploymentEntitled: hasPublishingEntitlement(
        { ...raw, subscriptionStatus },
        'deploymentEntitled',
      ),
    } as NormalizedAuthQuota;
    return normalizedRaw;
  }

  const hasPaidCredits = raw.hasPaidCredits === true || subscriptionStatus === AuthSubscriptionStatus.Active;
  return {
    ...raw,
    planName,
    subscriptionStatus,
    creditsLimit,
    creditsUsed,
    creditsRemaining: Math.max(0, creditsLimit - creditsUsed),
    hasPaidCredits,
    mediaGenerationEntitled: hasMediaGenerationEntitlement({
      ...raw,
      subscriptionStatus,
      hasPaidCredits,
    }),
    shareEntitled: hasPublishingEntitlement({ ...raw, subscriptionStatus }, 'shareEntitled'),
    deploymentEntitled: hasPublishingEntitlement(
      { ...raw, subscriptionStatus },
      'deploymentEntitled',
    ),
  };
};
