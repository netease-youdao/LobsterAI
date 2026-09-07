import {
  PublishingRecoveryAnalyticsInteractionType,
  type PublishingRecoveryAnalyticsOutcome,
  type PublishingRecoveryAnalyticsSurface,
} from '@shared/analytics/constants';
import {
  PublishingIdentityType,
  type PublishingQuotaErrorData,
  PublishingResourceKind,
  PublishingSubscriptionRecoveryMode,
} from '@shared/publishing/constants';

import { configService } from '@/services/config';
import { LogReporterAction, reportYdAnalyzer } from '@/services/logReporter';
import { rememberPublishingConversionAttribution } from '@/services/publishingConversionAttribution';
import { store } from '@/store';

import {
  type ArtifactPreviewActionSource,
  type ArtifactPublishEntryPoint,
} from './artifactAnalytics';
import {
  ArtifactSubscriptionBlockReason,
  ArtifactSubscriptionFeature,
  type ArtifactSubscriptionFeature as ArtifactSubscriptionFeatureValue,
} from './artifactSubscriptionGate';

export const PublishingAnalyticsEventVersion = 2;
export const PublishingAnalyticsDialogVersion = 2;
export const PublishingRecoveryAnalyticsEventVersion = 1;

export const PublishingAnalyticsOperationType = {
  Create: 'create',
  Manage: 'manage',
  UpdateContent: 'update_content',
  UpdatePermission: 'update_permission',
  Redeploy: 'redeploy',
  SubscriptionRecovery: 'subscription_recovery',
  Unknown: 'unknown',
} as const;

export type PublishingAnalyticsOperationType =
  typeof PublishingAnalyticsOperationType[keyof typeof PublishingAnalyticsOperationType];

export const PublishingAnalyticsDialogType = {
  LoginRequired: 'login_required',
  TrialNotice: 'trial_notice',
  FreeQuotaExhausted: 'free_quota_exhausted',
  SubscriptionRequired: 'subscription_required',
  ActiveQuotaLimit: 'active_quota_limit',
  EnterpriseUnavailable: 'enterprise_unavailable',
  ShareEditor: 'share_editor',
  DeploymentEditor: 'deployment_editor',
  DeploymentStatus: 'deployment_status',
} as const;

export type PublishingAnalyticsDialogType =
  typeof PublishingAnalyticsDialogType[keyof typeof PublishingAnalyticsDialogType];

export const PublishingAnalyticsActionType = {
  Click: 'click',
  Close: 'close',
} as const;

export type PublishingAnalyticsActionType =
  typeof PublishingAnalyticsActionType[keyof typeof PublishingAnalyticsActionType];

export const PublishingAnalyticsCtaId = {
  Primary: 'primary',
  Secondary: 'secondary',
  Close: 'close',
} as const;

export type PublishingAnalyticsCtaId =
  typeof PublishingAnalyticsCtaId[keyof typeof PublishingAnalyticsCtaId];

export const PublishingAnalyticsTarget = {
  Login: 'login',
  Continue: 'continue',
  Pricing: 'pricing',
  LearnBenefits: 'learn_benefits',
  ManageCloud: 'manage_cloud',
  CreateShare: 'create_share',
  UpdateContent: 'update_content',
  UpdatePermission: 'update_permission',
  CopyLink: 'copy_link',
  CreateDeployment: 'create_deployment',
  Redeploy: 'redeploy',
  Dismiss: 'dismiss',
} as const;

export type PublishingAnalyticsTarget =
  typeof PublishingAnalyticsTarget[keyof typeof PublishingAnalyticsTarget];

export const PublishingAnalyticsResult = {
  Success: 'success',
  Failure: 'fail',
} as const;

export type PublishingAnalyticsResult =
  typeof PublishingAnalyticsResult[keyof typeof PublishingAnalyticsResult];

export const PublishingAnalyticsErrorCategory = {
  ApiUnavailable: 'api_unavailable',
  InvalidSource: 'invalid_source',
  NetworkOrServer: 'network_or_server',
  Quota: 'quota',
  Subscription: 'subscription',
  Unknown: 'unknown',
} as const;

export type PublishingAnalyticsErrorCategory =
  typeof PublishingAnalyticsErrorCategory[keyof typeof PublishingAnalyticsErrorCategory];

export const PublishingAnalyticsDeploymentPhase = {
  Accepted: 'accepted',
  Terminal: 'terminal',
} as const;

