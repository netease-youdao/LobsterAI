import { ArrowPathIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import React, { useState } from 'react';

import { authService } from '../services/auth';
import { i18nService } from '../services/i18n';
import { AccountConnectionState } from './accountConnectionState';
import Tooltip, { TooltipPosition } from './ui/Tooltip';

const messageKeys = {
  [AccountConnectionState.Restoring]: 'authRestoringSession',
  [AccountConnectionState.Unavailable]: 'authConnectionUnavailable',
  [AccountConnectionState.ModelsLoading]: 'modelSelectorLoading',
  [AccountConnectionState.ModelsUnavailable]: 'modelSelectorUnavailable',
} as const;

interface AccountConnectionNoticeProps {
  state: AccountConnectionState;
  className?: string;
  iconOnly?: boolean;
  disabled?: boolean;
}

export const AccountConnectionNotice: React.FC<AccountConnectionNoticeProps> = ({
  state,
  className = '',
  iconOnly = false,
  disabled = false,
}) => {
  const [retrying, setRetrying] = useState(false);
  const loading = state === AccountConnectionState.Restoring
    || state === AccountConnectionState.ModelsLoading;
  const busy = loading || retrying;
  const label = i18nService.t(retrying ? 'authConnectionRetrying' : messageKeys[state]);
  const retry = async () => {
    if (busy) return;
    setRetrying(true);
    try {
      await authService.recoverAccount();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Tooltip content={busy ? label : i18nService.t('authConnectionRetryHint')} position={TooltipPosition.Top}>
      <button
        type="button"
        disabled={disabled || busy}
        aria-busy={busy}
        aria-label={busy ? label : `${label}, ${i18nService.t('retry')}`}
        onClick={() => void retry()}
        className={`flex min-w-0 items-center gap-1.5 text-secondary transition-colors hover:text-foreground disabled:cursor-wait ${className}`}
      >
        {busy
          ? <ArrowPathIcon className="h-3.5 w-3.5 shrink-0 animate-spin" />
          : <ExclamationTriangleIcon className="h-3.5 w-3.5 shrink-0" />}
        <span className={iconOnly ? 'sr-only' : 'min-w-0 truncate'}>{label}</span>
        {!busy && !iconOnly && <span className="shrink-0 underline">{i18nService.t('retry')}</span>}
      </button>
    </Tooltip>
  );
};
