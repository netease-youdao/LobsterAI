import React from 'react';
import { i18nService } from '../../services/i18n';

interface AppUpdateBadgeProps {
  latestVersion: string;
  onClick: () => void;
}

const AppUpdateBadge: React.FC<AppUpdateBadgeProps> = ({ latestVersion, onClick }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className="non-draggable inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/12 px-3 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-500/18 dark:text-emerald-400 transition-colors whitespace-nowrap"
      title={`${i18nService.t('updateAvailablePill')} ${latestVersion}`}
      aria-label={`${i18nService.t('updateAvailablePill')} ${latestVersion}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
      <span>{i18nService.t('updateAvailablePill')}</span>
    </button>
  );
};

export default AppUpdateBadge;
