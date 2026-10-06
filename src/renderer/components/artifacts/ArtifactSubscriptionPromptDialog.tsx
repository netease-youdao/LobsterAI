import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import type { PublishingTrialPolicy } from '../../../shared/publishing/constants';
import {
  ArtifactSubscriptionBlockReason,
  ArtifactSubscriptionFeature,
  getArtifactSubscriptionPromptCopyKeys,
} from './artifactSubscriptionGate';
import {
  createPublishingAnalyticsDialog,
  getPublishingDialogTypeForSubscriptionReason,
  PublishingAnalyticsActionType,
  type PublishingAnalyticsAttemptContext,
  PublishingAnalyticsCtaId,
  PublishingAnalyticsTarget,
  reportPublishingDialogAction,
  reportPublishingDialogExposure,
} from './publishingAnalytics';
import PublishingRestrictionDialogShell from './PublishingRestrictionDialogShell';

interface ArtifactSubscriptionPromptDialogProps {
  feature: ArtifactSubscriptionFeature;
  reason: ArtifactSubscriptionBlockReason;
  onCancel: () => void;
  onLogin: () => void;
  onSubscribe: () => void;
  onLearnBenefits?: () => void;
  analyticsAttempt?: PublishingAnalyticsAttemptContext | null;
}

const ArtifactSubscriptionPromptDialog = ({
  feature,
  reason,
  onCancel,
  onLogin,
  onSubscribe,
  onLearnBenefits = onSubscribe,
  analyticsAttempt,
}: ArtifactSubscriptionPromptDialogProps) => {
  const initialButtonRef = useRef<HTMLButtonElement>(null);
  const openedAtRef = useRef(Date.now());
  const [trialPolicy, setTrialPolicy] = useState<PublishingTrialPolicy | null>(null);
  const [isTrialPolicyLoading, setIsTrialPolicyLoading] = useState(
    reason === ArtifactSubscriptionBlockReason.LoginRequired,
  );
  const titleId = useId();
  const descriptionId = useId();
  const copyKeys = getArtifactSubscriptionPromptCopyKeys(feature, reason);
  const isEnterpriseUnavailable =
    reason === ArtifactSubscriptionBlockReason.EnterpriseUnavailable;
  const isLoginRequired = reason === ArtifactSubscriptionBlockReason.LoginRequired;
  const resourcePolicy = feature === ArtifactSubscriptionFeature.Share
    ? trialPolicy?.file
    : trialPolicy?.site;
  const analyticsDialog = useMemo(() => (
    analyticsAttempt && (!isLoginRequired || !isTrialPolicyLoading)
      ? {
          ...createPublishingAnalyticsDialog(
            analyticsAttempt,
            getPublishingDialogTypeForSubscriptionReason(reason),
            undefined,
            resourcePolicy?.accessTtlSeconds,
          ),
          openedAt: openedAtRef.current,
        }
      : null
  ), [
    analyticsAttempt,
    isLoginRequired,
    isTrialPolicyLoading,
    reason,
    resourcePolicy?.accessTtlSeconds,
  ]);

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
    if (!isLoginRequired) return undefined;
    let active = true;
    setIsTrialPolicyLoading(true);
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
  }, [isLoginRequired]);

  const trialTitleKey = feature === ArtifactSubscriptionFeature.Share
    ? 'publishingTrialShareTitle'
    : 'publishingTrialSiteTitle';
  const trialFeatureLabel = i18nService.t(feature === ArtifactSubscriptionFeature.Share
    ? 'publishingTrialFeatureShare'
    : 'publishingTrialFeatureSite');
  const trialMessage = (() => {
    if (isTrialPolicyLoading) return i18nService.t('publishingTrialPolicyLoading');
    if (!resourcePolicy) {
      return i18nService.t(isLoginRequired
        ? 'publishingTrialLoginFallbackMessage'
        : 'publishingTrialLimitFallbackMessage');
    }
    return i18nService.t('publishingTrialLoginMessage')
      .replace('{feature}', trialFeatureLabel)
      .replace('{limit}', String(resourcePolicy.limit));
  })();

  return (
    <PublishingRestrictionDialogShell
      titleId={titleId}
      descriptionId={descriptionId}
      onClose={handleClose}
      initialFocusRef={initialButtonRef}
      maxWidthClassName={!isLoginRequired ? 'max-w-[420px]' : 'max-w-[448px]'}
      overlayClassName="fixed inset-0 z-[10000] flex items-center justify-center bg-black/35 p-4"
    >
      <div className={!isLoginRequired ? 'p-6' : 'px-8 py-9'}>
        {!isLoginRequired ? (
          <>
            <h2 id={titleId} className="pr-10 text-sm font-semibold text-foreground">
              {i18nService.t(copyKeys.titleKey)}
            </h2>
            <div
              id={descriptionId}
              className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-secondary"
            >
              {i18nService.t(copyKeys.messageKey)}
            </div>
            <div className="mt-4 flex justify-end">
              <button
                ref={initialButtonRef}
                type="button"
                onClick={handleClose}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-secondary transition-colors hover:bg-surface hover:text-foreground"
              >
                {i18nService.t('cancel')}
              </button>
              {!isEnterpriseUnavailable && (
                <button
                  type="button"
                  onClick={() => {
                    reportAction(
                      PublishingAnalyticsActionType.Click,
                      PublishingAnalyticsCtaId.Primary,
                      PublishingAnalyticsTarget.Pricing,
                    );
                    onSubscribe();
                  }}
                  className="ml-2 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  {i18nService.t('subscriptionGateOpenAction')}
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <h2 id={titleId} className="px-8 text-center text-lg font-semibold text-foreground">
              {i18nService.t(trialTitleKey)}
            </h2>
            <div
              id={descriptionId}
              className="mt-5 break-words text-center text-sm leading-6 text-foreground"
              aria-live="polite"
            >
              {trialMessage}
            </div>
            <div className="mt-8 flex flex-col items-stretch gap-3">
              <button
                ref={initialButtonRef}
                type="button"
                onClick={() => {
                  reportAction(
                    PublishingAnalyticsActionType.Click,
                    PublishingAnalyticsCtaId.Primary,
                    PublishingAnalyticsTarget.Login,
                  );
                  onLogin();
                }}
                className="h-11 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                {i18nService.t('publishingTrialLoginAction')}
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
                {i18nService.t('publishingTrialLearnBenefits')}
              </button>
            </div>
          </>
        )}
      </div>
    </PublishingRestrictionDialogShell>
  );
};

export default ArtifactSubscriptionPromptDialog;
