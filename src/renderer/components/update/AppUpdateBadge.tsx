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

  const tone = isReady
    ? 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-600 hover:bg-emerald-500/[0.14] dark:text-emerald-400'
    : isError
      ? 'border-red-500/30 bg-red-500/[0.07] text-red-500 hover:bg-red-500/[0.12]'
      : 'border-primary/25 bg-primary/[0.08] text-primary hover:bg-primary/[0.14]';
  const dotTone = isReady ? 'bg-emerald-500' : isError ? 'bg-red-500' : 'bg-primary';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`non-draggable inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border pl-2 pr-2.5 text-xs font-medium transition-colors ${tone}`}
      title={`${label} v${latestVersion}`}
      aria-label={`${label} v${latestVersion}`}
    >
      <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${dotTone}`}
          style={{ animationDuration: '2.4s' }}
        />
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${dotTone}`} />
      </span>
      <span>{label}</span>
      {!isError && <span className="opacity-70">v{latestVersion}</span>}
    </button>
  );
};

export default AppUpdateBadge;
