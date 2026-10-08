import { PublishingRecoveryAnalyticsSurface } from '@shared/analytics/constants';
import {
  HtmlShareAccessMode,
  type HtmlShareAccessMode as HtmlShareAccessModeValue,
  HtmlShareDisabledSource,
  type HtmlShareDisabledSource as HtmlShareDisabledSourceValue,
  HtmlShareErrorCode,
  type HtmlShareFailureDescriptor,
  HtmlShareFailureKind,
  HtmlShareStatus,
  type HtmlShareStatus as HtmlShareStatusValue,
} from '@shared/htmlShare/constants';
import { LibraryNavigationEvent } from '@shared/library/constants';
import {
  type PublishingQuotaErrorData,
  PublishingResourceKind,
  PublishingSubscriptionRecoveryMode,
  type PublishingSubscriptionRecoveryMode as PublishingSubscriptionRecoveryModeValue,
} from '@shared/publishing/constants';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useSelector } from 'react-redux';

import { authService } from '@/services/auth';
import { copyTextToClipboard } from '@/services/clipboard';
import { getPortalPricingUrl, PortalPricingKeyfrom } from '@/services/endpoints';
import { i18nService } from '@/services/i18n';
import {
  armPublishingSubscriptionRecovery,
  PublishingSubscriptionRecoveryRefreshOutcome,
  registerPublishingSubscriptionRecoveryTarget,
  resolvePublishingSubscriptionRecoveryRefreshOutcome,
} from '@/services/publishingSubscriptionRecovery';
import type { RootState } from '@/store';
import type { Artifact } from '@/types/artifact';

import {
  type ArtifactPreviewActionSource as ArtifactPreviewActionSourceValue,
  type ArtifactPublishEntryPoint as ArtifactPublishEntryPointValue,
  reportArtifactPreviewAction,
} from './artifactAnalytics';
import { buildArtifactFileShareCopyText } from './artifactFileShareCopy';
import {
  ArtifactFileShareCopyStatus,
  ArtifactFileShareOperation,
  ArtifactFileSharePhase,
  ArtifactFileShareUpdateStatus,
} from './ArtifactFileShareDialog';
import ArtifactFileShareDialog from './ArtifactFileShareDialog';
import {
  ArtifactFileShareIntent,
  type ArtifactFileShareIntent as ArtifactFileShareIntentValue,
  getArtifactFileShareCreateAccessMode,
  isArtifactFileSharePermissionDirty,
} from './artifactFileShareDialogModel';
import {
  ArtifactFileSharePermission,
  type ArtifactFileSharePermission as ArtifactFileSharePermissionValue,
  ArtifactFileSharePermissionChangeAction,
  buildArtifactFileSharePermissionPlan,
  deriveArtifactFileSharePermission,
  isArtifactFileShareResumeLocked,
} from './artifactFileSharePermission';
import {
  type ArtifactFileShareRequest,
  ArtifactFileShareRequestSource,
  buildArtifactFileShareRequest,
  getArtifactFileShareSourceType,
  isArtifactFileShareable,
} from './artifactFileSharePolicy';
import {
  ArtifactSubscriptionBlockReason,
  ArtifactSubscriptionFeature,
  type ArtifactSubscriptionPromptState,
  resolveArtifactSubscriptionDecision,
} from './artifactSubscriptionGate';
import ArtifactSubscriptionPromptDialog from './ArtifactSubscriptionPromptDialog';
import { formatHtmlShareFailure } from './htmlShareErrorPresentation';
import {
  createPublishingAnalyticsAttempt,
  createPublishingAnalyticsDialog,
  createPublishingAnalyticsOperationId,
  createPublishingRecoveryAnalyticsContextFromAttempt,
  getPublishingErrorCategory,
  PublishingAnalyticsActionType,
  type PublishingAnalyticsAttemptContext,
  PublishingAnalyticsCtaId,
  type PublishingAnalyticsDialogContext,
  PublishingAnalyticsDialogType,
  PublishingAnalyticsErrorCategory,
  PublishingAnalyticsOperationType,
  PublishingAnalyticsResult,
  PublishingAnalyticsTarget,
  type PublishingRecoveryAnalyticsContext,
  reportPublishingCopyShareLink,
  reportPublishingDialogAction,
  reportPublishingDialogExposure,
  reportPublishingEntryAction,
  reportPublishingOperationResult,
  reportPublishingRecoveryCtaAction,
  reportPublishingRecoveryCtaExposure,
  reportPublishingShareResult,
  updatePublishingAnalyticsAttempt,
} from './publishingAnalytics';
import PublishingQuotaLimitDialog from './PublishingQuotaLimitDialog';
import PublishingTrialNoticeDialog from './PublishingTrialNoticeDialog';
import { shouldShowPublishingTrialNotice } from './publishingTrialNoticePolicy';

const t = (key: string) => i18nService.t(key);

interface ArtifactFileShareRecord {
  shareId: string;
  url: string;
  accessMode: HtmlShareAccessModeValue;
  shareCode?: string;
  shareCodeUnavailable?: boolean;
  status: HtmlShareStatusValue;
  disabledSource?: HtmlShareDisabledSourceValue | null;
  accessExpiresAt?: string | null;
  subscriptionRecoveryMode?: PublishingSubscriptionRecoveryModeValue;
}

interface ArtifactFileShareDialogState {
  artifact: Artifact;
  request?: ArtifactFileShareRequest;
  phase: ArtifactFileSharePhase;
  intent?: ArtifactFileShareIntentValue;
  operation?: ArtifactFileShareOperation;
  share?: ArtifactFileShareRecord;
  selectedPermission?: ArtifactFileSharePermissionValue;
  message?: string;
  failure?: HtmlShareFailureDescriptor;
  errorKey?: string;
}

interface PreparedArtifactFileShare {
  share?: ArtifactFileShareRecord;
}

interface ArtifactFileShareTrialNoticeState {
  artifact: Artifact;
  request: ArtifactFileShareRequest;
  quota: PublishingQuotaErrorData;
}

interface ArtifactFileShareControllerValue {
  isOverlayOpen: boolean;
  openShare: (
    artifact: Artifact,
    context: ArtifactFileShareOpenContext,
  ) => Promise<void>;
}

interface ArtifactFileShareOpenContext {
  source: ArtifactPreviewActionSourceValue;
  entryPoint: ArtifactPublishEntryPointValue;
  surface?: string;
  pageViewId?: string;
}

interface ArtifactFileShareProviderProps {
  sessionId: string;
  children: ReactNode;
}

type HtmlShareApi = NonNullable<typeof window.electron>['htmlShare'];
type HtmlShareResult = Awaited<ReturnType<HtmlShareApi['createFromHtmlFile']>>;

const ArtifactFileShareContext = createContext<ArtifactFileShareControllerValue | null>(null);

class ArtifactFileShareRequestError extends Error {
  readonly code?: number;
  readonly failure: HtmlShareFailureDescriptor;
  readonly quota?: PublishingQuotaErrorData;

  constructor(failure: HtmlShareFailureDescriptor, quota?: PublishingQuotaErrorData) {
    super(failure.error || 'HTML share request failed');
    this.name = 'ArtifactFileShareRequestError';
    this.code = failure.code;
    this.failure = failure;
    this.quota = quota;
  }
}

function isSubscriptionRequiredError(error: unknown): boolean {
  return error instanceof ArtifactFileShareRequestError &&
    error.code === HtmlShareErrorCode.SubscriptionRequired;
}

function normalizeAccessMode(accessMode?: HtmlShareAccessModeValue): HtmlShareAccessModeValue {
  return accessMode === HtmlShareAccessMode.Public
    ? HtmlShareAccessMode.Public
    : HtmlShareAccessMode.Code;
}

function getFailureDescriptor(
  result: HtmlShareFailureDescriptor | null | undefined,
): HtmlShareFailureDescriptor {
  return {
    code: result?.code,
    failureKind: result?.failureKind,
    details: result?.details,
    error: result?.error,
  };
}

