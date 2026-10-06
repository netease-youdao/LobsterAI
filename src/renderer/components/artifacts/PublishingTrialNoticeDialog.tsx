import {
  type PublishingQuotaErrorData,
  type PublishingTrialPolicy,
} from '@shared/publishing/constants';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import {
  ArtifactSubscriptionFeature,
  type ArtifactSubscriptionFeature as ArtifactSubscriptionFeatureValue,
} from './artifactSubscriptionGate';
import {
  createPublishingAnalyticsDialog,
  PublishingAnalyticsActionType,
  type PublishingAnalyticsAttemptContext,
  PublishingAnalyticsCtaId,
  PublishingAnalyticsDialogType,
  PublishingAnalyticsTarget,
  reportPublishingDialogAction,
  reportPublishingDialogExposure,
} from './publishingAnalytics';
import PublishingRestrictionDialogShell from './PublishingRestrictionDialogShell';

interface PublishingTrialNoticeDialogProps {
  feature: ArtifactSubscriptionFeatureValue;
  quota: PublishingQuotaErrorData;
  onCancel: () => void;
  onContinue: () => void;
  onSubscribe: () => void;
  analyticsAttempt?: PublishingAnalyticsAttemptContext | null;
}

const t = (key: string): string => i18nService.t(key);

export const formatPublishingTrialDuration = (accessTtlSeconds: number): string => {
  const totalMinutes = Math.max(1, Math.round(accessTtlSeconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes === 0) {
    return t('publishingTrialDurationHours').replace('{hours}', String(hours));
  }
  if (hours > 0) {
    return t('publishingTrialDurationHoursMinutes')
      .replace('{hours}', String(hours))
      .replace('{minutes}', String(minutes));
  }
  return t('publishingTrialDurationMinutes').replace('{minutes}', String(totalMinutes));
};

const PublishingTrialNoticeDialog: React.FC<PublishingTrialNoticeDialogProps> = ({
  feature,
  quota,
  onCancel,
  onContinue,
  onSubscribe,
  analyticsAttempt,
}) => {
  const titleId = useId();
  const descriptionId = useId();
  const initialButtonRef = useRef<HTMLButtonElement>(null);
  const openedAtRef = useRef(Date.now());
  const [trialPolicy, setTrialPolicy] = useState<PublishingTrialPolicy | null>(null);
  const [isTrialPolicyLoading, setIsTrialPolicyLoading] = useState(true);
  const isShare = feature === ArtifactSubscriptionFeature.Share;
  const resourcePolicy = isShare ? trialPolicy?.file : trialPolicy?.site;
  const analyticsDialog = useMemo(() => (
    analyticsAttempt && !isTrialPolicyLoading
      ? {
          ...createPublishingAnalyticsDialog(
            analyticsAttempt,
            PublishingAnalyticsDialogType.TrialNotice,
            quota,
            resourcePolicy?.accessTtlSeconds,
          ),
          openedAt: openedAtRef.current,
        }
      : null
  ), [analyticsAttempt, isTrialPolicyLoading, quota, resourcePolicy?.accessTtlSeconds]);

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
    onCancel();
  }, [onCancel, reportAction]);

  useEffect(() => {
    let active = true;
    const request = window.electron?.htmlShare?.getTrialPolicy();
    if (!request) {
      setIsTrialPolicyLoading(false);
      return undefined;
    }
    void request
      .then(result => {
        if (active) setTrialPolicy(result?.success && result.data ? result.data : null);
      })
      .catch(() => {
        if (active) setTrialPolicy(null);
      })
      .finally(() => {
        if (active) setIsTrialPolicyLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const featureLabel = t(isShare
    ? 'publishingTrialFeatureShare'
    : 'publishingTrialFeatureSite');
  const resourceLabel = t(isShare
    ? 'publishingTrialResourceShareLink'
    : 'publishingTrialResourceWebsite');
  const message = isTrialPolicyLoading
    ? t('publishingTrialPolicyLoading')
    : resourcePolicy
      ? t('publishingTrialNoticeMessage')
          .replace('{feature}', featureLabel)
          .replace('{limit}', String(quota.limit))
          .replace('{resource}', resourceLabel)
          .replace('{duration}', formatPublishingTrialDuration(resourcePolicy.accessTtlSeconds))
      : t('publishingTrialNoticeFallbackMessage')
          .replace('{feature}', featureLabel)
          .replace('{limit}', String(quota.limit));
  const usageAfterCreate = Math.min(quota.limit, quota.used + 1);

  return (
    <PublishingRestrictionDialogShell
      titleId={titleId}
      descriptionId={descriptionId}
      onClose={handleClose}
      initialFocusRef={initialButtonRef}
      maxWidthClassName="max-w-[448px]"
    >
      <div className="px-8 py-9">
        <div className="flex items-center justify-center gap-2 px-8">
          <h2 id={titleId} className="text-center text-lg font-semibold text-foreground">
            {t(isShare ? 'publishingTrialShareTitle' : 'publishingTrialSiteTitle')}
          </h2>
          <span className="rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-600 dark:bg-amber-500/10 dark:text-amber-300">
            {t('publishingTrialBadge')}
          </span>
        </div>
        <p
          id={descriptionId}
          className="mt-5 whitespace-pre-wrap break-words text-center text-sm leading-6 text-foreground"
          aria-live="polite"
        >
          {message}
        </p>
        <div className="mt-5 flex items-center justify-between rounded-xl bg-surface px-4 py-3 text-sm">
          <span className="text-secondary">{t('publishingTrialUsageAfterCreate')}</span>
          <span className="font-medium tabular-nums text-foreground">
            {t('publishingQuotaUsageValue')
              .replace('{used}', String(usageAfterCreate))
              .replace('{limit}', String(quota.limit))}
          </span>
        </div>
        <div className="mt-8 flex flex-col items-stretch gap-3">
          <button
            ref={initialButtonRef}
            type="button"
            onClick={() => {
              reportAction(
                PublishingAnalyticsActionType.Click,
                PublishingAnalyticsCtaId.Primary,
                PublishingAnalyticsTarget.Continue,
              );
              onContinue();
            }}
            disabled={isTrialPolicyLoading}
            aria-busy={isTrialPolicyLoading}
            className="h-11 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-wait disabled:opacity-60"
          >
            {t(isShare ? 'publishingTrialContinueShare' : 'publishingTrialContinueSite')}
          </button>
          <button
            type="button"
            onClick={() => {
              reportAction(
                PublishingAnalyticsActionType.Click,
                PublishingAnalyticsCtaId.Secondary,
                PublishingAnalyticsTarget.LearnBenefits,
              );
              onSubscribe();
            }}
            className="self-center text-sm text-muted transition-colors hover:text-foreground"
          >
            {t('publishingTrialLearnBenefits')}
          </button>
        </div>
      </div>
    </PublishingRestrictionDialogShell>
  );
};

export default PublishingTrialNoticeDialog;
