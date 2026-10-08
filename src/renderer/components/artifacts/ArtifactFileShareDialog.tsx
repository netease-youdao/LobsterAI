import type { PublishingSubscriptionRecoveryMode } from '@shared/publishing/constants';
import type { RefObject } from 'react';

import { i18nService } from '@/services/i18n';
import type { Artifact } from '@/types/artifact';

import {
  ArtifactFileShareIntent,
  type ArtifactFileShareIntent as ArtifactFileShareIntentValue,
  ArtifactFileSharePrimaryAction,
  getArtifactFileSharePrimaryAction,
  isArtifactFileSharePermissionOptionDisabled,
} from './artifactFileShareDialogModel';
import {
  ArtifactFileSharePermission,
  type ArtifactFileSharePermission as ArtifactFileSharePermissionValue,
} from './artifactFileSharePermission';
import ArtifactPreviewIdentity from './ArtifactPreviewIdentity';
import type { PublishingRecoveryAnalyticsContext } from './publishingAnalytics';
import { getPublishingRecoveryFooterActions } from './publishingRecoveryFooterModel';
import PublishingSubscriptionRecoveryButton from './PublishingSubscriptionRecoveryButton';
import { shouldShowPublishingSubscriptionRecovery } from './publishingSubscriptionRecoveryPolicy';
import {
  PublishingTrialStatus,
  usePublishingTrialStatus,
} from './PublishingTrialStatus';
import { usePublishingRecoveryExposureLifecycle } from './usePublishingRecoveryExposureLifecycle';

const t = (key: string) => i18nService.t(key);

export const ArtifactFileSharePhase = {
  Preparing: 'preparing',
  Ready: 'ready',
  Error: 'error',
} as const;

export type ArtifactFileSharePhase =
  (typeof ArtifactFileSharePhase)[keyof typeof ArtifactFileSharePhase];

export const ArtifactFileShareOperation = {
  Creating: 'creating',
  Permission: 'permission',
  UpdateFile: 'update_file',
} as const;

export type ArtifactFileShareOperation =
  (typeof ArtifactFileShareOperation)[keyof typeof ArtifactFileShareOperation];

export const ArtifactFileShareCopyStatus = {
  Idle: 'idle',
  Copied: 'copied',
  Failed: 'failed',
} as const;

export type ArtifactFileShareCopyStatus =
  (typeof ArtifactFileShareCopyStatus)[keyof typeof ArtifactFileShareCopyStatus];

export const ArtifactFileShareUpdateStatus = {
  Idle: 'idle',
  Updated: 'updated',
} as const;

export type ArtifactFileShareUpdateStatus =
  (typeof ArtifactFileShareUpdateStatus)[keyof typeof ArtifactFileShareUpdateStatus];

interface ArtifactFileShareDialogProps {
  artifact: Artifact;
  phase: ArtifactFileSharePhase;
  operation?: ArtifactFileShareOperation;
  intent?: ArtifactFileShareIntentValue;
  committedPermission?: ArtifactFileSharePermissionValue;
  selectedPermission: ArtifactFileSharePermissionValue;
  isPermissionDirty: boolean;
  stoppedNotice?: string;
  isPermissionLocked?: boolean;
  message?: string;
  error?: string;
  shareCodeUnavailable?: boolean;
  accessExpiresAt?: string | null;
  ownerAccountKey?: string | null;
  subscriptionStatus?: string | null;
  recoveryMode?: PublishingSubscriptionRecoveryMode;
  recoveryAnalyticsContext?: PublishingRecoveryAnalyticsContext | null;
  recoveryExposureKey?: string;
  canRetry: boolean;
  canCreate: boolean;
  canSubmitPermission: boolean;
  canCopy: boolean;
  showUpdateFile?: boolean;
  canUpdateFile: boolean;
  copyStatus: ArtifactFileShareCopyStatus;
  updateStatus: ArtifactFileShareUpdateStatus;
  closeButtonRef: RefObject<HTMLButtonElement>;
  onClose: () => void;
  onRetry: () => void;
  onPermissionChange: (permission: ArtifactFileSharePermissionValue) => void;
  onCreate: () => void;
  onSubmitPermission: () => void;
  onUpdateFile: () => void;
  onCopy: () => void;
  onRecoveryExposure?: () => void;
  onRecoveryClick?: () => void;
}

const CloseIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M4.5 4.5l7 7" />
    <path d="M11.5 4.5l-7 7" />
  </svg>
);

const LoadingIndicator = () => (
  <span
    className="inline-block h-3.5 w-3.5 rounded-full border-2 border-primary/30 border-t-primary motion-safe:animate-spin"
    aria-hidden="true"
  />
);

