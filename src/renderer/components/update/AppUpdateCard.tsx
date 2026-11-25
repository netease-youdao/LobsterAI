import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useLayoutEffect, useState } from 'react';

import { type AppUpdateRuntimeState, AppUpdateStatus } from '../../../shared/appUpdate/constants';
import { i18nService } from '../../services/i18n';
import {
  clearUpdateCardCollapsedVersion,
  readUpdateCardCollapsedVersion,
  saveUpdateCardCollapsedVersion,
  shouldExpandUpdateCard,
} from './appUpdateCardState';
import { formatAppUpdateError } from './appUpdateErrorText';
import { isAppUpdateReadyToInstall } from './appUpdateNoticeState';

interface AppUpdateCardProps {
  updateState: AppUpdateRuntimeState;
  onUpdate: () => Promise<void> | void;
  onShowDetails: () => void;
  /** Reports whether the full card (not the collapsed pill) is showing, so the
   * sidebar can yield the bottom promo slot to it. */
  onExpandedChange?: (expanded: boolean) => void;
  /** Optional initial collapsed version for deterministic rendering in tests;
   * omitted in production so startup waits for the persisted value. */
  initialCollapsedVersion?: string | null;
}

const Spinner: React.FC<{ className?: string }> = ({ className = 'h-3.5 w-3.5' }) => (
  <svg
    className={`${className} shrink-0 animate-spin motion-reduce:animate-none`}
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3.5" />
    <path className="opacity-85" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
  </svg>
);

