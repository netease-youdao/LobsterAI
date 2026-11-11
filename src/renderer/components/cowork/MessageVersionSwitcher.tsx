import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import React from 'react';

import type { CoworkMessageVersionInfo } from '../../../shared/cowork/messageEdit';
import { i18nService } from '../../services/i18n';

const BUTTON_CLASS = 'rounded-md p-1 transition-colors hover:bg-surface-raised disabled:opacity-40 disabled:hover:bg-transparent';

/** Steps between the versions an edit left behind at one user message. */
const MessageVersionSwitcher: React.FC<{
  info: CoworkMessageVersionInfo;
  disabled?: boolean;
  onSwitch: (targetIndex: number) => void;
}> = ({ info, disabled, onSwitch }) => {
  const step = (targetIndex: number) => (event: React.MouseEvent) => {
    event.stopPropagation();
    onSwitch(targetIndex);
  };
  return (
    <div className="mt-1 inline-flex shrink-0 items-center gap-0.5 text-[11px] text-zinc-400 dark:text-zinc-500 select-none">
      <button type="button" className={BUTTON_CLASS} disabled={disabled || info.index <= 1}
        title={i18nService.t('coworkVersionPrevious')} aria-label={i18nService.t('coworkVersionPrevious')}
        onClick={step(info.index - 1)}>
        <ChevronLeftIcon className="h-3.5 w-3.5" />
      </button>
      <span className="tabular-nums">{info.index}/{info.count}</span>
      <button type="button" className={BUTTON_CLASS} disabled={disabled || info.index >= info.count}
        title={i18nService.t('coworkVersionNext')} aria-label={i18nService.t('coworkVersionNext')}
        onClick={step(info.index + 1)}>
        <ChevronRightIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};

export default MessageVersionSwitcher;
