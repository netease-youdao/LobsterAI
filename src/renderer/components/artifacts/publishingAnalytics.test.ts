import {
  PublishingRecoveryAnalyticsOutcome,
  PublishingRecoveryAnalyticsSurface,
} from '@shared/analytics/constants';
import {
  PublishingCountMode,
  PublishingIdentityType,
  PublishingResourceKind,
  PublishingSubscriptionRecoveryMode,
} from '@shared/publishing/constants';
import { describe, expect, test, vi } from 'vitest';

import { defaultConfig } from '@/config';
import { configService } from '@/services/config';
import { LogReporterAction, reportYdAnalyzer } from '@/services/logReporter';
import { rememberPublishingConversionAttribution } from '@/services/publishingConversionAttribution';

import { ArtifactPreviewActionSource, ArtifactPublishEntryPoint } from './artifactAnalytics';
import { ArtifactSubscriptionFeature } from './artifactSubscriptionGate';
import {
  clearPublishingRecoveryAnalyticsState,
  createPublishingAnalyticsAttempt,
  createPublishingAnalyticsDialog,
  createPublishingRecoveryAnalyticsContext,
  createPublishingRecoveryAnalyticsContextFromAttempt,
  PublishingAnalyticsActionType,
  PublishingAnalyticsCtaId,
  PublishingAnalyticsDeploymentPhase,
  PublishingAnalyticsDialogType,
  PublishingAnalyticsFinalStatus,
  PublishingAnalyticsOperationType,
  PublishingAnalyticsResult,
  PublishingAnalyticsTarget,
  PublishingRecoveryAnalyticsEventVersion,
  reportPublishingDeploymentResult,
  reportPublishingDialogAction,
  reportPublishingDialogExposure,
  reportPublishingRecoveryCtaAction,
  reportPublishingRecoveryCtaExposure,
  reportPublishingRecoveryResult,
  resetPublishingRecoveryCtaExposure,
} from './publishingAnalytics';

vi.mock('@/services/logReporter', async () => {
  const actual = await vi.importActual<typeof import('@/services/logReporter')>(
    '@/services/logReporter',
  );
  return { ...actual, reportYdAnalyzer: vi.fn() };
});

vi.mock('@/services/config', () => ({
  configService: {
    getConfig: vi.fn(() => ({ usageAnalyticsEnabled: true })),
  },
}));

vi.mock('@/services/publishingConversionAttribution', () => ({
  rememberPublishingConversionAttribution: vi.fn(),
}));