function getFailureFromError(error: unknown): HtmlShareFailureDescriptor {
  if (error instanceof ArtifactFileShareRequestError) return error.failure;
  return {
    failureKind: HtmlShareFailureKind.Unknown,
    error: error instanceof Error ? error.message : 'Unknown HTML share error',
  };
}

function getShareRecord(
  value:
    | {
        success?: boolean;
        shareId?: string;
        url?: string;
        accessMode?: HtmlShareAccessModeValue;
        shareCode?: string;
        shareCodeUnavailable?: boolean;
        status?: HtmlShareStatusValue;
        disabledSource?: HtmlShareDisabledSourceValue | null;
        accessExpiresAt?: string | null;
        subscriptionRecoveryMode?: PublishingSubscriptionRecoveryModeValue;
      }
    | null
    | undefined,
  previous?: ArtifactFileShareRecord,
): ArtifactFileShareRecord | null {
  const shareId = value?.shareId || previous?.shareId;
  const url = value?.url || previous?.url;
  if (!shareId || !url) return null;

  const accessMode = normalizeAccessMode(value?.accessMode ?? previous?.accessMode);
  const status = value?.status ?? previous?.status ?? HtmlShareStatus.Live;
  const shareCode =
    accessMode === HtmlShareAccessMode.Code ? (value?.shareCode ?? previous?.shareCode) : undefined;
  const shareCodeUnavailable =
    accessMode === HtmlShareAccessMode.Code
      ? (value?.shareCodeUnavailable ?? (shareCode ? false : previous?.shareCodeUnavailable))
      : undefined;

  return {
    shareId,
    url,
    accessMode,
    shareCode,
    shareCodeUnavailable,
    status,
    disabledSource:
      status === HtmlShareStatus.Disabled
        ? (value?.disabledSource ?? previous?.disabledSource)
        : undefined,
    accessExpiresAt: value && Object.prototype.hasOwnProperty.call(value, 'accessExpiresAt')
      ? value.accessExpiresAt
      : previous?.accessExpiresAt,
    subscriptionRecoveryMode: value?.subscriptionRecoveryMode
      ?? previous?.subscriptionRecoveryMode,
  };
}

function requireShareRecord(
  result: HtmlShareResult,
  previous?: ArtifactFileShareRecord,
): ArtifactFileShareRecord {
  if (!result?.success) {
    throw new ArtifactFileShareRequestError(
      getFailureDescriptor(result),
      result?.quota,
    );
  }
  const share = getShareRecord(result, previous);
  if (!share) {
    throw new ArtifactFileShareRequestError(getFailureDescriptor(result));
  }
  return share;
}

async function createShare(
  api: HtmlShareApi,
  request: ArtifactFileShareRequest,
  accessMode: HtmlShareAccessModeValue,
): Promise<HtmlShareResult> {
  if (request.source === ArtifactFileShareRequestSource.HtmlFile) {
    return api.createFromHtmlFile({
      sessionId: request.sessionId,
      artifactId: request.artifactId,
      filePath: request.filePath || '',
      title: request.title,
      accessMode,
    });
  }
  if (request.source === ArtifactFileShareRequestSource.GeneratedVideo) {
    if (!request.taskId || request.outputIndex === undefined) {
      return { success: false, code: HtmlShareErrorCode.VideoTaskNotFound };
    }
    return api.createFromGeneratedVideo({
      taskId: request.taskId,
      outputIndex: request.outputIndex,
      sessionId: request.sessionId,
      artifactId: request.artifactId,
      title: request.title,
      accessMode,
    });
  }
  return api.createFromArtifactFile({
    sourceType: request.sourceType,
    sessionId: request.sessionId,
    artifactId: request.artifactId,
    title: request.title,
    accessMode,
    fileName: request.fileName,
    filePath: request.filePath,
    content: request.content,
    remoteUrl: request.remoteUrl,
  });
}

async function updateShareFile(
  api: HtmlShareApi,
  request: ArtifactFileShareRequest,
  share: ArtifactFileShareRecord,
  accessMode = share.accessMode,
): Promise<HtmlShareResult> {
  if (request.source === ArtifactFileShareRequestSource.HtmlFile) {
    return api.updateFromHtmlFile({
      shareId: share.shareId,
      sessionId: request.sessionId,
      artifactId: request.artifactId,
      filePath: request.filePath || '',
      title: request.title,
      currentStatus: share.status,
      accessMode,
    });
  }
  if (request.source === ArtifactFileShareRequestSource.GeneratedVideo) {
    if (!request.taskId || request.outputIndex === undefined) {
      return { success: false, code: HtmlShareErrorCode.VideoTaskNotFound };
    }
    return api.createFromGeneratedVideo({
      taskId: request.taskId,
      outputIndex: request.outputIndex,
      sessionId: request.sessionId,
      artifactId: request.artifactId,
      title: request.title,
      accessMode,
    });
  }
  return api.updateFromArtifactFile({
    sourceType: request.sourceType,
    shareId: share.shareId,
    sessionId: request.sessionId,
    artifactId: request.artifactId,
    title: request.title,
    accessMode,
    fileName: request.fileName,
    filePath: request.filePath,
    content: request.content,
    remoteUrl: request.remoteUrl,
    currentStatus: share.status,
  });
}

function logShare(level: 'debug' | 'warn', message: string): void {
  const boundedMessage = message.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (level === 'warn') {
    console.warn(`[ArtifactFileShare] ${boundedMessage}`);
  } else {
    console.debug(`[ArtifactFileShare] ${boundedMessage}`);
  }
  try {
    window.electron?.log?.fromRenderer?.(level, 'ArtifactFileShare', boundedMessage);
  } catch {
    // Diagnostics must never change the result of a share operation.
  }
}