export type PublishingAnalyticsDeploymentPhase =
  typeof PublishingAnalyticsDeploymentPhase[keyof typeof PublishingAnalyticsDeploymentPhase];

export const PublishingAnalyticsFinalStatus = {
  Publishing: 'publishing',
  Live: 'live',
  Failed: 'failed',
  Stopped: 'stopped',
  Expired: 'expired',
} as const;

export type PublishingAnalyticsFinalStatus =
  typeof PublishingAnalyticsFinalStatus[keyof typeof PublishingAnalyticsFinalStatus];

export interface PublishingAnalyticsAttemptContext {
  attemptId: string;
  feature: ArtifactSubscriptionFeatureValue;
  resourceKind: typeof PublishingResourceKind.File | typeof PublishingResourceKind.Site;
  operationType: PublishingAnalyticsOperationType;
  source: ArtifactPreviewActionSource;
  entryPoint: ArtifactPublishEntryPoint;
  surface?: string;
  pageViewId?: string;
  hasExistingResource?: boolean;
}

export interface PublishingAnalyticsDialogContext {
  attempt: PublishingAnalyticsAttemptContext;
  dialogType: PublishingAnalyticsDialogType;
  exposureId: string;
  openedAt: number;
  quota?: PublishingQuotaErrorData;
  trialAccessTtlSeconds?: number;
}

export type PublishingRecoveryAnalyticsMode =
  | typeof PublishingSubscriptionRecoveryMode.Automatic
  | typeof PublishingSubscriptionRecoveryMode.RedeployRequired;

export interface PublishingRecoveryAnalyticsContext {
  attemptId: string;
  exposureId: string;
  exposedAt: number;
  feature: ArtifactSubscriptionFeatureValue;
  resourceKind: typeof PublishingResourceKind.File | typeof PublishingResourceKind.Site;
  source: ArtifactPreviewActionSource;
  entryPoint: ArtifactPublishEntryPoint;
  surface?: string;
  recoverySurface: PublishingRecoveryAnalyticsSurface;
  pageViewId?: string;
  subscriptionRecoveryMode: PublishingRecoveryAnalyticsMode;
  /** Local-only owner scope. Never include this field in an analytics payload. */
  ownerAccountKey: string;
  /** Local-only stable resource key. Never include this field in an analytics payload. */
  resourceKey: string;
}

export interface CreatePublishingRecoveryAnalyticsContextInput {
  attemptId?: string;
  feature: ArtifactSubscriptionFeatureValue;
  resourceKind: typeof PublishingResourceKind.File | typeof PublishingResourceKind.Site;
  source: ArtifactPreviewActionSource;
  entryPoint: ArtifactPublishEntryPoint;
  surface?: string;
  recoverySurface: PublishingRecoveryAnalyticsSurface;
  pageViewId?: string;
  subscriptionRecoveryMode: PublishingRecoveryAnalyticsMode;
  ownerAccountKey: string;
  resourceKey: string;
}

export interface CreatePublishingRecoveryAnalyticsContextFromAttemptInput {
  surface?: string;
  recoverySurface: PublishingRecoveryAnalyticsSurface;
  subscriptionRecoveryMode: PublishingRecoveryAnalyticsMode;
  ownerAccountKey: string;
  resourceKey: string;
}

const createId = (): string => (
  globalThis.crypto?.randomUUID?.()
  ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
);

export const createPublishingAnalyticsOperationId = createId;

export const createPublishingRecoveryAnalyticsContext = (
  input: CreatePublishingRecoveryAnalyticsContextInput,
  now = Date.now(),
): PublishingRecoveryAnalyticsContext => ({
  attemptId: input.attemptId ?? createId(),
  exposureId: createId(),
  exposedAt: now,
  feature: input.feature,
  resourceKind: input.resourceKind,
  source: input.source,
  entryPoint: input.entryPoint,
  surface: input.surface,
  recoverySurface: input.recoverySurface,
  pageViewId: input.pageViewId,
  subscriptionRecoveryMode: input.subscriptionRecoveryMode,
  ownerAccountKey: input.ownerAccountKey,
  resourceKey: input.resourceKey,
});

