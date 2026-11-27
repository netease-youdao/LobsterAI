import { ArrowRightIcon, ArrowsRightLeftIcon, InformationCircleIcon } from '@heroicons/react/24/outline';
import React from 'react';
import { useSelector } from 'react-redux';

import type { CoworkModelChange } from '../../../shared/cowork/modelChange';
import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';
import Tooltip, { TooltipPosition } from '../ui/Tooltip';
import { resolveModelChangeDisplayName } from './modelSwitchConfirm';

const ModelChangeDivider: React.FC<{
  change: CoworkModelChange;
}> = ({ change }) => {
  const models = useSelector((state: RootState) => state.model.availableModels);
  const previousName = resolveModelChangeDisplayName(change.previousModelRef, models, change.previousPresetId);
  const nextName = resolveModelChangeDisplayName(change.nextModelRef, models, change.nextPresetId);
  const label = i18nService.t('coworkModelChanged')
    .replace('{previous}', () => previousName)
    .replace('{next}', () => nextName);
  const hint = i18nService.t('coworkModelSwitchHint');

  return (
    <div className="py-2 text-xs text-muted">
      <div className="flex items-center gap-3">
        <span className="h-px min-w-4 flex-1 bg-border-subtle" aria-hidden="true" />
        <div className="relative flex min-w-0 max-w-[85%] items-center gap-1.5 leading-5">
          <span className="sr-only" role="status">{label}</span>
          <ArrowsRightLeftIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate" title={previousName} aria-hidden="true">{previousName}</span>
          <ArrowRightIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate font-medium text-secondary" title={nextName} aria-hidden="true">{nextName}</span>
          <Tooltip content={hint} position={TooltipPosition.Top} multiline maxWidth="20rem">
            <button type="button" className="flex shrink-0 items-center rounded-full hover:text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" aria-label={hint}>
              <InformationCircleIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
        <span className="h-px min-w-4 flex-1 bg-border-subtle" aria-hidden="true" />
      </div>
    </div>
  );
};

export default ModelChangeDivider;
