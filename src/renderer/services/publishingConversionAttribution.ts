import { PublishingRecoveryAnalyticsInteractionType } from '@shared/analytics/constants';
import { AuthSubscriptionStatus } from '@shared/auth/constants';
import { EnterpriseAccountMode } from '@shared/enterpriseAccount/constants';
import { PublishingIdentityType } from '@shared/publishing/constants';

import { configService } from './config';
import { LogReporterAction, reportYdAnalyzer } from './logReporter';

export const PublishingConversionAttributionVersion = 3;

export const PublishingConversionAttributionModel = {
  LastTouch: 'last_touch',
} as const;

export const PublishingSubscriptionObservationConfidence = {
  KnownFree: 'known_free',
  UnknownBeforeLogin: 'unknown_before_login',
} as const;

const PUBLISHING_CONVERSION_ATTRIBUTION_STORAGE_KEY =
  'lobsterai_publishing_conversion_attribution_v3';
const LEGACY_PUBLISHING_CONVERSION_ATTRIBUTION_STORAGE_KEYS = [
  'lobsterai_publishing_conversion_attribution_v1',
  'lobsterai_publishing_conversion_attribution_v2',
] as const;
const PUBLISHING_CONVERSION_ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Analytics fields plus the local-only owner/resource envelope needed to keep
 * attribution isolated. The local-only fields are intentionally selected out
 * before an event is sent.
 */
export interface PublishingConversionAttributionInput {
  ownerAccountKey: string;
  resourceKey?: string;
  attemptId: string;
  operationId: string;
  interactionType?: string;
  feature: string;
  resourceKind: string;
  operationType: string;
  source: string;
  entryPoint: string;
  surface?: string;
  recoverySurface?: string;
  pageViewId?: string;
  hasExistingResource?: boolean;
  subscriptionRecoveryMode?: string;
  dialogType?: string;
  exposureId: string;
  identityType?: string;
  countMode?: string;
  quotaUsed?: number;
  quotaLimit?: number;
  canReleaseByClosing?: boolean;
  trialAccessTtlSeconds?: number;
  ctaId: string;
  target: string;
  dialogVisibleMs?: number;
  exposureToClickMs?: number;
}

interface StoredPublishingConversionAttribution
  extends PublishingConversionAttributionInput {
  attributionVersion: number;
  clickedAt: number;
  expiresAt: number;
}

export interface PublishingSubscriptionObservationSnapshot {
  ownerAccountKey: string | null | undefined;
  accountMode: string | null | undefined;
  subscriptionStatus: string | null | undefined;
}

let memoryAttribution: StoredPublishingConversionAttribution | null = null;
let pendingReport: Promise<boolean> | null = null;

const getLocalStorage = (): Storage | null => {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
};

const isStoredAttribution = (
  value: unknown,
): value is StoredPublishingConversionAttribution => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredPublishingConversionAttribution>;
  return candidate.attributionVersion === PublishingConversionAttributionVersion
    && typeof candidate.ownerAccountKey === 'string'
    && candidate.ownerAccountKey.length > 0
    && typeof candidate.attemptId === 'string'
    && candidate.attemptId.length > 0
    && typeof candidate.operationId === 'string'
    && candidate.operationId.length > 0
    && typeof candidate.exposureId === 'string'
    && candidate.exposureId.length > 0
    && typeof candidate.clickedAt === 'number'
    && Number.isFinite(candidate.clickedAt)
    && typeof candidate.expiresAt === 'number'
    && Number.isFinite(candidate.expiresAt);
};

const removeLegacyAttribution = (storage: Storage | null): void => {
  LEGACY_PUBLISHING_CONVERSION_ATTRIBUTION_STORAGE_KEYS.forEach(key => {
    storage?.removeItem(key);
  });
};

const persistAttribution = (value: StoredPublishingConversionAttribution): void => {
  memoryAttribution = value;
  try {
    getLocalStorage()?.setItem(
      PUBLISHING_CONVERSION_ATTRIBUTION_STORAGE_KEY,
      JSON.stringify(value),
    );
  } catch {
    // In-memory attribution still covers the normal external-browser return flow.
  }
};

const readAttribution = (): StoredPublishingConversionAttribution | null => {
  try {
    const storage = getLocalStorage();
    removeLegacyAttribution(storage);
    const raw = storage?.getItem(PUBLISHING_CONVERSION_ATTRIBUTION_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isStoredAttribution(parsed)) {
        memoryAttribution = parsed;
        return parsed;
      }
      storage?.removeItem(PUBLISHING_CONVERSION_ATTRIBUTION_STORAGE_KEY);
      memoryAttribution = null;
    }
  } catch {
    // Fall back to the in-memory copy when storage is unavailable or corrupt.
  }
  return memoryAttribution;
};

export const clearPendingPublishingConversionAttribution = (): void => {
  memoryAttribution = null;
  try {
    const storage = getLocalStorage();
    storage?.removeItem(PUBLISHING_CONVERSION_ATTRIBUTION_STORAGE_KEY);
    removeLegacyAttribution(storage);
  } catch {
    // Best-effort cleanup only.
  }
};