export const createPublishingRecoveryAnalyticsContextFromAttempt = (
  attempt: PublishingAnalyticsAttemptContext,
  input: CreatePublishingRecoveryAnalyticsContextFromAttemptInput,
  now = Date.now(),
): PublishingRecoveryAnalyticsContext => createPublishingRecoveryAnalyticsContext({
  attemptId: attempt.attemptId,
  feature: attempt.feature,
  resourceKind: attempt.resourceKind,
  source: attempt.source,
  entryPoint: attempt.entryPoint,
  surface: input.surface ?? attempt.surface,
  recoverySurface: input.recoverySurface,
  pageViewId: attempt.pageViewId,
  subscriptionRecoveryMode: input.subscriptionRecoveryMode,
  ownerAccountKey: input.ownerAccountKey,
  resourceKey: input.resourceKey,
}, now);

export const createPublishingAnalyticsAttempt = (
  input: Omit<PublishingAnalyticsAttemptContext, 'attemptId'>,
): PublishingAnalyticsAttemptContext => ({
  ...input,
  attemptId: createId(),
});

export const updatePublishingAnalyticsAttempt = (
  attempt: PublishingAnalyticsAttemptContext,
  update: Partial<Pick<
    PublishingAnalyticsAttemptContext,
    'operationType' | 'hasExistingResource'
  >>,
): PublishingAnalyticsAttemptContext => ({ ...attempt, ...update });

export const createPublishingAnalyticsDialog = (
  attempt: PublishingAnalyticsAttemptContext,
  dialogType: PublishingAnalyticsDialogType,
  quota?: PublishingQuotaErrorData,
  trialAccessTtlSeconds?: number,
): PublishingAnalyticsDialogContext => ({
  attempt,
  dialogType,
  exposureId: createId(),
  openedAt: Date.now(),
  quota,
  trialAccessTtlSeconds,
});

export const getPublishingDialogTypeForSubscriptionReason = (
  reason: ArtifactSubscriptionBlockReason,
): PublishingAnalyticsDialogType => {
  if (reason === ArtifactSubscriptionBlockReason.LoginRequired) {
    return PublishingAnalyticsDialogType.LoginRequired;
  }
  if (reason === ArtifactSubscriptionBlockReason.EnterpriseUnavailable) {
    return PublishingAnalyticsDialogType.EnterpriseUnavailable;
  }
  return PublishingAnalyticsDialogType.SubscriptionRequired;
};

export const getPublishingDialogTypeForQuota = (
  quota: PublishingQuotaErrorData,
): PublishingAnalyticsDialogType => (
  quota.identityType === PublishingIdentityType.Free
    ? PublishingAnalyticsDialogType.FreeQuotaExhausted
    : PublishingAnalyticsDialogType.ActiveQuotaLimit
);

const getAttemptParams = (
  attempt: PublishingAnalyticsAttemptContext,
): Record<string, string | number | boolean | undefined> => ({
  eventVersion: PublishingAnalyticsEventVersion,
  attemptId: attempt.attemptId,
  feature: attempt.feature,
  resourceKind: attempt.resourceKind,
  operationType: attempt.operationType,
  source: attempt.source,
  entryPoint: attempt.entryPoint,
  surface: attempt.surface,
  pageViewId: attempt.pageViewId,
  hasExistingResource: attempt.hasExistingResource,
});

const getDialogParams = (
  context: PublishingAnalyticsDialogContext,
): Record<string, string | number | boolean | undefined> => ({
  ...getAttemptParams(context.attempt),
  dialogVersion: PublishingAnalyticsDialogVersion,
  dialogType: context.dialogType,
  exposureId: context.exposureId,
  identityType: context.quota?.identityType,
  countMode: context.quota?.countMode,
  quotaUsed: context.quota?.used,
  quotaLimit: context.quota?.limit,
  canReleaseByClosing: context.quota?.canReleaseByClosing,
  trialAccessTtlSeconds: context.trialAccessTtlSeconds,
});

const getRecoveryParams = (
  context: PublishingRecoveryAnalyticsContext,
): Record<string, string | number | boolean | undefined> => ({
  eventVersion: PublishingRecoveryAnalyticsEventVersion,
  attemptId: context.attemptId,
  exposureId: context.exposureId,
  interactionType: PublishingRecoveryAnalyticsInteractionType.RecoveryCta,
  feature: context.feature,
  resourceKind: context.resourceKind,
  operationType: PublishingAnalyticsOperationType.SubscriptionRecovery,
  source: context.source,
  entryPoint: context.entryPoint,
  surface: context.surface,
  recoverySurface: context.recoverySurface,
  pageViewId: context.pageViewId,
  hasExistingResource: true,
  identityType: PublishingIdentityType.Free,
  subscriptionRecoveryMode: context.subscriptionRecoveryMode,
});

