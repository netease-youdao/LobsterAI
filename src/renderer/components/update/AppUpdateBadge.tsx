import React from 'react';

import { AppUpdateStatus, type AppUpdateStatus as AppUpdateStatusValue } from '../../../shared/appUpdate/constants';
import { i18nService } from '../../services/i18n';

interface AppUpdateBadgeProps {
  latestVersion: string;
  status: AppUpdateStatusValue;
  onClick: () => void;
}

const AppUpdateBadge: React.FC<AppUpdateBadgeProps> = ({ latestVersion, status, onClick }) => {
  const label = status === AppUpdateStatus.Ready
    ? i18nService.t('updateReadyPill')
    : status === AppUpdateStatus.Downloading
      ? i18nService.t('updateDownloadingPill')
      : status === AppUpdateStatus.Error
        ? i18nService.t('updateErrorPill')
        : i18nService.t('updateAvailablePill');

  return (
    <button
      type="button"
      onClick={onClick}
      className="non-draggable inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/12 px-3 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-500/18 dark:text-emerald-400 transition-colors whitespace-nowrap"
      title={`${label} ${latestVersion}`}
      aria-label={`${label} ${latestVersion}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
      <span>{label}</span>
    </button>
  );
};

export default AppUpdateBadge;