const PERMISSION_OPTIONS: ReadonlyArray<{
  value: ArtifactFileSharePermissionValue;
  labelKey: string;
}> = [
  {
    value: ArtifactFileSharePermission.Public,
    labelKey: 'htmlShareAccessModePublic',
  },
  {
    value: ArtifactFileSharePermission.Code,
    labelKey: 'artifactFileShareCodeAccess',
  },
  {
    value: ArtifactFileSharePermission.Stopped,
    labelKey: 'artifactFileShareStopAccess',
  },
];

const ArtifactFileShareDialog = ({
  artifact,
  phase,
  operation,
  intent,
  committedPermission,
  selectedPermission,
  isPermissionDirty,
  stoppedNotice,
  isPermissionLocked = false,
  message,
  error,
  shareCodeUnavailable = false,
  accessExpiresAt,
  ownerAccountKey,
  subscriptionStatus,
  recoveryMode,
  recoveryAnalyticsContext,
  recoveryExposureKey,
  canRetry,
  canCreate,
  canSubmitPermission,
  canCopy,
  showUpdateFile = true,
  canUpdateFile,
  copyStatus,
  updateStatus,
  closeButtonRef,
  onClose,
  onRetry,
  onPermissionChange,
  onCreate,
  onSubmitPermission,
  onUpdateFile,
  onCopy,
  onRecoveryExposure,
  onRecoveryClick,
}: ArtifactFileShareDialogProps) => {
  const trialStatus = usePublishingTrialStatus(accessExpiresAt);
  const isPreparing = phase === ArtifactFileSharePhase.Preparing;
  const isReady = phase === ArtifactFileSharePhase.Ready;
  const isCreating = operation === ArtifactFileShareOperation.Creating;
  const isPermissionUpdating = operation === ArtifactFileShareOperation.Permission;
  const isUpdatingFile = operation === ArtifactFileShareOperation.UpdateFile;
  const permissionDisabled =
    !isReady || Boolean(operation) || isPermissionLocked || trialStatus.isExpired;
  const displayedPermission = trialStatus.isExpired
    ? ArtifactFileSharePermission.Stopped
    : selectedPermission;
  const primaryAction = getArtifactFileSharePrimaryAction(
    intent,
    isReady,
    isPermissionDirty,
  );
  const copyButtonLabel =
    copyStatus === ArtifactFileShareCopyStatus.Copied
      ? t('copied')
      : copyStatus === ArtifactFileShareCopyStatus.Failed
        ? t('copyFailed')
        : t('htmlShareCopyLink');
  const updateButtonLabel = isUpdatingFile
    ? t('htmlShareUpdatingFile')
    : updateStatus === ArtifactFileShareUpdateStatus.Updated
      ? t('htmlShareUpdateComplete')
      : t('htmlShareUpdateFile');
  const showSubscriptionRecovery = Boolean(
    isReady
    && intent === ArtifactFileShareIntent.Manage
    && recoveryMode
    && onRecoveryClick
    && shouldShowPublishingSubscriptionRecovery({
      ownerAccountKey,
      subscriptionStatus,
      recoveryMode,
      isExpired: trialStatus.isExpired,
      isAvailable: !trialStatus.isExpired
        && committedPermission !== ArtifactFileSharePermission.Stopped,
    }),
  );
  usePublishingRecoveryExposureLifecycle(
    recoveryAnalyticsContext,
    showSubscriptionRecovery,
  );
  const footerActions = getPublishingRecoveryFooterActions({
    showRecovery: showSubscriptionRecovery,
    canCopy: canCopy && !operation,
    showCopyInStandardFooter: primaryAction === ArtifactFileSharePrimaryAction.Copy,
  });
  const copyActionClassName = footerActions.showRecovery
    ? 'border border-border bg-background text-secondary hover:bg-surface hover:text-foreground'
    : copyStatus === ArtifactFileShareCopyStatus.Failed
      ? 'bg-red-500 text-white hover:bg-red-500/90'
      : 'bg-primary text-primary-foreground hover:bg-primary-hover';

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/35 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-busy={isPreparing || Boolean(operation)}
        aria-labelledby="artifact-file-share-dialog-title"
        aria-describedby="artifact-file-share-dialog-description"
        className="relative w-full max-w-[440px] rounded-2xl bg-background p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h2
              id="artifact-file-share-dialog-title"
              className="text-lg font-semibold leading-7 text-foreground"
            >
              {t('htmlShare')}
            </h2>
            <PublishingTrialStatus status={trialStatus} />
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            disabled={Boolean(operation)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={t('close')}
            title={t('close')}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="mt-3 rounded-xl bg-surface px-3 py-3">
          <ArtifactPreviewIdentity artifact={artifact} />
        </div>

        <div className="mt-5">
          <div className="flex min-h-5 items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              {t('artifactFileShareAccessPermission')}
            </h3>
            {(trialStatus.isExpired || stoppedNotice) && (
              <span className="text-xs font-medium text-red-500" role="status">
                {trialStatus.isExpired ? t('htmlShareStoppedNotice') : stoppedNotice}
              </span>
            )}
          </div>

          <div
            className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3"
            role="radiogroup"
            aria-label={t('artifactFileShareAccessPermission')}
          >
            {PERMISSION_OPTIONS.map(option => {
              const isSelected = displayedPermission === option.value;
              const isPending = isPermissionUpdating && displayedPermission === option.value;
              const isOptionDisabled =
                permissionDisabled ||
                isArtifactFileSharePermissionOptionDisabled(intent, option.value);
              return (
                <label
                  key={option.value}
                  className={`inline-flex min-h-10 items-center gap-2 text-sm transition-colors ${
                    isOptionDisabled
                      ? 'cursor-not-allowed text-muted'
                      : 'cursor-pointer text-foreground'
                  }`}
                >
                  <input
                    type="radio"
                    name="artifact-file-share-permission"
                    value={option.value}
                    checked={isSelected}
                    disabled={isOptionDisabled}
                    onChange={() => onPermissionChange(option.value)}
                    className="h-4 w-4 accent-primary"
                  />
                  <span>{t(option.labelKey)}</span>
                  {isPending && <LoadingIndicator />}
                </label>
              );
            })}
          </div>

          <div
            id="artifact-file-share-dialog-description"
            className="mt-3 min-h-5 text-xs leading-5 text-muted"
          >
            {isPreparing && (
              <span className="inline-flex items-center gap-2" role="status">
                <LoadingIndicator />
                {message || t('artifactFileSharePreparing')}
              </span>
            )}
            {!isPreparing && isPermissionUpdating && !error && (
              <span role="status">{t('htmlShareAccessModeUpdating')}</span>
            )}
            {!isPreparing && isCreating && !error && (
              <span role="status">{t('artifactFileShareCreating')}</span>
            )}
            {!isPreparing && error && (
              <span className="text-red-500" role="alert">
                {error}
              </span>
            )}
            {!isPreparing && !error && !isPermissionUpdating && !isCreating && message && (
              <span role="status">{message}</span>
            )}
            {!isPreparing && !error && !message && shareCodeUnavailable && (
              <span>{t('htmlShareCodeUnavailable')}</span>
            )}
          </div>
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-end gap-3">
          {footerActions.showStandardActions
            && phase === ArtifactFileSharePhase.Error && canRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex h-10 min-w-[88px] items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
              >
                {t('artifactFileShareRetry')}
              </button>
            )}
          {footerActions.showStandardActions
            && isReady && intent === ArtifactFileShareIntent.Manage && showUpdateFile && (
              <button
                type="button"
                onClick={onUpdateFile}
                disabled={!canUpdateFile || Boolean(operation) || trialStatus.isExpired}
                title={
                  committedPermission === ArtifactFileSharePermission.Stopped
                    ? t('htmlShareDisabledCannotUpdate')
                    : undefined
                }
                className="inline-flex h-10 min-w-[96px] items-center justify-center rounded-lg border border-border bg-background px-4 text-sm font-medium text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {updateButtonLabel}
              </button>
            )}
          {footerActions.showStandardActions
            && primaryAction === ArtifactFileSharePrimaryAction.Create && (
              <button
                type="button"
                onClick={onCreate}
                disabled={!canCreate || Boolean(operation)}
                className="inline-flex h-10 min-w-[104px] items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isCreating
                  ? t('artifactFileShareCreating')
                  : t('artifactFileShareCreateAction')}
              </button>
            )}
          {footerActions.showStandardActions
            && primaryAction === ArtifactFileSharePrimaryAction.UpdatePermission && (
              <button
                type="button"
                onClick={onSubmitPermission}
                disabled={!canSubmitPermission || Boolean(operation) || trialStatus.isExpired}
                className="inline-flex h-10 min-w-[128px] items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isPermissionUpdating
                  ? t('artifactFileSharePermissionUpdating')
                  : t('artifactFileShareUpdatePermissionAction')}
              </button>
            )}
          {footerActions.showCopy && (
            <button
              type="button"
              onClick={onCopy}
              disabled={footerActions.isCopyDisabled}
              className={`inline-flex h-10 min-w-[104px] items-center justify-center rounded-lg px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${copyActionClassName}`}
            >
              {copyButtonLabel}
            </button>
          )}
          {footerActions.showRecovery && recoveryMode && onRecoveryClick && (
            <PublishingSubscriptionRecoveryButton
              recoveryMode={recoveryMode}
              exposureKey={recoveryExposureKey}
              onExposure={onRecoveryExposure}
              onClick={onRecoveryClick}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default ArtifactFileShareDialog;