const PublishingRecoveryExposureDedupLimit = 2_000;
interface PublishingRecoveryExposureRecord {
  exposureId: string;
  exposedAt: number;
}
const publishingRecoveryExposures = new Map<string, PublishingRecoveryExposureRecord>();

const getPublishingRecoveryLocalKey = (
  ownerAccountKey: string,
  resourceKey: string,
): string => JSON.stringify([ownerAccountKey, resourceKey]);

const getPublishingRecoveryExposureKey = (
  context: PublishingRecoveryAnalyticsContext,
): string => JSON.stringify([
  context.ownerAccountKey,
  context.pageViewId ?? context.attemptId,
  context.resourceKey,
  context.recoverySurface,
  context.subscriptionRecoveryMode,
]);

const rememberPublishingRecoveryExposure = (
  key: string,
  record: PublishingRecoveryExposureRecord,
): void => {
  if (publishingRecoveryExposures.size >= PublishingRecoveryExposureDedupLimit) {
    const oldestKey = publishingRecoveryExposures.keys().next().value;
    if (typeof oldestKey === 'string') publishingRecoveryExposures.delete(oldestKey);
  }
  publishingRecoveryExposures.set(key, record);
};

export const reportPublishingRecoveryCtaExposure = (
  context: PublishingRecoveryAnalyticsContext,
  now = Date.now(),
): boolean => {
  if (configService.getConfig().usageAnalyticsEnabled === false) return false;
  const exposureKey = getPublishingRecoveryExposureKey(context);
  const existingExposure = publishingRecoveryExposures.get(exposureKey);
  if (existingExposure) {
    context.exposureId = existingExposure.exposureId;
    context.exposedAt = existingExposure.exposedAt;
    return false;
  }
  context.exposedAt = now;
  rememberPublishingRecoveryExposure(exposureKey, {
    exposureId: context.exposureId,
    exposedAt: context.exposedAt,
  });
  void reportYdAnalyzer({
    action: LogReporterAction.PublishingRecoveryCtaExposure,
    actionType: 'exposure',
    ...getRecoveryParams(context),
  }, {
    touchpointIdentityType: PublishingIdentityType.Free,
  });
  return true;
};

/** Call when a CTA becomes hidden while its page/dialog lifecycle stays alive. */
export const resetPublishingRecoveryCtaExposure = (
  context: PublishingRecoveryAnalyticsContext,
  now = Date.now(),
): PublishingRecoveryAnalyticsContext => {
  publishingRecoveryExposures.delete(getPublishingRecoveryExposureKey(context));
  context.exposureId = createId();
  context.exposedAt = now;
  return context;
};

interface PublishingRecoveryResultCorrelation {
  context: PublishingRecoveryAnalyticsContext;
  operationId: string;
  clickedAt: number;
}

const publishingRecoveryResultCorrelations =
  new Map<string, PublishingRecoveryResultCorrelation>();
interface PendingPublishingRecoveryResultReport {
  operationId: string;
  promise: Promise<boolean>;
}
const pendingPublishingRecoveryResultReports =
  new Map<string, PendingPublishingRecoveryResultReport>();

export interface ReportPublishingRecoveryCtaActionOptions {
  operationId?: string;
  now?: number;
}