export function ArtifactFileShareProvider({ sessionId, children }: ArtifactFileShareProviderProps) {
  const authState = useSelector((state: RootState) => state.auth);
  const [dialog, setDialog] = useState<ArtifactFileShareDialogState | null>(null);
  const [subscriptionPrompt, setSubscriptionPrompt] =
    useState<ArtifactSubscriptionPromptState | null>(null);
  const [publishingQuota, setPublishingQuota] =
    useState<PublishingQuotaErrorData | null>(null);
  const [trialNotice, setTrialNotice] =
    useState<ArtifactFileShareTrialNoticeState | null>(null);
  const [copyStatus, setCopyStatus] = useState<ArtifactFileShareCopyStatus>(
    ArtifactFileShareCopyStatus.Idle,
  );
  const [updateStatus, setUpdateStatus] = useState<ArtifactFileShareUpdateStatus>(
    ArtifactFileShareUpdateStatus.Idle,
  );
  const dialogRef = useRef<ArtifactFileShareDialogState | null>(dialog);
  dialogRef.current = dialog;
  const generationRef = useRef(0);
  const mutationBarriersRef = useRef(new Map<string, Promise<void>>());
  const preparationPromisesRef = useRef(new Map<string, Promise<PreparedArtifactFileShare>>());
  const feedbackTimerRef = useRef<number | undefined>(undefined);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const analyticsAttemptRef = useRef<PublishingAnalyticsAttemptContext | null>(null);
  const analyticsDialogRef = useRef<PublishingAnalyticsDialogContext | null>(null);

  const clearFeedbackTimer = useCallback(() => {
    if (feedbackTimerRef.current !== undefined) {
      window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = undefined;
    }
  }, []);

  const resetFeedback = useCallback(() => {
    clearFeedbackTimer();
    setCopyStatus(ArtifactFileShareCopyStatus.Idle);
    setUpdateStatus(ArtifactFileShareUpdateStatus.Idle);
  }, [clearFeedbackTimer]);

  useEffect(() => {
    generationRef.current += 1;
    mutationBarriersRef.current.clear();
    preparationPromisesRef.current.clear();
    setDialog(null);
    setSubscriptionPrompt(null);
    setPublishingQuota(null);
    setTrialNotice(null);
    analyticsAttemptRef.current = null;
    analyticsDialogRef.current = null;
    resetFeedback();
  }, [
    authState.accountGeneration,
    authState.ownerAccountKey,
    resetFeedback,
    sessionId,
  ]);

  useEffect(() => () => clearFeedbackTimer(), [clearFeedbackTimer]);

  const closeDialog = useCallback(() => {
    const analyticsDialog = analyticsDialogRef.current;
    if (analyticsDialog) {
      reportPublishingDialogAction(analyticsDialog, {
        actionType: PublishingAnalyticsActionType.Close,
        ctaId: PublishingAnalyticsCtaId.Close,
        target: PublishingAnalyticsTarget.Dismiss,
      });
    }
    analyticsDialogRef.current = null;
    generationRef.current += 1;
    setDialog(null);
    resetFeedback();
  }, [resetFeedback]);

  const closeSubscriptionPrompt = useCallback(() => {
    generationRef.current += 1;
    setSubscriptionPrompt(null);
  }, []);

  const closeTrialNotice = useCallback(() => {
    generationRef.current += 1;
    setTrialNotice(null);
  }, []);

  const showPublishingQuota = useCallback((error: unknown): boolean => {
    if (!(error instanceof ArtifactFileShareRequestError) || !error.quota) return false;
    setDialog(null);
    setPublishingQuota(error.quota);
    return true;
  }, []);

  const isDialogOpen = Boolean(dialog);
  const isDialogBusy = Boolean(dialog?.operation);
  const dialogFocusKey = dialog ? `${dialog.artifact.id}:${dialog.phase}` : '';

  useEffect(() => {
    if (!isDialogOpen) return undefined;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isDialogOpen]);

  useEffect(() => {
    if (!dialogFocusKey) return undefined;
    const frameId = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (isDialogBusy) return;
        closeDialog();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialogElement = closeButtonRef.current?.closest<HTMLElement>('[role="dialog"]');
      if (!dialogElement) return;
      const focusableElements = Array.from(
        dialogElement.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusableElements.length === 0) {
        event.preventDefault();
        return;
      }
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;
      if (!dialogElement.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? lastElement : firstElement).focus();
      } else if (event.shiftKey && activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frameId);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeDialog, dialogFocusKey, isDialogBusy]);

  const showTimedCopyStatus = useCallback(
    (status: ArtifactFileShareCopyStatus) => {
      clearFeedbackTimer();
      setCopyStatus(status);
      feedbackTimerRef.current = window.setTimeout(() => {
        setCopyStatus(ArtifactFileShareCopyStatus.Idle);
        feedbackTimerRef.current = undefined;
      }, 2200);
    },
    [clearFeedbackTimer],
  );

  const showTimedUpdateSuccess = useCallback(() => {
    clearFeedbackTimer();
    setUpdateStatus(ArtifactFileShareUpdateStatus.Updated);
    feedbackTimerRef.current = window.setTimeout(() => {
      setUpdateStatus(ArtifactFileShareUpdateStatus.Idle);
      feedbackTimerRef.current = undefined;
    }, 2200);
  }, [clearFeedbackTimer]);

  const getSubscriptionDecision = useCallback(async () => {
    return resolveArtifactSubscriptionDecision({
      isLoggedIn: authState.isLoggedIn,
      subscriptionStatus: authState.quota?.subscriptionStatus,
      accountMode: authState.quota?.accountMode ?? authState.user?.accountMode,
      shareEntitled: authState.quota?.shareEntitled,
      deploymentEntitled: authState.quota?.deploymentEntitled,
    }, async () => {
      const refreshed = await authService.refreshAuthState();
      return {
        isLoggedIn: refreshed.isLoggedIn,
        subscriptionStatus: refreshed.quota?.subscriptionStatus,
        accountMode: refreshed.quota?.accountMode ?? refreshed.user?.accountMode,
        shareEntitled: refreshed.quota?.shareEntitled,
        deploymentEntitled: refreshed.quota?.deploymentEntitled,
      };
    }, ArtifactSubscriptionFeature.Share);
  }, [authState.isLoggedIn, authState.quota, authState.user?.accountMode]);

  const lookupShare = useCallback(async (api: HtmlShareApi, request: ArtifactFileShareRequest) => {
    if (request.source === ArtifactFileShareRequestSource.HtmlFile) {
      return api.getByHtmlFile({ filePath: request.filePath || '' });
    }
    if (request.source === ArtifactFileShareRequestSource.GeneratedVideo) {
      if (!request.taskId || request.outputIndex === undefined) {
        return { success: false, code: HtmlShareErrorCode.VideoTaskNotFound };
      }
      return api.getGeneratedVideoSource({
        taskId: request.taskId,
        outputIndex: request.outputIndex,
      });
    }
    return api.getByArtifactFile({
          sourceType: request.sourceType,
          sessionId: request.sessionId,
          artifactId: request.artifactId,
          filePath: request.filePath,
        });
  }, []);

  const refreshShare = useCallback(
    async (
      api: HtmlShareApi,
      request: ArtifactFileShareRequest,
      fallback: ArtifactFileShareRecord,
    ): Promise<ArtifactFileShareRecord> => {
      try {
        const lookup = await lookupShare(api, request);
        if (lookup?.success) return getShareRecord(lookup.share, fallback) ?? fallback;
      } catch {
        // Keep the last confirmed response when the follow-up lookup is unavailable.
      }
      return fallback;
    },
    [lookupShare],
  );

  const loadShare = useCallback(
    (api: HtmlShareApi, request: ArtifactFileShareRequest): Promise<PreparedArtifactFileShare> => {
      const key = request.lookupKey;
      const pending = preparationPromisesRef.current.get(key);
      if (pending) return pending;

      const preparation = (async (): Promise<PreparedArtifactFileShare> => {
        const lookup = await lookupShare(api, request);
        if (!lookup?.success) {
          throw new ArtifactFileShareRequestError(getFailureDescriptor(lookup));
        }

        const existingShare = getShareRecord(lookup.share);
        if (existingShare) {
          return { share: existingShare };
        }
        return {};
      })().finally(() => {
        if (preparationPromisesRef.current.get(key) === preparation) {
          preparationPromisesRef.current.delete(key);
        }
      });

      preparationPromisesRef.current.set(key, preparation);
      return preparation;
    },
    [lookupShare],
  );

  const initializeShare = useCallback(
    async (artifact: Artifact, request: ArtifactFileShareRequest): Promise<void> => {
      const api = window.electron?.htmlShare;
      let resolvedRequest = request;
      const runId = generationRef.current + 1;
      generationRef.current = runId;
      resetFeedback();
      setDialog(null);
      setSubscriptionPrompt(null);
      setPublishingQuota(null);
      setTrialNotice(null);

      try {
        const subscriptionDecision = await getSubscriptionDecision();
        if (generationRef.current !== runId) return;
        if (!subscriptionDecision.allowed) {
          setSubscriptionPrompt({
            feature: ArtifactSubscriptionFeature.Share,
            reason: subscriptionDecision.reason,
          });
          return;
        }
        setDialog({
          artifact,
          request,
          phase: ArtifactFileSharePhase.Preparing,
          selectedPermission: ArtifactFileSharePermission.Code,
          message: t('artifactFileShareChecking'),
        });
        if (analyticsAttemptRef.current) {
          analyticsDialogRef.current = createPublishingAnalyticsDialog(
            analyticsAttemptRef.current,
            PublishingAnalyticsDialogType.ShareEditor,
          );
          reportPublishingDialogExposure(analyticsDialogRef.current);
        }
        if (!api) {
          throw new ArtifactFileShareRequestError({
            code: HtmlShareErrorCode.FeatureUnavailable,
          });
        }

        if (
          resolvedRequest.source === ArtifactFileShareRequestSource.GeneratedVideo
          && !resolvedRequest.taskId
        ) {
          if (!resolvedRequest.legacyResultUrl) {
            throw new ArtifactFileShareRequestError({
              code: HtmlShareErrorCode.VideoTaskNotFound,
            });
          }
          const resolution = await api.resolveLegacyGeneratedVideoSource({
            resultUrl: resolvedRequest.legacyResultUrl,
          });
          if (!resolution.success || !resolution.taskId
              || resolution.outputIndex === undefined) {
            throw new ArtifactFileShareRequestError(getFailureDescriptor(resolution));
          }
          resolvedRequest = {
            ...resolvedRequest,
            taskId: resolution.taskId,
            outputIndex: resolution.outputIndex,
            legacyResultUrl: undefined,
            lookupKey: `${resolvedRequest.sourceType}:task:${resolution.taskId}:${resolution.outputIndex}`,
          };
          setDialog(previous => previous
            ? { ...previous, request: resolvedRequest }
            : previous);
        }

        const mutationBarrier = mutationBarriersRef.current.get(resolvedRequest.lookupKey);
        if (mutationBarrier) await mutationBarrier;
        if (generationRef.current !== runId) return;

        const prepared = await loadShare(api, resolvedRequest);
        if (generationRef.current !== runId) return;
        if (analyticsAttemptRef.current) {
          analyticsAttemptRef.current = updatePublishingAnalyticsAttempt(
            analyticsAttemptRef.current,
            {
              operationType: prepared.share
                ? PublishingAnalyticsOperationType.Manage
                : PublishingAnalyticsOperationType.Create,
              hasExistingResource: Boolean(prepared.share),
            },
          );
          if (analyticsDialogRef.current) {
            analyticsDialogRef.current = {
              ...analyticsDialogRef.current,
              attempt: analyticsAttemptRef.current,
            };
          }
        }
        if (!prepared.share) {
          const quotaResult = await api.getQuota();
          if (generationRef.current !== runId) return;
          if (!quotaResult?.success || !quotaResult.data) {
            throw new ArtifactFileShareRequestError(
              getFailureDescriptor(quotaResult),
            );
          }
          if (!quotaResult.data.allowed) {
            setDialog(null);
            setPublishingQuota(quotaResult.data);
            return;
          }
          if (shouldShowPublishingTrialNotice({
            allowed: quotaResult.data.allowed,
            identityType: quotaResult.data.identityType,
            hasExistingResource: false,
          })) {
            setDialog(null);
            setTrialNotice({
              artifact,
              request: resolvedRequest,
              quota: quotaResult.data,
            });
            return;
          }
        }
        const intent = prepared.share
          ? ArtifactFileShareIntent.Manage
          : ArtifactFileShareIntent.Create;
        const selectedPermission = prepared.share
          ? deriveArtifactFileSharePermission(prepared.share)
          : ArtifactFileSharePermission.Code;
        setDialog({
          artifact,
          request: resolvedRequest,
          phase: ArtifactFileSharePhase.Ready,
          intent,
          share: prepared.share,
          selectedPermission,
        });
      } catch (error) {
        if (generationRef.current !== runId) return;
        if (isSubscriptionRequiredError(error)) {
          setDialog(null);
          setSubscriptionPrompt({
            feature: ArtifactSubscriptionFeature.Share,
            reason: ArtifactSubscriptionBlockReason.SubscriptionRequired,
          });
          return;
        }
        if (analyticsAttemptRef.current) {
          reportPublishingOperationResult(analyticsAttemptRef.current, {
            result: PublishingAnalyticsResult.Failure,
            errorCategory: getPublishingErrorCategory(error),
          });
        }
        const failure = getFailureFromError(error);
        const diagnosticMessage = failure.error || 'Unknown HTML share error';
        logShare(
          'warn',
          `Failed to prepare share for artifact ${request.artifactId}: ${diagnosticMessage}`,
        );
        setDialog({
          artifact,
          request,
          phase: ArtifactFileSharePhase.Error,
          selectedPermission: ArtifactFileSharePermission.Code,
          failure,
        });
      }
    },
    [getSubscriptionDecision, loadShare, resetFeedback],
  );

  const continueTrialShare = useCallback(() => {
    const pending = trialNotice;
    if (!pending) return;
    setTrialNotice(null);
    setDialog({
      artifact: pending.artifact,
      request: pending.request,
      phase: ArtifactFileSharePhase.Ready,
      intent: ArtifactFileShareIntent.Create,
      selectedPermission: ArtifactFileSharePermission.Code,
    });
  }, [trialNotice]);

  const openShare = useCallback(
    async (
      artifact: Artifact,
      context: ArtifactFileShareOpenContext,
    ): Promise<void> => {
      const sourceType = getArtifactFileShareSourceType(artifact);
      analyticsDialogRef.current = null;
      const analyticsAttempt = createPublishingAnalyticsAttempt({
        feature: ArtifactSubscriptionFeature.Share,
        resourceKind: PublishingResourceKind.File,
        operationType: PublishingAnalyticsOperationType.Unknown,
        source: context.source,
        entryPoint: context.entryPoint,
        surface: context.surface,
        pageViewId: context.pageViewId,
      });
      analyticsAttemptRef.current = analyticsAttempt;
      reportPublishingEntryAction(analyticsAttempt);
      reportArtifactPreviewAction({
        actionType: 'share_html_click',
        source: context.source,
        artifact,
        params: {
          entryPoint: context.entryPoint,
          shareSourceType: sourceType ?? undefined,
        },
      });

      const request = isArtifactFileShareable(artifact)
        ? buildArtifactFileShareRequest(artifact, sessionId, t('htmlShare'))
        : null;
      if (!request) {
        reportPublishingOperationResult(analyticsAttempt, {
          result: PublishingAnalyticsResult.Failure,
          errorCategory: PublishingAnalyticsErrorCategory.InvalidSource,
        });
        generationRef.current += 1;
        setDialog({
          artifact,
          phase: ArtifactFileSharePhase.Error,
          errorKey: 'artifactShareSourceUnavailable',
        });
        return;
      }
      await initializeShare(artifact, request);
    },
    [initializeShare, sessionId],
  );

  const retryShare = useCallback(() => {
    if (!dialog?.request) return;
    void initializeShare(dialog.artifact, dialog.request);
  }, [dialog, initializeShare]);

  const selectPermission = useCallback(
    (targetPermission: ArtifactFileSharePermissionValue): void => {
      const snapshot = dialog;
      if (
        !snapshot?.request ||
        snapshot.phase !== ArtifactFileSharePhase.Ready ||
        !snapshot.intent ||
        snapshot.operation ||
        (snapshot.intent === ArtifactFileShareIntent.Create &&
          targetPermission === ArtifactFileSharePermission.Stopped) ||
        mutationBarriersRef.current.has(snapshot.request.lookupKey)
      ) {
        return;
      }
      resetFeedback();
      setDialog(previous =>
        previous && previous.artifact.id === snapshot.artifact.id
          ? {
              ...previous,
              selectedPermission: targetPermission,
              failure: undefined,
              errorKey: undefined,
              message: undefined,
            }
          : previous,
      );
    },
    [dialog, resetFeedback],
  );

  const submitCreateShare = useCallback(async (): Promise<void> => {
    const snapshot = dialog;
    const targetPermission = snapshot?.selectedPermission;
    if (
      !snapshot?.request ||
      snapshot.phase !== ArtifactFileSharePhase.Ready ||
      snapshot.intent !== ArtifactFileShareIntent.Create ||
      snapshot.share ||
      !targetPermission ||
      targetPermission === ArtifactFileSharePermission.Stopped ||
      snapshot.operation ||
      mutationBarriersRef.current.has(snapshot.request.lookupKey)
    ) {
      return;
    }
    const api = window.electron?.htmlShare;
    const accessMode = getArtifactFileShareCreateAccessMode(targetPermission);
    if (!api || !accessMode) return;
    const operationId = createPublishingAnalyticsOperationId();
    const operationStartedAt = Date.now();
    if (analyticsDialogRef.current) {
      reportPublishingDialogAction(analyticsDialogRef.current, {
        actionType: PublishingAnalyticsActionType.Click,
        ctaId: PublishingAnalyticsCtaId.Primary,
        target: PublishingAnalyticsTarget.CreateShare,
        operationId,
      });
    }
    const runId = generationRef.current + 1;
    generationRef.current = runId;
    let releaseMutationBarrier: (() => void) | undefined;
    const mutationBarrier = new Promise<void>(resolve => {
      releaseMutationBarrier = resolve;
    });
    const mutationKey = snapshot.request.lookupKey;
    mutationBarriersRef.current.set(mutationKey, mutationBarrier);
    resetFeedback();
    setDialog(previous =>
      previous && previous.artifact.id === snapshot.artifact.id
        ? {
            ...previous,
            operation: ArtifactFileShareOperation.Creating,
            failure: undefined,
            errorKey: undefined,
            message: undefined,
          }
        : previous,
    );

    try {
      const result = await createShare(api, snapshot.request, accessMode);
      let share = requireShareRecord(result);
      if (generationRef.current !== runId) return;
      share = await refreshShare(api, snapshot.request, share);
      if (generationRef.current !== runId) return;
      setDialog(previous =>
        previous && previous.artifact.id === snapshot.artifact.id
          ? {
              ...previous,
              intent: ArtifactFileShareIntent.Manage,
              share,
              selectedPermission: deriveArtifactFileSharePermission(share),
              operation: undefined,
              message: result.warnings?.length
                ? result.warnings.slice(0, 3).join('\n')
                : t('htmlShareSuccessMessage'),
              failure: undefined,
              errorKey: undefined,
            }
          : previous,
      );
      logShare(
        'debug',
        `Created ${snapshot.request.sourceType} share for artifact ${snapshot.request.artifactId}.`,
      );
      if (analyticsAttemptRef.current) {
        const resultOptions = {
          result: PublishingAnalyticsResult.Success,
          operationType: PublishingAnalyticsOperationType.Create,
          operationId,
          exposureId: analyticsDialogRef.current?.exposureId,
          shareId: share.shareId,
          accessPermission: targetPermission,
          durationMs: Date.now() - operationStartedAt,
        } as const;
        reportPublishingShareResult(analyticsAttemptRef.current, resultOptions);
        reportPublishingOperationResult(analyticsAttemptRef.current, resultOptions);
        analyticsAttemptRef.current = updatePublishingAnalyticsAttempt(
          analyticsAttemptRef.current,
          {
            operationType: PublishingAnalyticsOperationType.Manage,
            hasExistingResource: true,
          },
        );
        if (analyticsDialogRef.current) {
          analyticsDialogRef.current = {
            ...analyticsDialogRef.current,
            attempt: analyticsAttemptRef.current,
          };
        }
      }
    } catch (error) {
      if (generationRef.current !== runId) return;
      if (analyticsAttemptRef.current) {
        const resultOptions = {
          result: PublishingAnalyticsResult.Failure,
          operationType: PublishingAnalyticsOperationType.Create,
          operationId,
          exposureId: analyticsDialogRef.current?.exposureId,
          accessPermission: targetPermission,
          durationMs: Date.now() - operationStartedAt,
          errorCategory: getPublishingErrorCategory(error),
        } as const;
        reportPublishingShareResult(analyticsAttemptRef.current, resultOptions);
        reportPublishingOperationResult(analyticsAttemptRef.current, resultOptions);
      }
      if (isSubscriptionRequiredError(error)) {
        setDialog(null);
        setSubscriptionPrompt({
          feature: ArtifactSubscriptionFeature.Share,
          reason: ArtifactSubscriptionBlockReason.SubscriptionRequired,
        });
        return;
      }
      if (showPublishingQuota(error)) return;
      const failure = getFailureFromError(error);
      const diagnosticMessage = failure.error || 'Unknown HTML share error';
      logShare(
        'warn',
        `Failed to create share for artifact ${snapshot.request.artifactId}: ${diagnosticMessage}`,
      );
      setDialog(previous =>
        previous && previous.artifact.id === snapshot.artifact.id
          ? { ...previous, operation: undefined, failure }
          : previous,
      );
    } finally {
      if (mutationBarriersRef.current.get(mutationKey) === mutationBarrier) {
        mutationBarriersRef.current.delete(mutationKey);
      }
      releaseMutationBarrier?.();
    }
  }, [dialog, refreshShare, resetFeedback, showPublishingQuota]);

  const submitPermissionChange = useCallback(async (): Promise<void> => {
    const snapshot = dialog;
    const targetPermission = snapshot?.selectedPermission;
    if (
      !snapshot?.request ||
      snapshot.phase !== ArtifactFileSharePhase.Ready ||
      snapshot.intent !== ArtifactFileShareIntent.Manage ||
      !snapshot.share ||
      !targetPermission ||
      snapshot.operation ||
      mutationBarriersRef.current.has(snapshot.request.lookupKey)
    ) {
      return;
    }
    const permissionPlan = buildArtifactFileSharePermissionPlan(snapshot.share, targetPermission);
    if (
      permissionPlan.length === 0 ||
      permissionPlan.some(step => step.action === ArtifactFileSharePermissionChangeAction.Blocked)
    ) {
      return;
    }
    const orderedPermissionPlan =
      snapshot.request.source === ArtifactFileShareRequestSource.GeneratedVideo
      && permissionPlan.some(
        step => step.action === ArtifactFileSharePermissionChangeAction.RestoreActiveLimit,
      )
        ? [
            ...permissionPlan.filter(
              step => step.action === ArtifactFileSharePermissionChangeAction.RestoreActiveLimit,
            ),
            ...permissionPlan.filter(
              step => step.action !== ArtifactFileSharePermissionChangeAction.RestoreActiveLimit,
            ),
          ]
        : permissionPlan;

    const api = window.electron?.htmlShare;
    if (!api) return;
    const operationId = createPublishingAnalyticsOperationId();
    const operationStartedAt = Date.now();
    if (analyticsDialogRef.current) {
      reportPublishingDialogAction(analyticsDialogRef.current, {
        actionType: PublishingAnalyticsActionType.Click,
        ctaId: PublishingAnalyticsCtaId.Primary,
        target: PublishingAnalyticsTarget.UpdatePermission,
        operationId,
      });
    }
    const runId = generationRef.current + 1;
    generationRef.current = runId;
    let releaseMutationBarrier: (() => void) | undefined;
    const mutationBarrier = new Promise<void>(resolve => {
      releaseMutationBarrier = resolve;
    });
    const mutationKey = snapshot.request.lookupKey;
    mutationBarriersRef.current.set(mutationKey, mutationBarrier);
    const originalShare = snapshot.share;
    setDialog(previous =>
      previous && previous.artifact.id === snapshot.artifact.id
        ? {
            ...previous,
            operation: ArtifactFileShareOperation.Permission,
            failure: undefined,
            errorKey: undefined,
            message: undefined,
          }
        : previous,
    );

    let lastConfirmedShare = originalShare;
    try {
      let nextShare = originalShare;
      for (const step of orderedPermissionPlan) {
        if (step.action === ArtifactFileSharePermissionChangeAction.UpdateAccess) {
          nextShare = requireShareRecord(
            await api.updateAccessMode({
              shareId: nextShare.shareId,
              accessMode: step.accessMode,
            }),
            nextShare,
          );
        } else if (step.action === ArtifactFileSharePermissionChangeAction.UpdateStatus) {
          nextShare = requireShareRecord(
            await api.updateStatus({
              shareId: nextShare.shareId,
              status: step.status,
            }),
            nextShare,
          );
        } else if (step.action === ArtifactFileSharePermissionChangeAction.RestoreActiveLimit) {
          nextShare = requireShareRecord(
            snapshot.request.source === ArtifactFileShareRequestSource.GeneratedVideo
              ? await api.updateStatus({
                  shareId: nextShare.shareId,
                  status: HtmlShareStatus.Live,
                })
              : await updateShareFile(api, snapshot.request, nextShare, nextShare.accessMode),
            nextShare,
          );
        }
        lastConfirmedShare = nextShare;
        if (generationRef.current !== runId) return;
      }

      nextShare = await refreshShare(api, snapshot.request, nextShare);
      if (generationRef.current !== runId) return;
      setDialog(previous =>
        previous && previous.artifact.id === snapshot.artifact.id
          ? {
              ...previous,
              share: nextShare,
              selectedPermission: deriveArtifactFileSharePermission(nextShare),
              operation: undefined,
              message: t('artifactFileSharePermissionUpdated'),
              failure: undefined,
              errorKey: undefined,
            }
          : previous,
      );
      if (analyticsAttemptRef.current) {
        const resultOptions = {
          result: PublishingAnalyticsResult.Success,
          operationType: PublishingAnalyticsOperationType.UpdatePermission,
          operationId,
          exposureId: analyticsDialogRef.current?.exposureId,
          shareId: nextShare.shareId,
          accessPermission: targetPermission,
          durationMs: Date.now() - operationStartedAt,
        } as const;
        reportPublishingShareResult(analyticsAttemptRef.current, resultOptions);
        reportPublishingOperationResult(analyticsAttemptRef.current, resultOptions);
      }
    } catch (error) {
      if (generationRef.current !== runId) return;
      if (analyticsAttemptRef.current) {
        const resultOptions = {
          result: PublishingAnalyticsResult.Failure,
          operationType: PublishingAnalyticsOperationType.UpdatePermission,
          operationId,
          exposureId: analyticsDialogRef.current?.exposureId,
          shareId: snapshot.share.shareId,
          accessPermission: targetPermission,
          durationMs: Date.now() - operationStartedAt,
          errorCategory: getPublishingErrorCategory(error),
        } as const;
        reportPublishingShareResult(analyticsAttemptRef.current, resultOptions);
        reportPublishingOperationResult(analyticsAttemptRef.current, resultOptions);
      }
      if (isSubscriptionRequiredError(error)) {
        setDialog(null);
        setSubscriptionPrompt({
          feature: ArtifactSubscriptionFeature.Share,
          reason: ArtifactSubscriptionBlockReason.SubscriptionRequired,
        });
        return;
      }
      if (showPublishingQuota(error)) return;
      const refreshedShare = await refreshShare(api, snapshot.request, lastConfirmedShare);
      if (generationRef.current !== runId) return;
      const retryPlan = buildArtifactFileSharePermissionPlan(refreshedShare, targetPermission);
      const canRetry = !retryPlan.some(
        step => step.action === ArtifactFileSharePermissionChangeAction.Blocked,
      );
      const failure = getFailureFromError(error);
      setDialog(previous =>
        previous && previous.artifact.id === snapshot.artifact.id
          ? {
              ...previous,
              share: refreshedShare,
              selectedPermission: canRetry
                ? targetPermission
                : deriveArtifactFileSharePermission(refreshedShare),
              operation: undefined,
              failure,
            }
          : previous,
      );
    } finally {
      if (mutationBarriersRef.current.get(mutationKey) === mutationBarrier) {
        mutationBarriersRef.current.delete(mutationKey);
      }
      releaseMutationBarrier?.();
    }
  }, [dialog, refreshShare, showPublishingQuota]);

  const updateFile = useCallback(async (): Promise<void> => {
    const snapshot = dialog;
    if (
      !snapshot?.request ||
      snapshot.phase !== ArtifactFileSharePhase.Ready ||
      snapshot.intent !== ArtifactFileShareIntent.Manage ||
      !snapshot.share ||
      snapshot.operation ||
      snapshot.share.status === HtmlShareStatus.Disabled ||
      snapshot.share.status === HtmlShareStatus.Failed ||
      snapshot.selectedPermission !== deriveArtifactFileSharePermission(snapshot.share) ||
      mutationBarriersRef.current.has(snapshot.request.lookupKey)
    ) {
      return;
    }
    const api = window.electron?.htmlShare;
    if (!api) return;
    const operationId = createPublishingAnalyticsOperationId();
    const operationStartedAt = Date.now();
    if (analyticsDialogRef.current) {
      reportPublishingDialogAction(analyticsDialogRef.current, {
        actionType: PublishingAnalyticsActionType.Click,
        ctaId: PublishingAnalyticsCtaId.Primary,
        target: PublishingAnalyticsTarget.UpdateContent,
        operationId,
      });
    }
    const runId = generationRef.current + 1;
    generationRef.current = runId;
    let releaseMutationBarrier: (() => void) | undefined;
    const mutationBarrier = new Promise<void>(resolve => {
      releaseMutationBarrier = resolve;
    });
    const mutationKey = snapshot.request.lookupKey;
    mutationBarriersRef.current.set(mutationKey, mutationBarrier);
    resetFeedback();
    setDialog(previous =>
      previous
        ? {
            ...previous,
            operation: ArtifactFileShareOperation.UpdateFile,
            failure: undefined,
            errorKey: undefined,
            message: undefined,
          }
        : previous,
    );

    try {
      let share = requireShareRecord(
        await updateShareFile(api, snapshot.request, snapshot.share),
        snapshot.share,
      );
      if (generationRef.current !== runId) return;
      share = await refreshShare(api, snapshot.request, share);
      if (generationRef.current !== runId) return;
      setDialog(previous =>
        previous && previous.artifact.id === snapshot.artifact.id
          ? {
              ...previous,
              share,
              selectedPermission: deriveArtifactFileSharePermission(share),
              operation: undefined,
              message: undefined,
            }
          : previous,
      );
      showTimedUpdateSuccess();
      if (analyticsAttemptRef.current) {
        const resultOptions = {
          result: PublishingAnalyticsResult.Success,
          operationType: PublishingAnalyticsOperationType.UpdateContent,
          operationId,
          exposureId: analyticsDialogRef.current?.exposureId,
          shareId: share.shareId,
          accessPermission: deriveArtifactFileSharePermission(share),
          durationMs: Date.now() - operationStartedAt,
        } as const;
        reportPublishingShareResult(analyticsAttemptRef.current, resultOptions);
        reportPublishingOperationResult(analyticsAttemptRef.current, resultOptions);
      }
    } catch (error) {
      if (generationRef.current !== runId) return;
      if (analyticsAttemptRef.current) {
        const resultOptions = {
          result: PublishingAnalyticsResult.Failure,
          operationType: PublishingAnalyticsOperationType.UpdateContent,
          operationId,
          exposureId: analyticsDialogRef.current?.exposureId,
          shareId: snapshot.share.shareId,
          accessPermission: deriveArtifactFileSharePermission(snapshot.share),
          durationMs: Date.now() - operationStartedAt,
          errorCategory: getPublishingErrorCategory(error),
        } as const;
        reportPublishingShareResult(analyticsAttemptRef.current, resultOptions);
        reportPublishingOperationResult(analyticsAttemptRef.current, resultOptions);
      }
      if (isSubscriptionRequiredError(error)) {
        setDialog(null);
        setSubscriptionPrompt({
          feature: ArtifactSubscriptionFeature.Share,
          reason: ArtifactSubscriptionBlockReason.SubscriptionRequired,
        });
        return;
      }
      if (showPublishingQuota(error)) return;
      const failure = getFailureFromError(error);
      setDialog(previous =>
        previous && previous.artifact.id === snapshot.artifact.id
          ? { ...previous, operation: undefined, failure }
          : previous,
      );
    } finally {
      if (mutationBarriersRef.current.get(mutationKey) === mutationBarrier) {
        mutationBarriersRef.current.delete(mutationKey);
      }
      releaseMutationBarrier?.();
    }
  }, [dialog, refreshShare, resetFeedback, showPublishingQuota, showTimedUpdateSuccess]);

  const copyShare = useCallback(async (): Promise<void> => {
    const share = dialog?.share;
    if (
      !share ||
      dialog?.intent !== ArtifactFileShareIntent.Manage ||
      dialog.selectedPermission !== deriveArtifactFileSharePermission(share) ||
      dialog.operation
    ) {
      return;
    }
    const operationId = createPublishingAnalyticsOperationId();
    const operationStartedAt = Date.now();
    if (analyticsDialogRef.current) {
      reportPublishingDialogAction(analyticsDialogRef.current, {
        actionType: PublishingAnalyticsActionType.Click,
        ctaId: PublishingAnalyticsCtaId.Secondary,
        target: PublishingAnalyticsTarget.CopyLink,
        operationId,
      });
    }
    const copyResult = buildArtifactFileShareCopyText({
      accessMode: share.accessMode,
      status:
        share.status === HtmlShareStatus.Disabled ? HtmlShareStatus.Disabled : HtmlShareStatus.Live,
      url: share.url,
      shareCode: share.shareCode,
      labels: {
        link: t('htmlShareClipboardLinkLabel'),
        shareCode: t('htmlShareCode'),
      },
    });
    if (!copyResult.copyable) {
      showTimedCopyStatus(ArtifactFileShareCopyStatus.Failed);
      if (analyticsAttemptRef.current) {
        reportPublishingCopyShareLink(analyticsAttemptRef.current, {
          operationId,
          exposureId: analyticsDialogRef.current?.exposureId,
          shareId: share.shareId,
          accessPermission: deriveArtifactFileSharePermission(share),
          durationMs: Date.now() - operationStartedAt,
          result: PublishingAnalyticsResult.Failure,
          errorCategory: PublishingAnalyticsErrorCategory.InvalidSource,
        });
      }
      return;
    }
    const runId = generationRef.current;
    const copied = await copyTextToClipboard(copyResult.text);
    if (generationRef.current !== runId) return;
    showTimedCopyStatus(
      copied ? ArtifactFileShareCopyStatus.Copied : ArtifactFileShareCopyStatus.Failed,
    );
    if (analyticsAttemptRef.current) {
      reportPublishingCopyShareLink(analyticsAttemptRef.current, {
        operationId,
        exposureId: analyticsDialogRef.current?.exposureId,
        shareId: share.shareId,
        accessPermission: deriveArtifactFileSharePermission(share),
        durationMs: Date.now() - operationStartedAt,
        result: copied
          ? PublishingAnalyticsResult.Success
          : PublishingAnalyticsResult.Failure,
        ...(!copied
          ? { errorCategory: PublishingAnalyticsErrorCategory.Unknown }
          : {}),
      });
    }
  }, [dialog, showTimedCopyStatus]);

  const openSubscriptionPage = useCallback(() => {
    void window.electron?.shell?.openExternal(getPortalPricingUrl(
      PortalPricingKeyfrom.HtmlShare,
      { traceId: analyticsAttemptRef.current?.attemptId },
    ));
    closeSubscriptionPrompt();
  }, [closeSubscriptionPrompt]);

  const openLoginPage = useCallback(() => {
    closeSubscriptionPrompt();
    void authService.login();
  }, [closeSubscriptionPrompt]);

  const openTrialSubscriptionPage = useCallback(() => {
    void window.electron?.shell?.openExternal(getPortalPricingUrl(
      PortalPricingKeyfrom.HtmlShare,
      { traceId: analyticsAttemptRef.current?.attemptId },
    ));
    closeTrialNotice();
  }, [closeTrialNotice]);

  const share = dialog?.share;
  const recoveryAnalyticsContext = useMemo<PublishingRecoveryAnalyticsContext | null>(() => {
    const analyticsAttempt = analyticsAttemptRef.current;
    if (
      !analyticsAttempt
      || !authState.ownerAccountKey
      || !share?.shareId
      || share.subscriptionRecoveryMode !== PublishingSubscriptionRecoveryMode.Automatic
    ) {
      return null;
    }
    return createPublishingRecoveryAnalyticsContextFromAttempt(analyticsAttempt, {
      ownerAccountKey: authState.ownerAccountKey,
      resourceKey: share.shareId,
      recoverySurface: PublishingRecoveryAnalyticsSurface.TaskFileShareDialog,
      subscriptionRecoveryMode: share.subscriptionRecoveryMode,
    });
  }, [
    authState.ownerAccountKey,
    share?.shareId,
    share?.subscriptionRecoveryMode,
  ]);

  useEffect(() => {
    const ownerAccountKey = authState.ownerAccountKey;
    const request = dialog?.request;
    const recoveryMode = share?.subscriptionRecoveryMode;
    if (
      !ownerAccountKey
      || !request
      || !share?.shareId
      || recoveryMode !== PublishingSubscriptionRecoveryMode.Automatic
    ) {
      return undefined;
    }
    return registerPublishingSubscriptionRecoveryTarget({
      ownerAccountKey,
      resourceKind: PublishingResourceKind.File,
      resourceKey: share.shareId,
      recoveryMode,
      traceId: recoveryAnalyticsContext?.attemptId
        ?? analyticsAttemptRef.current?.attemptId
        ?? createPublishingAnalyticsOperationId(),
      refresh: async () => {
        const currentDialog = dialogRef.current;
        const fallback = currentDialog?.share;
        const api = window.electron?.htmlShare;
        if (!api || !fallback || currentDialog?.request?.lookupKey !== request.lookupKey) {
          return PublishingSubscriptionRecoveryRefreshOutcome.ResourceUnavailable;
        }
        const result = await lookupShare(api, request).catch(() => null);
        if (!result?.success) return PublishingSubscriptionRecoveryRefreshOutcome.Pending;
        const refreshedShare = getShareRecord(result.share, fallback);
        if (!refreshedShare) {
          return PublishingSubscriptionRecoveryRefreshOutcome.ResourceUnavailable;
        }
        setDialog(current => current?.request?.lookupKey === request.lookupKey
          ? {
              ...current,
              share: refreshedShare,
              selectedPermission: deriveArtifactFileSharePermission(refreshedShare),
            }
          : current);
        return resolvePublishingSubscriptionRecoveryRefreshOutcome({
          expectedMode: recoveryMode,
          currentMode: refreshedShare.subscriptionRecoveryMode,
          isRestored: refreshedShare.status === HtmlShareStatus.Live
            && refreshedShare.accessExpiresAt === null,
        });
      },
    });
  }, [
    authState.ownerAccountKey,
    dialog?.request,
    lookupShare,
    recoveryAnalyticsContext?.attemptId,
    share?.shareId,
    share?.subscriptionRecoveryMode,
  ]);

  const openRecoverySubscriptionPage = useCallback(() => {
    if (!recoveryAnalyticsContext) return;
    reportPublishingRecoveryCtaAction(recoveryAnalyticsContext);
    armPublishingSubscriptionRecovery({
      ownerAccountKey: recoveryAnalyticsContext.ownerAccountKey,
      resourceKind: recoveryAnalyticsContext.resourceKind,
      resourceKey: recoveryAnalyticsContext.resourceKey,
      recoveryMode: recoveryAnalyticsContext.subscriptionRecoveryMode,
      traceId: recoveryAnalyticsContext.attemptId,
    });
    void window.electron?.shell?.openExternal(getPortalPricingUrl(
      PortalPricingKeyfrom.HtmlShare,
      { traceId: recoveryAnalyticsContext.attemptId },
    ));
  }, [recoveryAnalyticsContext]);

  const contextValue = useMemo<ArtifactFileShareControllerValue>(
    () => ({
      isOverlayOpen:
        isDialogOpen ||
        Boolean(subscriptionPrompt) ||
        Boolean(publishingQuota) ||
        Boolean(trialNotice),
      openShare,
    }),
    [isDialogOpen, openShare, publishingQuota, subscriptionPrompt, trialNotice],
  );

  const committedPermission = share
    ? deriveArtifactFileSharePermission(share)
    : undefined;
  const selectedPermission = dialog?.selectedPermission ??
    committedPermission ??
    ArtifactFileSharePermission.Code;
  const isPermissionDirty = isArtifactFileSharePermissionDirty(
    dialog?.intent,
    committedPermission,
    selectedPermission,
  );
  const stoppedNotice =
    share?.status !== HtmlShareStatus.Disabled
      ? undefined
      : share.disabledSource === HtmlShareDisabledSource.ActiveLimit
        ? t('htmlShareStoppedByActiveLimitNotice')
        : share.disabledSource === HtmlShareDisabledSource.Admin
          ? t('htmlShareStoppedByAdminNotice')
          : share.disabledSource === HtmlShareDisabledSource.Moderation
            ? t('htmlShareStoppedByModerationNotice')
            : t('htmlShareStoppedNotice');
  const isPermissionLocked = Boolean(
    share?.status === HtmlShareStatus.Failed ||
    (share?.status === HtmlShareStatus.Disabled &&
      isArtifactFileShareResumeLocked(share.disabledSource)),
  );
  const dialogMessage =
    dialog?.message ??
    (share?.status === HtmlShareStatus.Failed ? t('htmlShareResultStatusFailed') : undefined);
  const dialogError = dialog?.errorKey
    ? t(dialog.errorKey)
    : dialog?.failure
      ? formatHtmlShareFailure(dialog.failure)
      : undefined;
  const copyResult = share
    ? buildArtifactFileShareCopyText({
        accessMode: share.accessMode,
        status:
          share.status === HtmlShareStatus.Disabled
            ? HtmlShareStatus.Disabled
            : HtmlShareStatus.Live,
        url: share.url,
        shareCode: share.shareCode,
        labels: {
          link: t('htmlShareClipboardLinkLabel'),
          shareCode: t('htmlShareCode'),
        },
      })
    : null;
  const permissionPlan = share && isPermissionDirty
    ? buildArtifactFileSharePermissionPlan(share, selectedPermission)
    : [];
  const canCreate = Boolean(
    dialog?.phase === ArtifactFileSharePhase.Ready &&
    dialog.intent === ArtifactFileShareIntent.Create &&
    !dialog.operation &&
    selectedPermission !== ArtifactFileSharePermission.Stopped,
  );
  const canSubmitPermission = Boolean(
    dialog?.phase === ArtifactFileSharePhase.Ready &&
    dialog.intent === ArtifactFileShareIntent.Manage &&
    isPermissionDirty &&
    !isPermissionLocked &&
    !dialog.operation &&
    permissionPlan.length > 0 &&
    !permissionPlan.some(
      step => step.action === ArtifactFileSharePermissionChangeAction.Blocked,
    ),
  );
  const canCopy = Boolean(
    dialog?.phase === ArtifactFileSharePhase.Ready &&
    dialog.intent === ArtifactFileShareIntent.Manage &&
    !dialog.operation &&
    !isPermissionDirty &&
    copyResult?.copyable,
  );
  const canUpdateFile = Boolean(
    dialog?.phase === ArtifactFileSharePhase.Ready &&
    dialog.intent === ArtifactFileShareIntent.Manage &&
    !dialog.operation &&
    !isPermissionDirty &&
    share &&
    share.status !== HtmlShareStatus.Disabled &&
    share.status !== HtmlShareStatus.Failed,
  );
  const showUpdateFile =
    dialog?.request?.source !== ArtifactFileShareRequestSource.GeneratedVideo;

  const dialogPortal =
    dialog && typeof document !== 'undefined'
      ? createPortal(
          <ArtifactFileShareDialog
            artifact={dialog.artifact}
            phase={dialog.phase}
            operation={dialog.operation}
            intent={dialog.intent}
            committedPermission={committedPermission}
            selectedPermission={selectedPermission}
            isPermissionDirty={isPermissionDirty}
            stoppedNotice={stoppedNotice}
            isPermissionLocked={isPermissionLocked}
            message={dialogMessage}
            error={dialogError}
            shareCodeUnavailable={Boolean(
              share?.accessMode === HtmlShareAccessMode.Code &&
              !isPermissionDirty &&
              (share.shareCodeUnavailable || !share.shareCode),
            )}
            accessExpiresAt={share?.accessExpiresAt}
            ownerAccountKey={authState.ownerAccountKey}
            subscriptionStatus={authState.quota?.subscriptionStatus}
            recoveryMode={share?.subscriptionRecoveryMode}
            recoveryAnalyticsContext={recoveryAnalyticsContext}
            recoveryExposureKey={recoveryAnalyticsContext?.exposureId}
            canRetry={Boolean(dialog.request)}
            canCreate={canCreate}
            canSubmitPermission={canSubmitPermission}
            canCopy={canCopy}
            showUpdateFile={showUpdateFile}
            canUpdateFile={canUpdateFile}
            copyStatus={copyStatus}
            updateStatus={updateStatus}
            closeButtonRef={closeButtonRef}
            onClose={closeDialog}
            onRetry={retryShare}
            onPermissionChange={selectPermission}
            onCreate={() => void submitCreateShare()}
            onSubmitPermission={() => void submitPermissionChange()}
            onUpdateFile={() => void updateFile()}
            onCopy={() => void copyShare()}
            onRecoveryExposure={recoveryAnalyticsContext
              ? () => reportPublishingRecoveryCtaExposure(recoveryAnalyticsContext)
              : undefined}
            onRecoveryClick={recoveryAnalyticsContext
              ? openRecoverySubscriptionPage
              : undefined}
          />,
          document.body,
        )
      : null;

  const subscriptionPromptPortal = subscriptionPrompt ? (
    <ArtifactSubscriptionPromptDialog
      feature={subscriptionPrompt.feature}
      reason={subscriptionPrompt.reason}
      onCancel={closeSubscriptionPrompt}
      onLogin={openLoginPage}
      onSubscribe={openSubscriptionPage}
      onLearnBenefits={openSubscriptionPage}
      analyticsAttempt={analyticsAttemptRef.current}
    />
  ) : null;

  const publishingQuotaPortal = publishingQuota ? (
    <PublishingQuotaLimitDialog
      quota={publishingQuota}
      onClose={() => setPublishingQuota(null)}
      onSubscribe={openSubscriptionPage}
      onLearnBenefits={openSubscriptionPage}
      analyticsAttempt={analyticsAttemptRef.current}
      onManage={() => {
        setPublishingQuota(null);
        window.dispatchEvent(new Event(LibraryNavigationEvent.OpenCloud));
      }}
    />
  ) : null;

  const trialNoticePortal = trialNotice ? (
    <PublishingTrialNoticeDialog
      feature={ArtifactSubscriptionFeature.Share}
      quota={trialNotice.quota}
      onCancel={closeTrialNotice}
      onContinue={continueTrialShare}
      onSubscribe={openTrialSubscriptionPage}
      analyticsAttempt={analyticsAttemptRef.current}
    />
  ) : null;

  return (
    <ArtifactFileShareContext.Provider value={contextValue}>
      {children}
      {dialogPortal}
      {subscriptionPromptPortal}
      {publishingQuotaPortal}
      {trialNoticePortal}
    </ArtifactFileShareContext.Provider>
  );
}

export function useOptionalArtifactFileShare(): ArtifactFileShareControllerValue | null {
  return useContext(ArtifactFileShareContext);
}
