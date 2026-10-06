import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import {
  PublishingCountMode,
  PublishingIdentityType,
  type PublishingQuotaErrorData,
  PublishingResourceKind,
} from '@shared/publishing/constants';
import React, { useCallback, useEffect, useId, useMemo, useRef } from 'react';

import { i18nService } from '@/services/i18n';

import {
  createPublishingAnalyticsDialog,
  getPublishingDialogTypeForQuota,
  PublishingAnalyticsActionType,
  type PublishingAnalyticsAttemptContext,
  PublishingAnalyticsCtaId,
  PublishingAnalyticsTarget,
  reportPublishingDialogAction,
  reportPublishingDialogExposure,
} from './publishingAnalytics';
import PublishingRestrictionDialogShell from './PublishingRestrictionDialogShell';

interface PublishingQuotaLimitDialogProps {
  quota: PublishingQuotaErrorData;
  onClose: () => void;
  onManage: () => void;
  onSubscribe: () => void;
  onLearnBenefits?: () => void;
  analyticsAttempt?: PublishingAnalyticsAttemptContext | null;
}

const t = (key: string): string => i18nService.t(key);

const PublishingQuotaLimitDialog: React.FC<PublishingQuotaLimitDialogProps> = ({
  quota,
  onClose,
  onManage,
  onSubscribe,
  onLearnBenefits = onSubscribe,
  analyticsAttempt,
}) => {
  const titleId = useId();
  const descriptionId = useId();
  const initialButtonRef = useRef<HTMLButtonElement>(null);
  const isFile = quota.resourceKind === PublishingResourceKind.File;
  const isFreeTrialLimit = quota.identityType === PublishingIdentityType.Free;
  const resourceLabel = t(isFile ? 'publishingQuotaResourceFile' : 'publishingQuotaResourceSite');
  const isHistoricalTotal = quota.countMode === PublishingCountMode.Total
    || !quota.canReleaseByClosing;
  const messageKey = isHistoricalTotal
    ? 'publishingQuotaTotalMessage'
    : 'publishingQuotaActiveMessage';
  const message = t(messageKey)
    .replace(/\{resource\}/g, resourceLabel)
    .replace(/\{limit\}/g, String(quota.limit));
  const analyticsDialog = useMemo(() => (
    analyticsAttempt
      ? createPublishingAnalyticsDialog(
          analyticsAttempt,
          getPublishingDialogTypeForQuota(quota),
          quota,
        )
      : null
  ), [analyticsAttempt, quota]);

  useEffect(() => {
    if (analyticsDialog) reportPublishingDialogExposure(analyticsDialog);
  }, [analyticsDialog]);

  const reportAction = useCallback((
    actionType: PublishingAnalyticsActionType,
    ctaId: PublishingAnalyticsCtaId,
    target: PublishingAnalyticsTarget,
  ) => {
    if (analyticsDialog) {
      reportPublishingDialogAction(analyticsDialog, { actionType, ctaId, target });
    }
  }, [analyticsDialog]);

  const handleClose = useCallback(() => {
    reportAction(
      PublishingAnalyticsActionType.Close,
      PublishingAnalyticsCtaId.Close,
      PublishingAnalyticsTarget.Dismiss,
    );
    onClose();
  }, [onClose, reportAction]);

  if (isFreeTrialLimit) {
    const trialFeatureLabel = t(isFile
      ? 'publishingTrialFeatureShare'
      : 'publishingTrialFeatureSite');
    const trialMessage = t('publishingTrialLimitReachedMessage')
      .replace('{feature}', trialFeatureLabel)
      .replace(/\{limit\}/g, String(quota.limit));
    return (
      <PublishingRestrictionDialogShell
        titleId={titleId}
        descriptionId={descriptionId}
        onClose={handleClose}
        initialFocusRef={initialButtonRef}
      >
        <div className="px-8 py-9">
          <h2
            id={titleId}
            className="px-8 text-center text-lg font-semibold text-foreground"
          >
            {t(isFile ? 'publishingTrialShareTitle' : 'publishingTrialSiteTitle')}
          </h2>
          <p id={descriptionId} className="mt-5 text-center text-sm leading-6 text-foreground">
            {trialMessage}
          </p>
          <div className="mt-8 flex flex-col items-stretch gap-3">
            <button
              ref={initialButtonRef}
              type="button"
              onClick={() => {
                reportAction(
                  PublishingAnalyticsActionType.Click,
                  PublishingAnalyticsCtaId.Primary,
                  PublishingAnalyticsTarget.Pricing,
                );
                onSubscribe();
              }}
              className="h-11 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t('subscriptionGateOpenAction')}
            </button>
            <button
              type="button"
              onClick={() => {
                reportAction(
                  PublishingAnalyticsActionType.Click,
                  PublishingAnalyticsCtaId.Secondary,
                  PublishingAnalyticsTarget.LearnBenefits,
                );
                onLearnBenefits();
              }}
              className="self-center text-sm text-muted transition-colors hover:text-foreground"
            >
              {t('publishingTrialLearnBenefits')}
            </button>
          </div>
        </div>
      </PublishingRestrictionDialogShell>
    );
  }

  return (
    <PublishingRestrictionDialogShell
      titleId={titleId}
      descriptionId={descriptionId}
      onClose={handleClose}
      initialFocusRef={initialButtonRef}
      maxWidthClassName="max-w-[480px]"
    >
      <div className="p-6">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300">
            <ExclamationTriangleIcon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="pr-10 text-lg font-semibold text-foreground">
              {t(isFile ? 'publishingQuotaFileTitle' : 'publishingQuotaSiteTitle')}
            </h2>
            <p id={descriptionId} className="mt-2 text-sm leading-6 text-secondary">{message}</p>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between rounded-xl bg-surface px-4 py-3 text-sm">
          <span className="text-secondary">{t('publishingQuotaUsage')}</span>
          <span className="font-medium text-foreground">
            {t('publishingQuotaUsageValue')
              .replace('{used}', String(quota.used))
              .replace('{limit}', String(quota.limit))}
          </span>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={handleClose}
            className="h-9 rounded-lg border border-border px-4 text-sm text-secondary hover:bg-surface"
          >
            {t('cancel')}
          </button>
          <button
            ref={initialButtonRef}
            type="button"
            onClick={() => {
              reportAction(
                PublishingAnalyticsActionType.Click,
                PublishingAnalyticsCtaId.Primary,
                PublishingAnalyticsTarget.ManageCloud,
              );
              onManage();
            }}
            className="h-9 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t('publishingQuotaManage')}
          </button>
        </div>
      </div>
    </PublishingRestrictionDialogShell>
  );
};

export default PublishingQuotaLimitDialog;