export const reportPublishingRecoveryCtaAction = (
  context: PublishingRecoveryAnalyticsContext,
  options: ReportPublishingRecoveryCtaActionOptions = {},
): string => {
  const clickedAt = options.now ?? Date.now();
  const operationId = options.operationId ?? createPublishingAnalyticsOperationId();
  const exposureToClickMs = Math.max(0, clickedAt - context.exposedAt);
  const analyticsEnabled = configService.getConfig().usageAnalyticsEnabled !== false;

  if (analyticsEnabled && context.ownerAccountKey.trim() && context.resourceKey.trim()) {
    rememberPublishingConversionAttribution({
      ownerAccountKey: context.ownerAccountKey,
      resourceKey: context.resourceKey,
      attemptId: context.attemptId,
      operationId,
      interactionType: PublishingRecoveryAnalyticsInteractionType.RecoveryCta,
      feature: context.feature,
      resourceKind: context.resourceKind,
      operationType: PublishingAnalyticsOperationType.SubscriptionRecovery,
      source: context.source,
      entryPoint: context.entryPoint,
      surface: context.surface,
      recoverySurface: context.recoverySurface,
      pageViewId: context.pageViewId,
      hasExistingResource: true,
      subscriptionRecoveryMode: context.subscriptionRecoveryMode,
      exposureId: context.exposureId,
      identityType: PublishingIdentityType.Free,
      ctaId: PublishingAnalyticsCtaId.Primary,
      target: PublishingAnalyticsTarget.Pricing,
      exposureToClickMs,
    }, clickedAt);
    publishingRecoveryResultCorrelations.set(
      getPublishingRecoveryLocalKey(context.ownerAccountKey, context.resourceKey),
      { context: { ...context }, operationId, clickedAt },
    );
  }

  void reportYdAnalyzer({
    action: LogReporterAction.PublishingRecoveryCtaAction,
    ...getRecoveryParams(context),
    actionType: PublishingAnalyticsActionType.Click,
    ctaId: PublishingAnalyticsCtaId.Primary,
    target: PublishingAnalyticsTarget.Pricing,
    operationId,
    exposureToClickMs,
  }, {
    touchpointIdentityType: PublishingIdentityType.Free,
  });
  return operationId;
};

export interface PublishingRecoveryResultLookup {
  ownerAccountKey: string;
  resourceKey: string;
}

export interface ReportPublishingRecoveryResultOptions
  extends PublishingRecoveryResultLookup {
  outcome: PublishingRecoveryAnalyticsOutcome;
  now?: number;
}

export const getPendingPublishingRecoveryResultOperationId = (
  lookup: PublishingRecoveryResultLookup,
): string | null => (
  publishingRecoveryResultCorrelations.get(
    getPublishingRecoveryLocalKey(lookup.ownerAccountKey, lookup.resourceKey),
  )?.operationId ?? null
);

export const reportPublishingRecoveryResult = async (
  options: ReportPublishingRecoveryResultOptions,
): Promise<boolean> => {
  const localKey = getPublishingRecoveryLocalKey(
    options.ownerAccountKey,
    options.resourceKey,
  );
  const correlation = publishingRecoveryResultCorrelations.get(localKey);
  if (!correlation) return false;
  const pendingReport = pendingPublishingRecoveryResultReports.get(localKey);
  if (pendingReport?.operationId === correlation.operationId) return pendingReport.promise;
  if (configService.getConfig().usageAnalyticsEnabled === false) {
    publishingRecoveryResultCorrelations.delete(localKey);
    return false;
  }

  const report = reportYdAnalyzer({
    action: LogReporterAction.PublishingRecoveryResult,
    ...getRecoveryParams(correlation.context),
    operationId: correlation.operationId,
    outcome: options.outcome,
    durationMs: Math.max(0, (options.now ?? Date.now()) - correlation.clickedAt),
  }, {
    touchpointIdentityType: PublishingIdentityType.Free,
  }).then(success => {
    const current = publishingRecoveryResultCorrelations.get(localKey);
    if (success && current?.operationId === correlation.operationId) {
      publishingRecoveryResultCorrelations.delete(localKey);
    }
    return success;
  }).finally(() => {
    if (pendingPublishingRecoveryResultReports.get(localKey)?.promise === report) {
      pendingPublishingRecoveryResultReports.delete(localKey);
    }
  });
  pendingPublishingRecoveryResultReports.set(localKey, {
    operationId: correlation.operationId,
    promise: report,
  });
  return report;
};

export const clearPublishingRecoveryAnalyticsState = (
  ownerAccountKey?: string,
): void => {
  if (!ownerAccountKey) {
    publishingRecoveryExposures.clear();
    publishingRecoveryResultCorrelations.clear();
    pendingPublishingRecoveryResultReports.clear();
    return;
  }
  publishingRecoveryResultCorrelations.forEach((correlation, key) => {
    if (correlation.context.ownerAccountKey === ownerAccountKey) {
      publishingRecoveryResultCorrelations.delete(key);
    }
  });
  [...publishingRecoveryExposures.keys()].forEach(key => {
    try {
      const [keyOwner] = JSON.parse(key) as unknown[];
      if (keyOwner === ownerAccountKey) publishingRecoveryExposures.delete(key);
    } catch {
      publishingRecoveryExposures.delete(key);
    }
  });
  [...pendingPublishingRecoveryResultReports.keys()].forEach(key => {
    try {
      const [keyOwner] = JSON.parse(key) as unknown[];
      if (keyOwner === ownerAccountKey) pendingPublishingRecoveryResultReports.delete(key);
    } catch {
      pendingPublishingRecoveryResultReports.delete(key);
    }
  });
};