const StatusDot: React.FC<{ dotClassName: string; ringClassName: string }> = ({
  dotClassName,
  ringClassName,
}) => (
  <span
    className={`inline-flex h-1.5 w-1.5 shrink-0 rounded-full ring-[3px] ${dotClassName} ${ringClassName}`}
    aria-hidden="true"
  />
);

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

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
  initialCollapsedVersion,
}) => {
  // undefined = persisted collapse state still loading; render nothing to
  // avoid an expand/collapse flash on startup.
  const [collapsedVersion, setCollapsedVersion] = useState<string | null | undefined>(
    initialCollapsedVersion,
  );
  const [isActing, setIsActing] = useState(false);

  useEffect(() => {
    if (initialCollapsedVersion !== undefined) return undefined;
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
  }, [initialCollapsedVersion]);

  const updateInfo = updateState.info;
  const isExpanded = collapsedVersion !== undefined
    && updateInfo != null
    && shouldExpandUpdateCard(collapsedVersion, updateInfo.latestVersion);

  // The sidebar banner shares this bottom slot. Sync before paint so expanding
  // the card never renders a frame with both elements competing for space.
  useIsomorphicLayoutEffect(() => {
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
  const formattedError = updateState.errorMessage
    ? formatAppUpdateError(updateState.errorMessage)
    : null;

  const title = isReady || isInstalling
    ? i18nService.t('updateReadyCardTitle')
    : isError
      ? i18nService.t('updateErrorPill')
      : i18nService.t('updateCardTitle');

  const statusDot = isReady || isInstalling
    ? { dot: 'bg-emerald-500', ring: 'ring-emerald-500/15' }
    : isError
      ? { dot: 'bg-destructive', ring: 'ring-destructive/15' }
      : { dot: 'bg-primary', ring: 'ring-primary/15' };

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
    const pillTone = isError
      ? 'border-destructive/30 bg-surface/85 hover:border-destructive/45 hover:bg-surface'
      : 'border-border bg-surface/80 hover:border-border-input hover:bg-surface';

    return (
      <button
        type="button"
        onClick={handleExpand}
        className={`non-draggable group flex h-[34px] w-full items-center gap-2 rounded-[10px] border px-2.5 text-left text-[length:var(--lobster-text-sidebarCompact)] font-medium text-foreground transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 ${pillTone}`}
        aria-label={`${pillLabel} v${latestVersion}`}
        title={`${pillLabel} v${latestVersion}`}
      >
        {isInstalling ? (
          <Spinner className="h-3.5 w-3.5 text-secondary" />
        ) : (
          <StatusDot dotClassName={statusDot.dot} ringClassName={statusDot.ring} />
        )}
        <span className="min-w-0 truncate">{pillLabel}</span>
        {!isInstalling && (
          <span className="shrink-0 text-[length:var(--lobster-text-sidebarMeta)] font-normal tabular-nums text-muted">
            v{latestVersion}
          </span>
        )}
        <ChevronUpIcon
          className="ml-auto h-3.5 w-3.5 shrink-0 text-secondary/75 transition-colors group-hover:text-foreground"
          aria-hidden="true"
        />
      </button>
    );
  }

  const cardTone = isError
    ? 'border-destructive/30 bg-surface'
    : 'border-border bg-surface';

  const primaryLabel = isInstalling
    ? i18nService.t('updateInstallingShort')
    : isReady
      ? i18nService.t('updateRestartNow')
      : isError
        ? i18nService.t('updateRetry')
        : i18nService.t('updateAvailableConfirm');

  return (
    <section
      className={`non-draggable animate-fade-in-up motion-reduce:animate-none rounded-xl border p-3 shadow-subtle ${cardTone}`}
      aria-label={`${title} v${latestVersion}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {isInstalling ? (
            <Spinner className="h-3.5 w-3.5 text-secondary" />
          ) : (
            <StatusDot dotClassName={statusDot.dot} ringClassName={statusDot.ring} />
          )}
          <span className="min-w-0 truncate text-[length:var(--lobster-text-sidebarCompact)] font-medium leading-5 text-foreground">
            {title}
          </span>
        </div>
        <button
          type="button"
          onClick={handleCollapse}
          className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-[var(--lobster-sidebar-item-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
          aria-label={i18nService.t('collapse')}
          title={i18nService.t('collapse')}
        >
          <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      <button
        type="button"
        data-skin-button-plain="true"
        onClick={onShowDetails}
        aria-label={`${i18nService.t('updateWhatsNew')} v${latestVersion}`}
        className="group -ml-0.5 mt-0.5 inline-flex max-w-full items-center gap-1 rounded px-0.5 py-0.5 text-[length:var(--lobster-text-sidebarMeta)] leading-4 text-secondary transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
      >
        <span className="shrink-0 tabular-nums text-muted transition-colors group-hover:text-secondary">
          v{latestVersion}
        </span>
        <span className="shrink-0 text-muted/70" aria-hidden="true">·</span>
        <span className="truncate">{i18nService.t('updateReleaseNotesLabel')}</span>
        <ChevronRightIcon
          className="h-3 w-3 shrink-0 text-muted transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transform-none"
          aria-hidden="true"
        />
      </button>

      {isError && formattedError ? (
        <p className="mt-2 line-clamp-2 break-words text-[length:var(--lobster-text-sidebarMeta)] leading-[1.45] text-secondary">
          {formattedError}
        </p>
      ) : highlights.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {highlights.map((item, index) => (
            <li
              key={index}
              className="flex items-start gap-1.5 text-[length:var(--lobster-text-sidebarMeta)] leading-[1.45] text-secondary"
            >
              <span
                className="mt-[7px] h-[3px] w-[3px] shrink-0 rounded-full bg-muted"
                aria-hidden="true"
              />
              <span className="line-clamp-1">{item}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <button
        type="button"
        data-skin-button-solid="true"
        onClick={() => void handlePrimary()}
        disabled={isActing || isInstalling || isChecking}
        className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-foreground px-3 text-[13px] font-medium text-background transition-opacity duration-150 hover:opacity-90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-1 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-60"
      >
        {(isActing || isInstalling) && <Spinner className="h-3.5 w-3.5" />}
        <span className="truncate">{primaryLabel}</span>
      </button>
    </section>
  );
};

export default AppUpdateCard;
