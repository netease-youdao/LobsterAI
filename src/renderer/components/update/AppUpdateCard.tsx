import { ArrowPathIcon, ChevronDownIcon, ChevronUpIcon, ExclamationTriangleIcon, RocketLaunchIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useLayoutEffect, useState } from 'react';

import { type AppUpdateRuntimeState, AppUpdateStatus } from '../../../shared/appUpdate/constants';
import { i18nService } from '../../services/i18n';
import {
  clearUpdateCardCollapsedVersion,
  readUpdateCardCollapsedVersion,
  saveUpdateCardCollapsedVersion,
  shouldExpandUpdateCard,
} from './appUpdateCardState';
import { isAppUpdateReadyToInstall } from './appUpdateNoticeState';

interface AppUpdateCardProps {
  updateState: AppUpdateRuntimeState;
  onUpdate: () => Promise<void> | void;
  onShowDetails: () => void;
  /** Reports whether the full card (not the collapsed pill) is showing, so the
   * sidebar can yield the bottom promo slot to it. */
  onExpandedChange?: (expanded: boolean) => void;
}

const Spinner: React.FC<{ className?: string }> = ({ className = 'h-3.5 w-3.5' }) => (
  <svg className={`${className} animate-spin`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
  </svg>
);

const PingDot: React.FC<{ dotClassName: string }> = ({ dotClassName }) => (
  <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
    <span
      className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${dotClassName}`}
      style={{ animationDuration: '2.4s' }}
    />
    <span className={`relative inline-flex h-2 w-2 rounded-full ${dotClassName}`} />
  </span>
);

const logCollapsePreferenceFailure = (action: string, error: unknown): void => {
  console.warn(`[AppUpdateCard] failed to ${action}:`, error);
  try {
    window.electron?.log?.fromRenderer?.(
      'warn',
      'AppUpdateCard',
      `failed to ${action}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } catch {
    // Best-effort diagnostic only.
  }
};

/**
 * Sidebar notice for an update that needs the user: ready to restart, waiting
 * for a manual download, or failed. Downloads never show here — they run
 * silently and the card appears once the installer is verified.
 */
