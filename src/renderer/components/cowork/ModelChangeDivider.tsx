import { InformationCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React from 'react';
import { useSelector } from 'react-redux';

import type { CoworkModelChange } from '../../../shared/cowork/modelChange';
import type { ModelPresetId } from '../../../shared/modelPresets/constants';
import { i18nService } from '../../services/i18n';
import { modelPresetName } from '../../services/modelPresets';
import type { RootState } from '../../store';
import { matchesOpenClawModelRef } from '../../utils/openclawModelRef';
import Tooltip, { TooltipPosition } from '../ui/Tooltip';

const ModelChangeDivider: React.FC<{
  change: CoworkModelChange;
  showNotice?: boolean;
  onDismissNotice?: () => void;
}> = ({ change, showNotice = false, onDismissNotice }) => {
  const models = useSelector((state: RootState) => state.model.availableModels);
  const displayName = (modelRef: string, presetId?: ModelPresetId | null): string => {
    if (presetId) return modelPresetName(presetId);
    const model = models.find(candidate => !candidate.presetId && matchesOpenClawModelRef(modelRef, candidate));
    return model?.name ?? (modelRef.includes('/') ? modelRef.slice(modelRef.indexOf('/') + 1) : modelRef);
  };
  const label = i18nService.t('coworkModelChanged')
    .replace('{previous}', displayName(change.previousModelRef, change.previousPresetId))
    .replace('{next}', displayName(change.nextModelRef, change.nextPresetId));
  const hint = i18nService.t('coworkModelSwitchHint');

  return (
    <div className={`relative ${showNotice ? 'pb-2' : 'py-2'} text-xs text-muted`}>
      {showNotice && (
        <div
          className="mx-auto mb-3 w-max max-w-full"
          role="status"
          aria-live="polite"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              onDismissNotice?.();
            }
          }}
        >
          <div className="relative rounded-xl border border-border bg-surface p-3.5 shadow-elevated motion-safe:animate-fade-in">
            <div className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-muted text-primary" aria-hidden="true">
                <InformationCircleIcon className="h-[18px] w-[18px]" />
              </span>
              <p className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-left text-[13px] font-normal leading-[22px] text-foreground/85">
                {i18nService.t('coworkModelSwitchWarning')}
              </p>
              <button
                type="button"
                onClick={onDismissNotice}
                className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                aria-label={i18nService.t('close')}
              >
                <XMarkIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
            <span className="absolute -bottom-[5px] left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-b border-r border-border bg-surface" aria-hidden="true" />
          </div>
        </div>
      )}
      <div className="flex items-center gap-3" role="status">
        <span className="h-px min-w-4 flex-1 bg-border-subtle" aria-hidden="true" />
        <div className="flex min-w-0 max-w-[80%] items-center gap-1.5">
          <span className="min-w-0 break-words text-center leading-5">{label}</span>
          <Tooltip content={hint} position={TooltipPosition.Top} multiline maxWidth="20rem" disabled={showNotice}>
            <button type="button" className="flex shrink-0 items-center rounded-full hover:text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" aria-label={hint}>
              <InformationCircleIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
        <span className="h-px min-w-4 flex-1 bg-border-subtle" aria-hidden="true" />
      </div>
    </div>
  );
};

export default ModelChangeDivider;
