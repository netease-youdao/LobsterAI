import { HtmlShareAccessMode } from '@shared/htmlShare/constants';
import { PublishingResourceKind } from '@shared/publishing/constants';
import {
  type ShareDeploymentRecord,
  ShareDeploymentStatus,
} from '@shared/shareDeployment/constants';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ArtifactPreviewActionSource, ArtifactPublishEntryPoint } from './artifactAnalytics';
import { ArtifactSubscriptionFeature } from './artifactSubscriptionGate';
import {
  getDeploymentAnalyticsTerminalOutcome,
  reportDeploymentAccepted,
  reportDeploymentTerminal,
} from './deploymentAnalytics';
import {
  PublishingAnalyticsDeploymentPhase,
  PublishingAnalyticsFinalStatus,
  PublishingAnalyticsOperationType,
  PublishingAnalyticsResult,
  reportPublishingDeploymentResult,
  reportPublishingOperationResult,
} from './publishingAnalytics';

vi.mock('./publishingAnalytics', async () => {
  const actual = await vi.importActual<typeof import('./publishingAnalytics')>(
    './publishingAnalytics',
  );
  return {
    ...actual,
    reportPublishingDeploymentResult: vi.fn(),
    reportPublishingOperationResult: vi.fn(),
  };
});

const attempt = {
  attemptId: 'attempt-1',
  feature: ArtifactSubscriptionFeature.Deployment,
  resourceKind: PublishingResourceKind.Site,
  operationType: PublishingAnalyticsOperationType.Create,
  source: ArtifactPreviewActionSource.ArtifactPanel,
  entryPoint: ArtifactPublishEntryPoint.ArtifactToolbar,
  hasExistingResource: false,
};

const operation = {
  attempt,
  operationId: 'operation-1',
  operationType: PublishingAnalyticsOperationType.Create,
  startedAt: 1_000,
  exposureId: 'exposure-1',
  accessPermission: HtmlShareAccessMode.Code,
};

const deployment: ShareDeploymentRecord = {
  deploymentId: 'deployment-1',
  shareId: 'site-1',
  status: ShareDeploymentStatus.Deploying,
  accessMode: HtmlShareAccessMode.Code,
};

beforeEach(() => {
  vi.mocked(reportPublishingDeploymentResult).mockReset();
  vi.mocked(reportPublishingOperationResult).mockReset();
  vi.spyOn(Date, 'now').mockReturnValue(2_000);
});

describe('deployment analytics', () => {
  test('maps every terminal deployment status to a readable outcome', () => {
    expect(getDeploymentAnalyticsTerminalOutcome(ShareDeploymentStatus.Live)).toMatchObject({
      result: PublishingAnalyticsResult.Success,
      finalStatus: PublishingAnalyticsFinalStatus.Live,
    });
    expect(getDeploymentAnalyticsTerminalOutcome(ShareDeploymentStatus.DeployFailed)).toMatchObject({
      result: PublishingAnalyticsResult.Failure,
      finalStatus: PublishingAnalyticsFinalStatus.Failed,
    });
    expect(getDeploymentAnalyticsTerminalOutcome(ShareDeploymentStatus.Stopped)).toMatchObject({
      result: PublishingAnalyticsResult.Success,
      finalStatus: PublishingAnalyticsFinalStatus.Stopped,
    });
    expect(getDeploymentAnalyticsTerminalOutcome(ShareDeploymentStatus.Expired)).toMatchObject({
      result: PublishingAnalyticsResult.Failure,
      finalStatus: PublishingAnalyticsFinalStatus.Expired,
    });
    expect(getDeploymentAnalyticsTerminalOutcome(ShareDeploymentStatus.Deploying)).toBeNull();
  });

  test('keeps stable site and operation ids from acceptance through the terminal result', () => {
    reportDeploymentAccepted(operation, deployment);
    expect(reportPublishingDeploymentResult).toHaveBeenLastCalledWith(attempt, expect.objectContaining({
      eventPhase: PublishingAnalyticsDeploymentPhase.Accepted,
      finalStatus: PublishingAnalyticsFinalStatus.Publishing,
      operationId: 'operation-1',
      exposureId: 'exposure-1',
      siteId: 'site-1',
      deploymentId: 'deployment-1',
      durationMs: 1_000,
    }));
    expect(reportPublishingOperationResult).toHaveBeenCalledOnce();

    expect(reportDeploymentTerminal(operation, {
      ...deployment,
      status: ShareDeploymentStatus.Live,
    })).toBe(true);
    expect(reportPublishingDeploymentResult).toHaveBeenLastCalledWith(attempt, expect.objectContaining({
      eventPhase: PublishingAnalyticsDeploymentPhase.Terminal,
      finalStatus: PublishingAnalyticsFinalStatus.Live,
      operationId: 'operation-1',
      siteId: 'site-1',
      deploymentId: 'deployment-1',
      result: PublishingAnalyticsResult.Success,
    }));
    expect(reportPublishingOperationResult).toHaveBeenCalledOnce();
  });
});
