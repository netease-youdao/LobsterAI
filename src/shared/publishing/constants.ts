export const PublishingResourceKind = {
  File: 'file',
  Site: 'site',
} as const;

export type PublishingResourceKind =
  (typeof PublishingResourceKind)[keyof typeof PublishingResourceKind];

export const PublishingIdentityType = {
  Free: 'free',
  Subscription: 'subscription',
  Enterprise: 'enterprise',
} as const;

export type PublishingIdentityType =
  (typeof PublishingIdentityType)[keyof typeof PublishingIdentityType];

export const PublishingSubscriptionRecoveryMode = {
  None: 'none',
  Automatic: 'automatic',
  RedeployRequired: 'redeploy_required',
} as const;

export type PublishingSubscriptionRecoveryMode =
  typeof PublishingSubscriptionRecoveryMode[keyof typeof PublishingSubscriptionRecoveryMode];

export const normalizePublishingSubscriptionRecoveryMode = (
  value: unknown,
): PublishingSubscriptionRecoveryMode => (
  Object.values(PublishingSubscriptionRecoveryMode).includes(
    value as PublishingSubscriptionRecoveryMode,
  )
    ? value as PublishingSubscriptionRecoveryMode
    : PublishingSubscriptionRecoveryMode.None
);

export const PublishingCountMode = {
  Total: 'total',
  Active: 'active',
} as const;

export type PublishingCountMode =
  (typeof PublishingCountMode)[keyof typeof PublishingCountMode];

export interface PublishingQuotaErrorData {
  resourceKind: PublishingResourceKind;
  identityType: PublishingIdentityType;
  countMode: PublishingCountMode;
  used: number;
  limit: number;
  canReleaseByClosing: boolean;
}

export interface PublishingQuota extends PublishingQuotaErrorData {
  allowed: boolean;
  remaining: number;
  planName?: string;
  planDisplayName?: string;
}

export interface PublishingTrialResourcePolicy {
  resourceKind: PublishingResourceKind;
  countMode: typeof PublishingCountMode.Total;
  limit: number;
  accessTtlSeconds: number;
  canReleaseByClosing: false;
}

export interface PublishingTrialPolicy {
  identityType: typeof PublishingIdentityType.Free;
  file: PublishingTrialResourcePolicy;
  site: PublishingTrialResourcePolicy;
}

const isFiniteNonNegativeNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
);

export const normalizePublishingQuotaErrorData = (
  value: unknown,
): PublishingQuotaErrorData | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !Object.values(PublishingResourceKind).includes(
      record.resourceKind as PublishingResourceKind,
    )
    || !Object.values(PublishingIdentityType).includes(
      record.identityType as PublishingIdentityType,
    )
    || !Object.values(PublishingCountMode).includes(record.countMode as PublishingCountMode)
    || !isFiniteNonNegativeNumber(record.used)
    || !isFiniteNonNegativeNumber(record.limit)
    || typeof record.canReleaseByClosing !== 'boolean'
  ) {
    return undefined;
  }
  return {
    resourceKind: record.resourceKind as PublishingResourceKind,
    identityType: record.identityType as PublishingIdentityType,
    countMode: record.countMode as PublishingCountMode,
    used: record.used,
    limit: record.limit,
    canReleaseByClosing: record.canReleaseByClosing,
  };
};

const normalizePublishingTrialResourcePolicy = (
  value: unknown,
  expectedResourceKind: PublishingResourceKind,
): PublishingTrialResourcePolicy | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.resourceKind !== expectedResourceKind
    || record.countMode !== PublishingCountMode.Total
    || !isFiniteNonNegativeNumber(record.limit)
    || record.limit <= 0
    || !isFiniteNonNegativeNumber(record.accessTtlSeconds)
    || record.accessTtlSeconds <= 0
    || record.canReleaseByClosing !== false
  ) {
    return undefined;
  }
  return {
    resourceKind: expectedResourceKind,
    countMode: PublishingCountMode.Total,
    limit: record.limit,
    accessTtlSeconds: record.accessTtlSeconds,
    canReleaseByClosing: false,
  };
};

export const normalizePublishingTrialPolicy = (
  value: unknown,
): PublishingTrialPolicy | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.identityType !== PublishingIdentityType.Free) return undefined;
  const file = normalizePublishingTrialResourcePolicy(
    record.file,
    PublishingResourceKind.File,
  );
  const site = normalizePublishingTrialResourcePolicy(
    record.site,
    PublishingResourceKind.Site,
  );
  return file && site
    ? { identityType: PublishingIdentityType.Free, file, site }
    : undefined;
};