export const rememberPublishingConversionAttribution = (
  input: PublishingConversionAttributionInput,
  now = Date.now(),
): void => {
  if (configService.getConfig().usageAnalyticsEnabled === false) {
    clearPendingPublishingConversionAttribution();
    return;
  }
  if (!input.ownerAccountKey.trim()) {
    clearPendingPublishingConversionAttribution();
    return;
  }
  persistAttribution({
    ...input,
    attributionVersion: PublishingConversionAttributionVersion,
    clickedAt: now,
    expiresAt: now + PUBLISHING_CONVERSION_ATTRIBUTION_WINDOW_MS,
  });
};

const isPaidSubscriptionStatus = (subscriptionStatus: string | null | undefined): boolean => (
  subscriptionStatus === AuthSubscriptionStatus.Active
  || subscriptionStatus === AuthSubscriptionStatus.Enterprise
);

const isEligibleSubscriptionObservation = (
  attribution: StoredPublishingConversionAttribution,
  snapshot: PublishingSubscriptionObservationSnapshot,
): boolean => {
  if (
    attribution.interactionType
    === PublishingRecoveryAnalyticsInteractionType.RecoveryCta
  ) {
    return snapshot.accountMode === EnterpriseAccountMode.Personal
      && snapshot.subscriptionStatus === AuthSubscriptionStatus.Active
      && attribution.identityType === PublishingIdentityType.Free;
  }
  return isPaidSubscriptionStatus(snapshot.subscriptionStatus);
};

/**
 * Builds an explicit analytics allowlist. Do not replace this with a spread of
 * the stored attribution: ownerAccountKey and resourceKey are local-only.
 */
const getSubscriptionObservedParams = (
  attribution: StoredPublishingConversionAttribution,
): Record<string, string | number | boolean | undefined> => ({
  attemptId: attribution.attemptId,
  operationId: attribution.operationId,
  interactionType: attribution.interactionType,
  feature: attribution.feature,
  resourceKind: attribution.resourceKind,
  operationType: attribution.operationType,
  source: attribution.source,
  entryPoint: attribution.entryPoint,
  surface: attribution.surface,
  recoverySurface: attribution.recoverySurface,
  pageViewId: attribution.pageViewId,
  hasExistingResource: attribution.hasExistingResource,
  subscriptionRecoveryMode: attribution.subscriptionRecoveryMode,
  dialogType: attribution.dialogType,
  exposureId: attribution.exposureId,
  identityType: attribution.identityType,
  countMode: attribution.countMode,
  quotaUsed: attribution.quotaUsed,
  quotaLimit: attribution.quotaLimit,
  canReleaseByClosing: attribution.canReleaseByClosing,
  trialAccessTtlSeconds: attribution.trialAccessTtlSeconds,
  ctaId: attribution.ctaId,
  target: attribution.target,
  dialogVisibleMs: attribution.dialogVisibleMs,
  exposureToClickMs: attribution.exposureToClickMs,
});

/**
 * Reports that the client observed a paid subscription after a publishing CTA.
 * This deliberately does not claim payment success: the authoritative order
 * conversion still belongs to the portal/order analytics pipeline.
 */
export const reportPendingPublishingSubscriptionObserved = async (
  snapshot: PublishingSubscriptionObservationSnapshot,
  now = Date.now(),
): Promise<boolean> => {
  if (pendingReport) return pendingReport;

  const attribution = readAttribution();
  if (!attribution) return false;
  if (attribution.expiresAt <= now) {
    clearPendingPublishingConversionAttribution();
    return false;
  }
  if (configService.getConfig().usageAnalyticsEnabled === false) {
    clearPendingPublishingConversionAttribution();
    return false;
  }
  if (
    !snapshot.ownerAccountKey
    || snapshot.ownerAccountKey !== attribution.ownerAccountKey
  ) {
    clearPendingPublishingConversionAttribution();
    return false;
  }
  if (!isEligibleSubscriptionObservation(attribution, snapshot)) return false;

  const confidence = attribution.identityType === PublishingIdentityType.Free
    ? PublishingSubscriptionObservationConfidence.KnownFree
    : PublishingSubscriptionObservationConfidence.UnknownBeforeLogin;
  const report = reportYdAnalyzer({
    action: LogReporterAction.PublishingSubscriptionObserved,
    actionType: 'subscription_observed',
    ...getSubscriptionObservedParams(attribution),
    attributionModel: PublishingConversionAttributionModel.LastTouch,
    attributionAgeSeconds: Math.max(0, Math.round((now - attribution.clickedAt) / 1_000)),
    attributionWindowSeconds: PUBLISHING_CONVERSION_ATTRIBUTION_WINDOW_MS / 1_000,
    subscriptionStatus: snapshot.subscriptionStatus,
    confidence,
  }, {
    touchpointIdentityType: (
      attribution.interactionType === PublishingRecoveryAnalyticsInteractionType.RecoveryCta
      && attribution.identityType === PublishingIdentityType.Free
    )
      ? PublishingIdentityType.Free
      : undefined,
  }).then(success => {
    if (success) {
      const current = readAttribution();
      if (
        current?.attemptId === attribution.attemptId
        && current.operationId === attribution.operationId
        && current.exposureId === attribution.exposureId
        && current.clickedAt === attribution.clickedAt
      ) {
        clearPendingPublishingConversionAttribution();
      }
    }
    return success;
  }).finally(() => {
    pendingReport = null;
  });
  pendingReport = report;
  return report;
};
