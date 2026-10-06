import {
  type ShareDeploymentRecord,
  ShareDeploymentStatus,
  type ShareDeploymentStatus as ShareDeploymentStatusValue,
} from '@shared/shareDeployment/constants';

import {
  type PublishingAnalyticsAttemptContext,
  PublishingAnalyticsDeploymentPhase,
  PublishingAnalyticsErrorCategory,
  type PublishingAnalyticsErrorCategory as PublishingAnalyticsErrorCategoryValue,
  PublishingAnalyticsFinalStatus,
  type PublishingAnalyticsFinalStatus as PublishingAnalyticsFinalStatusValue,
  type PublishingAnalyticsOperationType as PublishingAnalyticsOperationTypeValue,
  PublishingAnalyticsResult,
  type PublishingAnalyticsResult as PublishingAnalyticsResultValue,
  reportPublishingDeploymentResult,
  reportPublishingOperationResult,
} from './publishingAnalytics';

export interface DeploymentAnalyticsOperationContext {
  attempt: PublishingAnalyticsAttemptContext;
  operationId: string;
  operationType: PublishingAnalyticsOperationTypeValue;
  startedAt: number;
  exposureId?: string;
  accessPermission?: string;
  siteId?: string;
  deploymentId?: string;
}

export interface DeploymentAnalyticsTerminalOutcome {
  result: PublishingAnalyticsResultValue;
  finalStatus: PublishingAnalyticsFinalStatusValue;
  errorCategory?: PublishingAnalyticsErrorCategoryValue;
}

export const getDeploymentAnalyticsFinalStatus = (
  status?: ShareDeploymentStatusValue,
): PublishingAnalyticsFinalStatusValue => {
  switch (status) {
    case ShareDeploymentStatus.Live:
      return PublishingAnalyticsFinalStatus.Live;
    case ShareDeploymentStatus.DeployFailed:
      return PublishingAnalyticsFinalStatus.Failed;
    case ShareDeploymentStatus.Stopped:
      return PublishingAnalyticsFinalStatus.Stopped;
    case ShareDeploymentStatus.Expired:
      return PublishingAnalyticsFinalStatus.Expired;
    default:
      return PublishingAnalyticsFinalStatus.Publishing;
  }
};

export const getDeploymentAnalyticsTerminalOutcome = (
  status?: ShareDeploymentStatusValue,
): DeploymentAnalyticsTerminalOutcome | null => {
  switch (status) {
    case ShareDeploymentStatus.Live:
      return {
        result: PublishingAnalyticsResult.Success,
        finalStatus: PublishingAnalyticsFinalStatus.Live,
      };
    case ShareDeploymentStatus.Stopped:
      return {
        result: PublishingAnalyticsResult.Success,
        finalStatus: PublishingAnalyticsFinalStatus.Stopped,
      };
    case ShareDeploymentStatus.DeployFailed:
      return {
        result: PublishingAnalyticsResult.Failure,
        finalStatus: PublishingAnalyticsFinalStatus.Failed,
        errorCategory: PublishingAnalyticsErrorCategory.NetworkOrServer,
      };
    case ShareDeploymentStatus.Expired:
      return {
        result: PublishingAnalyticsResult.Failure,
        finalStatus: PublishingAnalyticsFinalStatus.Expired,
        errorCategory: PublishingAnalyticsErrorCategory.Unknown,
      };
    default:
      return null;
  }
};

const getCommonResultOptions = (
  context: DeploymentAnalyticsOperationContext,
  deployment?: ShareDeploymentRecord,
) => ({
  operationType: context.operationType,
  operationId: context.operationId,
  exposureId: context.exposureId,
  siteId: deployment?.shareId ?? context.siteId,
  deploymentId: deployment?.deploymentId ?? context.deploymentId,
  accessPermission: context.accessPermission,
  durationMs: Math.max(0, Date.now() - context.startedAt),
  rawDeploymentStatus: deployment?.status,
});

export const reportDeploymentAccepted = (
  context: DeploymentAnalyticsOperationContext,
  deployment: ShareDeploymentRecord,
): void => {
  const common = getCommonResultOptions(context, deployment);
  reportPublishingDeploymentResult(context.attempt, {
    ...common,
    eventPhase: PublishingAnalyticsDeploymentPhase.Accepted,
    finalStatus: PublishingAnalyticsFinalStatus.Publishing,
    result: PublishingAnalyticsResult.Success,
  });
  // Keep the original operation-result event during the v2 migration.
  reportPublishingOperationResult(context.attempt, {
    ...common,
    finalStatus: PublishingAnalyticsFinalStatus.Publishing,
    result: PublishingAnalyticsResult.Success,
  });
};

export const reportDeploymentTerminal = (
  context: DeploymentAnalyticsOperationContext,
  deployment: ShareDeploymentRecord,
): boolean => {
  const outcome = getDeploymentAnalyticsTerminalOutcome(deployment.status);
  if (!outcome) return false;
  reportPublishingDeploymentResult(context.attempt, {
    ...getCommonResultOptions(context, deployment),
    eventPhase: PublishingAnalyticsDeploymentPhase.Terminal,
    ...outcome,
  });
  return true;
};

export const reportDeploymentRejected = (
  context: DeploymentAnalyticsOperationContext,
  errorCategory: PublishingAnalyticsErrorCategoryValue,
  deployment?: ShareDeploymentRecord,
): void => {
  const common = getCommonResultOptions(context, deployment);
  reportPublishingDeploymentResult(context.attempt, {
    ...common,
    eventPhase: PublishingAnalyticsDeploymentPhase.Terminal,
    finalStatus: PublishingAnalyticsFinalStatus.Failed,
    result: PublishingAnalyticsResult.Failure,
    errorCategory,
  });
  // Keep the original operation-result event during the v2 migration.
  reportPublishingOperationResult(context.attempt, {
    ...common,
    finalStatus: PublishingAnalyticsFinalStatus.Failed,
    result: PublishingAnalyticsResult.Failure,
    errorCategory,
  });
};

export const reportDeploymentImmediateResult = (
  context: DeploymentAnalyticsOperationContext,
  deployment: ShareDeploymentRecord,
  result: PublishingAnalyticsResultValue,
  errorCategory?: PublishingAnalyticsErrorCategoryValue,
): void => {
  const common = getCommonResultOptions(context, deployment);
  const finalStatus = result === PublishingAnalyticsResult.Failure
    ? PublishingAnalyticsFinalStatus.Failed
    : getDeploymentAnalyticsFinalStatus(deployment.status);
  reportPublishingDeploymentResult(context.attempt, {
    ...common,
    eventPhase: PublishingAnalyticsDeploymentPhase.Terminal,
    finalStatus,
    result,
    errorCategory,
  });
  reportPublishingOperationResult(context.attempt, {
    ...common,
    finalStatus,
    result,
    errorCategory,
  });
};