export const reportPublishingEntryAction = (
  attempt: PublishingAnalyticsAttemptContext,
): void => {
  void reportYdAnalyzer({
    action: LogReporterAction.PublishingEntryAction,
    actionType: 'click',
    ...getAttemptParams(attempt),
  });
};

export const reportPublishingDialogExposure = (
  context: PublishingAnalyticsDialogContext,
): void => {
  void reportYdAnalyzer({
    action: LogReporterAction.PublishingDialogExposure,
    actionType: 'exposure',
    ...getDialogParams(context),
  });
};

export interface ReportPublishingDialogActionOptions {
  actionType: PublishingAnalyticsActionType;
  ctaId: PublishingAnalyticsCtaId;
  target: PublishingAnalyticsTarget;
  operationId?: string;
}

export const reportPublishingDialogAction = (
  context: PublishingAnalyticsDialogContext,
  options: ReportPublishingDialogActionOptions,
): string => {
  const dialogVisibleMs = Math.max(0, Date.now() - context.openedAt);
  const operationId = options.operationId ?? createPublishingAnalyticsOperationId();
  if (
    options.actionType === PublishingAnalyticsActionType.Click
    && (
      options.target === PublishingAnalyticsTarget.Login
      || options.target === PublishingAnalyticsTarget.Pricing
      || options.target === PublishingAnalyticsTarget.LearnBenefits
    )
  ) {
    const ownerAccountKey = store.getState().auth.ownerAccountKey;
    if (ownerAccountKey) {
      rememberPublishingConversionAttribution({
        ownerAccountKey,
        attemptId: context.attempt.attemptId,
        feature: context.attempt.feature,
        resourceKind: context.attempt.resourceKind,
        operationType: context.attempt.operationType,
        source: context.attempt.source,
        entryPoint: context.attempt.entryPoint,
        surface: context.attempt.surface,
        pageViewId: context.attempt.pageViewId,
        hasExistingResource: context.attempt.hasExistingResource,
        dialogType: context.dialogType,
        exposureId: context.exposureId,
        identityType: context.quota?.identityType,
        countMode: context.quota?.countMode,
        quotaUsed: context.quota?.used,
        quotaLimit: context.quota?.limit,
        canReleaseByClosing: context.quota?.canReleaseByClosing,
        trialAccessTtlSeconds: context.trialAccessTtlSeconds,
        ctaId: options.ctaId,
        target: options.target,
        operationId,
        dialogVisibleMs,
      });
    }
  }
  void reportYdAnalyzer({
    action: LogReporterAction.PublishingDialogAction,
    ...getDialogParams(context),
    ...options,
    operationId,
    dialogVisibleMs,
  });
  return operationId;
};

export interface ReportPublishingOperationResultOptions {
  result: PublishingAnalyticsResult;
  operationType?: PublishingAnalyticsOperationType;
  errorCategory?: PublishingAnalyticsErrorCategory;
  operationId?: string;
  exposureId?: string;
  shareId?: string;
  siteId?: string;
  deploymentId?: string;
  accessPermission?: string;
  durationMs?: number;
  finalStatus?: PublishingAnalyticsFinalStatus;
  rawDeploymentStatus?: string;
}

export const reportPublishingOperationResult = (
  attempt: PublishingAnalyticsAttemptContext,
  options: ReportPublishingOperationResultOptions,
): void => {
  void reportYdAnalyzer({
    action: LogReporterAction.PublishingOperationResult,
    ...getAttemptParams(attempt),
    operationType: options.operationType ?? attempt.operationType,
    operationId: options.operationId ?? createPublishingAnalyticsOperationId(),
    exposureId: options.exposureId,
    shareId: options.shareId,
    siteId: options.siteId,
    deploymentId: options.deploymentId,
    deployId: options.deploymentId,
    accessPermission: options.accessPermission,
    durationMs: options.durationMs,
    finalStatus: options.finalStatus,
    rawDeploymentStatus: options.rawDeploymentStatus,
    result: options.result,
    errorCategory: options.errorCategory,
  });
};

interface PublishingOperationEventOptions {
  operationId: string;
  exposureId?: string;
  result: PublishingAnalyticsResult;
  errorCategory?: PublishingAnalyticsErrorCategory;
  durationMs?: number;
  accessPermission?: string;
}

