import React from 'react';

import { type AppUpdateRuntimeState, AppUpdateStatus } from '../../../shared/appUpdate/constants';
import { i18nService } from '../../services/i18n';
import { isAppUpdateReadyToInstall } from './appUpdateNoticeState';

interface AppUpdateBadgeProps {
  updateState: AppUpdateRuntimeState;
  onClick: () => void;
}

/**
 * Compact header pill used where the sidebar card has no room (collapsed
 * sidebar, Windows title bar). Downloads never show here; see
 * shouldShowAppUpdateNotice for when the badge is mounted at all.
 */
const AppUpdateBadge: React.FC<AppUpdateBadgeProps> = ({ updateState, onClick }) => {
  const updateInfo = updateState.info;
  if (!updateInfo) return null;

  const { latestVersion } = updateInfo;
  const isReady = isAppUpdateReadyToInstall(updateState);
  const isError = updateState.status === AppUpdateStatus.Error;

  const label = isReady
    ? i18nService.t('updateReadyPill')
    : isError
      ? i18nService.t('updateErrorPill')
      : i18nService.t('updateAvailablePill');

  const tone = isError
    ? 'border-destructive/30 hover:border-destructive/45'
    : 'border-border hover:border-border-input';
  const dotTone = isReady
    ? 'bg-emerald-500 ring-emerald-500/15'
    : isError
      ? 'bg-destructive ring-destructive/15'
      : 'bg-primary ring-primary/15';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`non-draggable inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border bg-surface/90 pl-2 pr-2.5 text-[length:var(--lobster-text-sidebarMeta)] font-medium text-foreground shadow-subtle transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 ${tone}`}
      title={`${label} v${latestVersion}`}
      aria-label={`${label} v${latestVersion}`}
    >
      <span
        className={`inline-flex h-1.5 w-1.5 shrink-0 rounded-full ring-[3px] ${dotTone}`}
        aria-hidden="true"
      />
      <span>{label}</span>
      {!isError && <span className="font-normal tabular-nums text-muted">v{latestVersion}</span>}
    </button>
  );
};

export default AppUpdateBadge;
