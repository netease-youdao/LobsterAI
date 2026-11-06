import { ArrowRightIcon, ArrowsRightLeftIcon, InformationCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
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
  const previousName = displayName(change.previousModelRef, change.previousPresetId);
  const nextName = displayName(change.nextModelRef, change.nextPresetId);
  const label = i18nService.t('coworkModelChanged')
    .replace('{previous}', previousName)
    .replace('{next}', nextName);
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
          <Tooltip content={hint} position={TooltipPosition.Top} multiline maxWidth="20rem" disabled={showNotice}>
            <button type="button" className="flex shrink-0 items-center rounded-full hover:text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" aria-label={hint}>
              <InformationCircleIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </Tooltip>
          {showNotice && (
            // Floats over the empty space under the latest turn so showing and
            // hiding it never shifts the conversation.
            <div
              className="absolute left-1/2 top-full z-[60] mt-2 w-max max-w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2"
              role="status"
              aria-live="polite"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  onDismissNotice?.();
                }
              }}
            >
              <div className="relative flex items-start gap-2 rounded-lg border border-border bg-surface py-2 pl-2.5 pr-1.5 text-[12px] leading-5 text-foreground shadow-popover motion-safe:animate-fade-in-down">
                <InformationCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <p className="min-w-0 flex-1 text-left">{i18nService.t('coworkModelSwitchWarning')}</p>
                <button
                  type="button"
                  onClick={onDismissNotice}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                  aria-label={i18nService.t('close')}
                >
                  <XMarkIcon className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <span className="absolute -top-[5px] left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-l border-t border-border bg-surface" aria-hidden="true" />
              </div>
            </div>
          )}
        </div>
        <span className="h-px min-w-4 flex-1 bg-border-subtle" aria-hidden="true" />
      </div>
    </div>
  );
};

export default ModelChangeDivider;
