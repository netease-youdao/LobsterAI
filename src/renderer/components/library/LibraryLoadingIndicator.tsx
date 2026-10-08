import { ArrowPathIcon } from '@heroicons/react/24/outline';
import React from 'react';

import { i18nService } from '../../services/i18n';
import {
  type LibraryLoadingPresentation,
} from './libraryLoadingPresentation';

interface LibraryLoadingIndicatorProps {
  label: string;
  announce?: boolean;
  className?: string;
  showIcon?: boolean;
  showLabel?: boolean;
}

export const LibraryLoadingIndicator: React.FC<LibraryLoadingIndicatorProps> = ({
  label,
  announce = false,
  className = '',
  showIcon = true,
  showLabel = false,
}) => (
  <span
    {...(announce ? { role: 'status', 'aria-live': 'polite' as const } : {})}
    className={`inline-flex min-w-0 items-center gap-1.5 text-tertiary ${className}`}
  >
    {showIcon && (
      <ArrowPathIcon
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin"
      />
    )}
    {showLabel ? (
      <span className="truncate text-xs">{label}</span>
    ) : announce ? (
      <span className="sr-only">{label}</span>
    ) : null}
  </span>
);

export const LibraryToolbarLoadingStatus: React.FC<{
  presentation: LibraryLoadingPresentation;
}> = ({ presentation }) => {
  const label = presentation.showSearchActivity
    ? i18nService.t('librarySearching')
    : presentation.showManualRefreshActivity
      ? i18nService.t('libraryRefreshing')
      : i18nService.t('libraryUpdating');
  const showFilterSpinner = presentation.showFilterActivity;
  const showLongWaitLabel = presentation.showLongWaitLabel
    && (
      presentation.showSearchActivity
      || presentation.showFilterActivity
      || presentation.showManualRefreshActivity
    );

  return (
    <div className="flex h-5 w-4 shrink-0 items-center sm:w-20">
      {(showFilterSpinner || showLongWaitLabel) && (
        <LibraryLoadingIndicator
          label={label}
          announce={showLongWaitLabel}
          showIcon={showFilterSpinner}
          showLabel={showLongWaitLabel}
        />
      )}
      {presentation.announceCompletion && (
        <span role="status" aria-live="polite" className="sr-only">
          {i18nService.t('libraryResultsUpdated')}
        </span>
      )}
    </div>
  );
};