describe('publishing analytics', () => {
  test('keeps an attempt id across exposure and click without private resource data', () => {
    vi.mocked(reportYdAnalyzer).mockClear();
    const attempt = createPublishingAnalyticsAttempt({
      feature: ArtifactSubscriptionFeature.Share,
      resourceKind: PublishingResourceKind.File,
      operationType: PublishingAnalyticsOperationType.Create,
      source: ArtifactPreviewActionSource.LibraryList,
      entryPoint: ArtifactPublishEntryPoint.LibraryMenu,
      surface: 'my_files',
      pageViewId: 'page-view-1',
      hasExistingResource: false,
    });
    const dialog = createPublishingAnalyticsDialog(
      attempt,
      PublishingAnalyticsDialogType.TrialNotice,
      {
        resourceKind: PublishingResourceKind.File,
        identityType: PublishingIdentityType.Free,
        countMode: PublishingCountMode.Total,
        used: 2,
        limit: 10,
        canReleaseByClosing: false,
      },
      7200,
    );

    reportPublishingDialogExposure(dialog);
    reportPublishingDialogAction(dialog, {
      actionType: PublishingAnalyticsActionType.Click,
      ctaId: PublishingAnalyticsCtaId.Primary,
      target: PublishingAnalyticsTarget.Continue,
    });

    const calls = vi.mocked(reportYdAnalyzer).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toMatchObject({
      attemptId: attempt.attemptId,
      exposureId: dialog.exposureId,
      surface: 'my_files',
      pageViewId: 'page-view-1',
      quotaUsed: 2,
      quotaLimit: 10,
      trialAccessTtlSeconds: 7200,
    });
    expect(calls[1][0]).toMatchObject({
      attemptId: attempt.attemptId,
      exposureId: dialog.exposureId,
      operationId: expect.any(String),
      target: PublishingAnalyticsTarget.Continue,
      dialogVisibleMs: expect.any(Number),
    });
    expect(JSON.stringify(calls)).not.toContain('filePath');
    expect(JSON.stringify(calls)).not.toContain('shareCode');
  });

  test('reports both readable deployment id names during schema migration', () => {
    vi.mocked(reportYdAnalyzer).mockClear();
    const attempt = createPublishingAnalyticsAttempt({
      feature: ArtifactSubscriptionFeature.Deployment,
      resourceKind: PublishingResourceKind.Site,
      operationType: PublishingAnalyticsOperationType.Create,
      source: ArtifactPreviewActionSource.ArtifactPanel,
      entryPoint: ArtifactPublishEntryPoint.ArtifactToolbar,
      hasExistingResource: false,
    });

    reportPublishingDeploymentResult(attempt, {
      operationId: 'operation-1',
      operationType: PublishingAnalyticsOperationType.Create,
      eventPhase: PublishingAnalyticsDeploymentPhase.Accepted,
      finalStatus: PublishingAnalyticsFinalStatus.Publishing,
      siteId: 'site-1',
      deploymentId: 'deployment-1',
      result: PublishingAnalyticsResult.Success,
    });

    expect(reportYdAnalyzer).toHaveBeenCalledWith(expect.objectContaining({
      siteId: 'site-1',
      deploymentId: 'deployment-1',
      deployId: 'deployment-1',
    }));
  });

  test('reports a recovery exposure and click with a v1 privacy allowlist', () => {
    vi.mocked(reportYdAnalyzer).mockClear();
    vi.mocked(rememberPublishingConversionAttribution).mockClear();
    clearPublishingRecoveryAnalyticsState();
    const attempt = createPublishingAnalyticsAttempt({
      feature: ArtifactSubscriptionFeature.Share,
      resourceKind: PublishingResourceKind.File,
      operationType: PublishingAnalyticsOperationType.Manage,
      source: ArtifactPreviewActionSource.ArtifactPanel,
      entryPoint: ArtifactPublishEntryPoint.ArtifactToolbar,
      surface: 'task_artifact',
      pageViewId: 'page-view-1',
      hasExistingResource: true,
    });
    const originalAttempt = { ...attempt };
    const context = createPublishingRecoveryAnalyticsContextFromAttempt(attempt, {
      ownerAccountKey: 'personal:user-1',
      resourceKey: 'local-share:share-1',
      recoverySurface: PublishingRecoveryAnalyticsSurface.TaskFileShareDialog,
      subscriptionRecoveryMode: PublishingSubscriptionRecoveryMode.Automatic,
    }, 1_000);

    expect(reportPublishingRecoveryCtaExposure(context, 1_000)).toBe(true);
    expect(reportPublishingRecoveryCtaExposure(context, 1_200)).toBe(false);
    const operationId = reportPublishingRecoveryCtaAction(context, { now: 1_750 });

    expect(attempt).toEqual(originalAttempt);
    expect(context.attemptId).toBe(attempt.attemptId);
    expect(operationId).toEqual(expect.any(String));
    const calls = vi.mocked(reportYdAnalyzer).mock.calls.map(([payload]) => payload);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      action: LogReporterAction.PublishingRecoveryCtaExposure,
      eventVersion: PublishingRecoveryAnalyticsEventVersion,
      attemptId: attempt.attemptId,
      exposureId: context.exposureId,
      operationType: PublishingAnalyticsOperationType.SubscriptionRecovery,
      recoverySurface: PublishingRecoveryAnalyticsSurface.TaskFileShareDialog,
      subscriptionRecoveryMode: PublishingSubscriptionRecoveryMode.Automatic,
      identityType: PublishingIdentityType.Free,
      hasExistingResource: true,
    });
    expect(calls[1]).toMatchObject({
      action: LogReporterAction.PublishingRecoveryCtaAction,
      attemptId: attempt.attemptId,
      operationId,
      ctaId: PublishingAnalyticsCtaId.Primary,
      target: PublishingAnalyticsTarget.Pricing,
      exposureToClickMs: 750,
    });
    calls.forEach(payload => {
      expect(payload).not.toHaveProperty('ownerAccountKey');
      expect(payload).not.toHaveProperty('resourceKey');
    });
    expect(rememberPublishingConversionAttribution).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerAccountKey: 'personal:user-1',
        resourceKey: 'local-share:share-1',
        operationId,
        identityType: PublishingIdentityType.Free,
      }),
      1_750,
    );
  });

  test('allows a new exposure after the CTA is explicitly hidden', () => {
    vi.mocked(reportYdAnalyzer).mockClear();
    clearPublishingRecoveryAnalyticsState();
    const context = createPublishingRecoveryAnalyticsContext({
      ownerAccountKey: 'personal:user-1',
      resourceKey: 'local-share:share-1',
      feature: ArtifactSubscriptionFeature.Share,
      resourceKind: PublishingResourceKind.File,
      source: ArtifactPreviewActionSource.LibraryList,
      entryPoint: ArtifactPublishEntryPoint.SubscriptionRecoveryCta,
      recoverySurface: PublishingRecoveryAnalyticsSurface.LibraryCloudList,
      subscriptionRecoveryMode: PublishingSubscriptionRecoveryMode.Automatic,
      pageViewId: 'library-page-1',
    }, 1_000);

    expect(reportPublishingRecoveryCtaExposure(context, 1_000)).toBe(true);
    const originalExposureId = context.exposureId;
    expect(reportPublishingRecoveryCtaExposure(context, 1_100)).toBe(false);
    resetPublishingRecoveryCtaExposure(context, 2_000);
    expect(context.exposureId).not.toBe(originalExposureId);
    expect(reportPublishingRecoveryCtaExposure(context, 2_000)).toBe(true);
  });

  test('reuses canonical exposure correlation after a virtualized row remount', () => {
    vi.mocked(reportYdAnalyzer).mockClear();
    vi.mocked(rememberPublishingConversionAttribution).mockClear();
    clearPublishingRecoveryAnalyticsState();
    const input = {
      ownerAccountKey: 'personal:user-1',
      resourceKey: 'local-share:share-1',
      feature: ArtifactSubscriptionFeature.Share,
      resourceKind: PublishingResourceKind.File,
      source: ArtifactPreviewActionSource.LibraryList,
      entryPoint: ArtifactPublishEntryPoint.SubscriptionRecoveryCta,
      recoverySurface: PublishingRecoveryAnalyticsSurface.LibraryCloudList,
      subscriptionRecoveryMode: PublishingSubscriptionRecoveryMode.Automatic,
      pageViewId: 'library-page-1',
    } as const;
    const firstContext = createPublishingRecoveryAnalyticsContext(input, 1_000);
    const remountedContext = createPublishingRecoveryAnalyticsContext(input, 5_000);

    expect(reportPublishingRecoveryCtaExposure(firstContext, 1_000)).toBe(true);
    expect(reportPublishingRecoveryCtaExposure(remountedContext, 5_000)).toBe(false);
    expect(remountedContext.exposureId).toBe(firstContext.exposureId);
    reportPublishingRecoveryCtaAction(remountedContext, { now: 6_000 });

    expect(rememberPublishingConversionAttribution).toHaveBeenCalledWith(
      expect.objectContaining({
        exposureId: firstContext.exposureId,
        exposureToClickMs: 5_000,
      }),
      6_000,
    );
  });

  test('correlates a terminal recovery result with only the latest click', async () => {
    vi.mocked(reportYdAnalyzer).mockReset().mockResolvedValue(true);
    clearPublishingRecoveryAnalyticsState();
    const context = createPublishingRecoveryAnalyticsContext({
      ownerAccountKey: 'personal:user-1',
      resourceKey: 'local-site:site-1',
      feature: ArtifactSubscriptionFeature.Deployment,
      resourceKind: PublishingResourceKind.Site,
      source: ArtifactPreviewActionSource.LibraryPreview,
      entryPoint: ArtifactPublishEntryPoint.LibrarySettings,
      recoverySurface: PublishingRecoveryAnalyticsSurface.LibrarySiteDetail,
      subscriptionRecoveryMode: PublishingSubscriptionRecoveryMode.RedeployRequired,
    }, 1_000);
    reportPublishingRecoveryCtaAction(context, { operationId: 'operation-old', now: 1_100 });
    reportPublishingRecoveryCtaAction(context, { operationId: 'operation-new', now: 1_500 });

    await expect(reportPublishingRecoveryResult({
      ownerAccountKey: 'personal:user-1',
      resourceKey: 'local-site:site-1',
      outcome: PublishingRecoveryAnalyticsOutcome.RedeployReady,
      now: 2_000,
    })).resolves.toBe(true);

    const resultPayloads = vi.mocked(reportYdAnalyzer).mock.calls
      .map(([payload]) => payload)
      .filter(payload => payload.action === LogReporterAction.PublishingRecoveryResult);
    expect(resultPayloads).toEqual([expect.objectContaining({
      operationId: 'operation-new',
      outcome: PublishingRecoveryAnalyticsOutcome.RedeployReady,
      durationMs: 500,
    })]);
    expect(resultPayloads[0]).not.toHaveProperty('ownerAccountKey');
    expect(resultPayloads[0]).not.toHaveProperty('resourceKey');
    await expect(reportPublishingRecoveryResult({
      ownerAccountKey: 'personal:user-1',
      resourceKey: 'local-site:site-1',
      outcome: PublishingRecoveryAnalyticsOutcome.RedeployReady,
      now: 2_100,
    })).resolves.toBe(false);
  });

  test('retains terminal result correlation after delivery failure', async () => {
    vi.mocked(reportYdAnalyzer).mockReset().mockResolvedValue(true);
    clearPublishingRecoveryAnalyticsState();
    const context = createPublishingRecoveryAnalyticsContext({
      ownerAccountKey: 'personal:user-1',
      resourceKey: 'local-share:share-1',
      feature: ArtifactSubscriptionFeature.Share,
      resourceKind: PublishingResourceKind.File,
      source: ArtifactPreviewActionSource.LibraryPreview,
      entryPoint: ArtifactPublishEntryPoint.LibrarySettings,
      recoverySurface: PublishingRecoveryAnalyticsSurface.LibraryFileDetail,
      subscriptionRecoveryMode: PublishingSubscriptionRecoveryMode.Automatic,
    }, 1_000);
    reportPublishingRecoveryCtaAction(context, { operationId: 'operation-1', now: 1_100 });
    vi.mocked(reportYdAnalyzer).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(reportPublishingRecoveryResult({
      ownerAccountKey: 'personal:user-1',
      resourceKey: 'local-share:share-1',
      outcome: PublishingRecoveryAnalyticsOutcome.Restored,
      now: 2_000,
    })).resolves.toBe(false);
    await expect(reportPublishingRecoveryResult({
      ownerAccountKey: 'personal:user-1',
      resourceKey: 'local-share:share-1',
      outcome: PublishingRecoveryAnalyticsOutcome.Restored,
      now: 2_500,
    })).resolves.toBe(true);

    const resultCalls = vi.mocked(reportYdAnalyzer).mock.calls.filter(
      ([payload]) => payload.action === LogReporterAction.PublishingRecoveryResult,
    );
    expect(resultCalls).toHaveLength(2);
    expect(resultCalls[0][0].operationId).toBe('operation-1');
    expect(resultCalls[1][0].operationId).toBe('operation-1');
  });

  test('does not remember recovery state when usage analytics is disabled', () => {
    vi.mocked(reportYdAnalyzer).mockClear();
    vi.mocked(rememberPublishingConversionAttribution).mockClear();
    vi.mocked(configService.getConfig).mockReturnValue({
      ...defaultConfig,
      usageAnalyticsEnabled: false,
    });
    clearPublishingRecoveryAnalyticsState();
    const context = createPublishingRecoveryAnalyticsContext({
      ownerAccountKey: 'personal:user-1',
      resourceKey: 'local-share:share-1',
      feature: ArtifactSubscriptionFeature.Share,
      resourceKind: PublishingResourceKind.File,
      source: ArtifactPreviewActionSource.LibraryPreview,
      entryPoint: ArtifactPublishEntryPoint.LibrarySettings,
      recoverySurface: PublishingRecoveryAnalyticsSurface.LibraryFileDetail,
      subscriptionRecoveryMode: PublishingSubscriptionRecoveryMode.Automatic,
    });

    expect(reportPublishingRecoveryCtaExposure(context)).toBe(false);
    reportPublishingRecoveryCtaAction(context);

    expect(rememberPublishingConversionAttribution).not.toHaveBeenCalled();
    expect(reportYdAnalyzer).toHaveBeenCalledOnce();
    vi.mocked(configService.getConfig).mockReturnValue({
      ...defaultConfig,
      usageAnalyticsEnabled: true,
    });
  });
});