const AppUpdateCard: React.FC<AppUpdateCardProps> = ({
  updateState,
  onUpdate,
  onShowDetails,
  onExpandedChange,
}) => {
  // undefined = persisted collapse state still loading; render nothing to
  // avoid an expand/collapse flash on startup.
  const [collapsedVersion, setCollapsedVersion] = useState<string | null | undefined>(undefined);
  const [isActing, setIsActing] = useState(false);

  useEffect(() => {
    let isCurrent = true;
    void readUpdateCardCollapsedVersion()
      .then((version) => {
        if (isCurrent) setCollapsedVersion(version);
      })
      .catch((error) => {
        if (isCurrent) setCollapsedVersion(null);
        logCollapsePreferenceFailure('read collapsed update version', error);
      });
    return () => {
      isCurrent = false;
    };
  }, []);

  const updateInfo = updateState.info;
  const isExpanded = collapsedVersion !== undefined
    && updateInfo != null
    && shouldExpandUpdateCard(collapsedVersion, updateInfo.latestVersion);

  // The sidebar banner shares this bottom slot. Sync before paint so expanding
  // the card never renders a frame with both elements competing for space.
  useLayoutEffect(() => {
    onExpandedChange?.(isExpanded);
    return () => onExpandedChange?.(false);
  }, [isExpanded, onExpandedChange]);

  if (!updateInfo || collapsedVersion === undefined) return null;

  const { latestVersion, changeLog } = updateInfo;
  const isInstalling = updateState.status === AppUpdateStatus.Installing;
  const isError = updateState.status === AppUpdateStatus.Error;
  // A routine re-check keeps the verified installer but cannot launch it yet.
  const isChecking = updateState.status === AppUpdateStatus.Checking;
  const isReady = isAppUpdateReadyToInstall(updateState);

  const lang = i18nService.getLanguage();
  const currentLog = changeLog?.[lang];
  const highlights = (currentLog?.content ?? []).filter((item) => item.trim().length > 0).slice(0, 2);

  const title = isReady || isInstalling
    ? i18nService.t('updateReadyCardTitle')
    : isError
      ? i18nService.t('updateErrorPill')
      : i18nService.t('updateCardTitle');

  const handleExpand = () => {
    setCollapsedVersion(null);
    void clearUpdateCardCollapsedVersion().catch((error) => {
      logCollapsePreferenceFailure('clear collapsed update version', error);
    });
  };

  const handleCollapse = () => {
    setCollapsedVersion(latestVersion);
    void saveUpdateCardCollapsedVersion(latestVersion).catch((error) => {
      logCollapsePreferenceFailure('save collapsed update version', error);
    });
  };

  const handlePrimary = async () => {
    if (isActing) return;
    setIsActing(true);
    try {
      await onUpdate();
    } finally {
      setIsActing(false);
    }
  };

  if (!isExpanded) {
    const pillLabel = isInstalling ? i18nService.t('updateInstallingShort') : title;
    const pillTone = isReady || isInstalling
      ? 'border-emerald-500/25 bg-emerald-500/[0.07] hover:bg-emerald-500/[0.12]'
      : isError
        ? 'border-red-500/25 bg-red-500/[0.06] hover:bg-red-500/[0.1]'
        : 'border-primary/20 bg-primary/[0.06] hover:bg-primary/[0.1]';
    const pillDot = isReady || isInstalling
      ? 'bg-emerald-500'
      : isError
        ? 'bg-red-500'
        : 'bg-primary';

    return (
      <button
        type="button"
        onClick={handleExpand}
        className={`non-draggable flex h-8 w-full items-center gap-2 rounded-lg border px-2.5 text-xs font-medium text-foreground transition-colors ${pillTone}`}
        aria-label={`${pillLabel} v${latestVersion}`}
        title={`${pillLabel} v${latestVersion}`}
      >
        <PingDot dotClassName={pillDot} />
        <span className="truncate">{pillLabel}</span>
        {!isInstalling && (
          <span className="shrink-0 text-secondary">v{latestVersion}</span>
        )}
        <ChevronUpIcon className="ml-auto h-3.5 w-3.5 shrink-0 text-secondary" aria-hidden="true" />
      </button>
    );
  }

  const cardTone = isReady || isInstalling
    ? 'border-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.10] via-emerald-500/[0.04] to-transparent'
    : isError
      ? 'border-red-500/20 bg-gradient-to-br from-red-500/[0.07] via-red-500/[0.03] to-transparent'
      : 'border-primary/15 bg-gradient-to-br from-primary/[0.09] via-primary/[0.04] to-transparent';
  const iconTone = isReady || isInstalling
    ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
    : isError
      ? 'bg-red-500/10 text-red-500'
      : 'bg-primary/12 text-primary';
  const Icon = isReady || isInstalling ? ArrowPathIcon : isError ? ExclamationTriangleIcon : RocketLaunchIcon;

  return (
    <section
      className={`non-draggable animate-fade-in-up rounded-xl border p-3 shadow-card ${cardTone}`}
      aria-label={`${title} v${latestVersion}`}
    >
      <div className="flex items-start gap-1.5">
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${iconTone}`} aria-hidden="true">
          <Icon className="h-4 w-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
          <span className="min-w-0 break-words text-sm font-semibold leading-5 text-foreground">
            {title}
          </span>
          <span className="shrink-0 text-xs leading-4 text-secondary">v{latestVersion}</span>
        </div>
        <button
          type="button"
          onClick={handleCollapse}
          className="-mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.06]"
          aria-label={i18nService.t('collapse')}
          title={i18nService.t('collapse')}
        >
          <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {isError && updateState.errorMessage ? (
        <p className="mt-2 line-clamp-2 break-words text-xs text-secondary">{updateState.errorMessage}</p>
      ) : highlights.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {highlights.map((item, index) => (
            <li key={index} className="flex items-start gap-1.5 text-xs leading-4 text-secondary">
              <span className="mt-[7px] h-[3px] w-[3px] shrink-0 rounded-full bg-current opacity-60" aria-hidden="true" />
              <span className="line-clamp-1">{item}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <button
        type="button"
        onClick={() => void handlePrimary()}
        disabled={isActing || isInstalling || isChecking}
        className={`mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-sm font-medium text-white transition-all active:scale-[0.98] disabled:opacity-70 ${
          isReady || isInstalling
            ? 'bg-emerald-600 hover:bg-emerald-500'
            : 'bg-primary hover:bg-primary-hover'
        }`}
      >
        {(isActing || isInstalling) && <Spinner />}
        {isInstalling
          ? i18nService.t('updateInstallingShort')
          : isReady
            ? i18nService.t('updateRestartNow')
            : isError
              ? i18nService.t('updateRetry')
              : i18nService.t('updateAvailableConfirm')}
      </button>

      <button
        type="button"
        onClick={onShowDetails}
        className="mt-2 w-full text-center text-xs text-secondary transition-colors hover:text-foreground"
      >
        {i18nService.t('updateWhatsNew')}
      </button>
    </section>
  );
};

export default AppUpdateCard;