export interface ReportPublishingShareResultOptions extends PublishingOperationEventOptions {
  operationType: PublishingAnalyticsOperationType;
  shareId?: string;
}

export const reportPublishingShareResult = (
  attempt: PublishingAnalyticsAttemptContext,
  options: ReportPublishingShareResultOptions,
): void => {
  void reportYdAnalyzer({
    action: LogReporterAction.PublishShareResult,
    ...getAttemptParams(attempt),
    ...options,
  });
};

export interface ReportPublishingCopyShareLinkOptions extends PublishingOperationEventOptions {
  shareId: string;
}

export const reportPublishingCopyShareLink = (
  attempt: PublishingAnalyticsAttemptContext,
  options: ReportPublishingCopyShareLinkOptions,
): void => {
  void reportYdAnalyzer({
    action: LogReporterAction.PublishCopyShareLink,
    ...getAttemptParams(attempt),
    operationType: 'copy_link',
    ...options,
  });
};

export interface ReportPublishingDeploymentResultOptions extends PublishingOperationEventOptions {
  operationType: PublishingAnalyticsOperationType;
  eventPhase: PublishingAnalyticsDeploymentPhase;
  finalStatus: PublishingAnalyticsFinalStatus;
  siteId?: string;
  deploymentId?: string;
  rawDeploymentStatus?: string;
}

export const reportPublishingDeploymentResult = (
  attempt: PublishingAnalyticsAttemptContext,
  options: ReportPublishingDeploymentResultOptions,
): void => {
  void reportYdAnalyzer({
    action: LogReporterAction.PublishDeploymentResult,
    ...getAttemptParams(attempt),
    ...options,
    deployId: options.deploymentId,
  });
};

export interface ReportPublishingCopyDeployLinkOptions extends PublishingOperationEventOptions {
  siteId: string;
  deploymentId: string;
  finalStatus: PublishingAnalyticsFinalStatus;
  rawDeploymentStatus?: string;
}

export const reportPublishingCopyDeployLink = (
  attempt: PublishingAnalyticsAttemptContext,
  options: ReportPublishingCopyDeployLinkOptions,
): void => {
  void reportYdAnalyzer({
    action: LogReporterAction.PublishCopyDeployLink,
    ...getAttemptParams(attempt),
    operationType: 'copy_link',
    ...options,
    deployId: options.deploymentId,
  });
};

export const reportDeploymentDialogExposure = (
  context: PublishingAnalyticsDialogContext,
): void => {
  const action = context.dialogType === PublishingAnalyticsDialogType.DeploymentStatus
    ? LogReporterAction.DeploymentStatusExposure
    : LogReporterAction.DeploymentEditorExposure;
  void reportYdAnalyzer({
    action,
    actionType: 'exposure',
    ...getDialogParams(context),
  });
};

export const reportDeploymentDialogAction = (
  context: PublishingAnalyticsDialogContext,
  options: ReportPublishingDialogActionOptions,
): string => {
  const operationId = options.operationId ?? createPublishingAnalyticsOperationId();
  const action = context.dialogType === PublishingAnalyticsDialogType.DeploymentStatus
    ? LogReporterAction.DeploymentStatusAction
    : LogReporterAction.DeploymentEditorAction;
  void reportYdAnalyzer({
    action,
    ...getDialogParams(context),
    ...options,
    operationId,
    dialogVisibleMs: Math.max(0, Date.now() - context.openedAt),
  });
  return operationId;
};

export const getPublishingFeatureResourceKind = (
  feature: ArtifactSubscriptionFeatureValue,
): typeof PublishingResourceKind.File | typeof PublishingResourceKind.Site => (
  feature === ArtifactSubscriptionFeature.Share
    ? PublishingResourceKind.File
    : PublishingResourceKind.Site
);

export const getPublishingErrorCategory = (error: unknown): PublishingAnalyticsErrorCategory => {
  if (!error) return PublishingAnalyticsErrorCategory.Unknown;
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '').toLowerCase()
    : '';
  if (code.includes('quota') || code.includes('limit')) {
    return PublishingAnalyticsErrorCategory.Quota;
  }
  if (code.includes('subscription')) {
    return PublishingAnalyticsErrorCategory.Subscription;
  }
  return PublishingAnalyticsErrorCategory.NetworkOrServer;
};
