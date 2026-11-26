import { XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { MagnifyingGlassIcon, PlusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useMemo, useState } from 'react';

import { type DiscoveredModel, ModelDiscoveryModality } from '../../../shared/providers';
import { i18nService } from '../../services/i18n';
import { computeDefaultSelectedModelIds } from '../../services/providerModelDiscovery';
import { formatCompactTokenCount, type Model } from './modelProviderUtils';
import { SETTINGS_META_TEXT } from './settingsTypography';

const ModelDiscoveryFilterTab = {
  All: 'all',
  Selected: 'selected',
} as const;
type ModelDiscoveryFilterTab = typeof ModelDiscoveryFilterTab[keyof typeof ModelDiscoveryFilterTab];

export interface ModelDiscoveryDialogProps {
  candidates: readonly DiscoveredModel[];
  currentModels: readonly Model[];
  onClose: () => void;
  onConfirm: (selectedIds: ReadonlySet<string>) => void;
  onManualAdd?: (prefillModelId?: string) => void;
}

const ModelDiscoveryDialog: React.FC<ModelDiscoveryDialogProps> = ({
  candidates,
  currentModels,
  onClose,
  onConfirm,
  onManualAdd,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTab, setFilterTab] = useState<ModelDiscoveryFilterTab>(ModelDiscoveryFilterTab.All);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => computeDefaultSelectedModelIds(currentModels, candidates),
  );

  const trimmedQuery = searchQuery.trim();
  const normalizedQuery = trimmedQuery.toLowerCase();
  const visibleCandidates = useMemo(() => {
    return candidates.filter((candidate) => {
      if (filterTab === ModelDiscoveryFilterTab.Selected && !selectedIds.has(candidate.id)) {
        return false;
      }
      if (!normalizedQuery) return true;
      return candidate.id.toLowerCase().includes(normalizedQuery)
        || (candidate.name?.toLowerCase().includes(normalizedQuery) ?? false);
    });
  }, [candidates, filterTab, normalizedQuery, selectedIds]);

  const allVisibleSelected = visibleCandidates.length > 0
    && visibleCandidates.every((candidate) => selectedIds.has(candidate.id));

  const toggleCandidate = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Only toggle candidates currently visible under the active filter/search so
  // configured models hidden by a search query are never deselected unseen.
  const toggleVisibleCandidates = () => {
    const shouldSelect = !allVisibleSelected;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const candidate of visibleCandidates) {
        if (shouldSelect) {
          next.add(candidate.id);
        } else {
          next.delete(candidate.id);
        }
      }
      return next;
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center rounded-2xl bg-background/90 px-4 py-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-discovery-dialog-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        className="flex max-h-full min-h-0 w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-modal"
      >
        <div className="flex shrink-0 items-center justify-between px-4 pt-4 pb-2">
          <h4 id="model-discovery-dialog-title" className="text-sm font-semibold text-foreground">
            {i18nService.t('fetchModelsDialogTitle')}
          </h4>
          <button
            type="button"
            onClick={onClose}
            aria-label={i18nService.t('close')}
            className="rounded-md p-1 text-secondary hover:bg-surface-raised hover:text-foreground"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="shrink-0 px-4 pb-3 space-y-2.5">
          <p className="text-xs leading-5 text-secondary">
            {i18nService.t('fetchModelsDialogDesc')}
          </p>
          <div className="relative">
            <MagnifyingGlassIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              autoFocus
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={i18nService.t('fetchModelsSearchPlaceholder')}
              aria-label={i18nService.t('fetchModelsSearchPlaceholder')}
              className="block w-full rounded-xl border border-border bg-surface-inset py-1.5 pl-8 pr-7 text-xs text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                title={i18nService.t('clear') || 'Clear'}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-secondary hover:text-primary transition-colors"
              >
                <XCircleIconSolid className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex rounded-lg bg-surface-inset p-0.5 border border-border-subtle">
              <button
                type="button"
                onClick={() => setFilterTab(ModelDiscoveryFilterTab.All)}
                className={`rounded-md px-2 py-0.5 ${SETTINGS_META_TEXT} font-medium transition-colors ${
                  filterTab === ModelDiscoveryFilterTab.All
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-secondary hover:text-foreground'
                }`}
              >
                {i18nService.t('fetchModelsFilterAll')} ({candidates.length})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab(ModelDiscoveryFilterTab.Selected)}
                className={`rounded-md px-2 py-0.5 ${SETTINGS_META_TEXT} font-medium transition-colors ${
                  filterTab === ModelDiscoveryFilterTab.Selected
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-secondary hover:text-foreground'
                }`}
              >
                {i18nService.t('fetchModelsFilterSelected')} ({selectedIds.size})
              </button>
            </div>
            <button
              type="button"
              disabled={visibleCandidates.length === 0}
              onClick={toggleVisibleCandidates}
              className={`shrink-0 rounded-lg px-2 py-1 ${SETTINGS_META_TEXT} font-medium text-secondary hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 transition-colors`}
            >
              {i18nService.t(allVisibleSelected ? 'fetchModelsDeselectAll' : 'fetchModelsSelectAll')}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 [scrollbar-gutter:stable]">
          {visibleCandidates.length === 0 ? (
            <div className="rounded-xl border border-border-subtle bg-surface px-3 py-6 text-center space-y-2">
              <p className="text-xs text-secondary">{i18nService.t('fetchModelsNoMatches')}</p>
              {onManualAdd && (
                <button
                  type="button"
                  onClick={() => onManualAdd(trimmedQuery || undefined)}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary-muted transition-colors"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  {trimmedQuery
                    ? i18nService.t('fetchModelsManualAddQuery').replace('{query}', trimmedQuery)
                    : i18nService.t('manualAddModel')}
                </button>
              )}
            </div>
          ) : (
            <ul className="space-y-1">
              {visibleCandidates.map((candidate) => {
                const checked = selectedIds.has(candidate.id);
                const showDisplayName = Boolean(
                  candidate.name && candidate.name.trim() && candidate.name.trim() !== candidate.id,
                );
                const supportsImage = candidate.inputModalities?.includes(ModelDiscoveryModality.Image);
                return (
                  <li key={candidate.id}>
                    <label
                      className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-2.5 py-2 transition-colors ${
                        checked
                          ? 'border-primary/40 bg-primary-muted/40'
                          : 'border-transparent bg-surface hover:border-border hover:bg-surface-raised'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleCandidate(candidate.id)}
                        className="h-3.5 w-3.5 shrink-0 rounded border-border accent-primary"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-xs text-foreground" title={candidate.id}>
                          {candidate.id}
                        </div>
                        {showDisplayName && (
                          <div className={`truncate ${SETTINGS_META_TEXT} text-secondary`} title={candidate.name}>
                            {candidate.name}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {candidate.contextWindow !== undefined && (
                          <span className={`${SETTINGS_META_TEXT} rounded-md bg-surface-raised px-1.5 py-0.5 text-secondary tabular-nums`}>
                            {formatCompactTokenCount(candidate.contextWindow)}
                          </span>
                        )}
                        {supportsImage && (
                          <span className={`${SETTINGS_META_TEXT} rounded-md bg-primary-muted px-1.5 py-0.5 text-primary`}>
                            {i18nService.t('imageInput')}
                          </span>
                        )}
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-background px-4 py-3">
          <span className={`${SETTINGS_META_TEXT} text-secondary tabular-nums`}>
            {i18nService.t('fetchModelsSelectedCount')
              .replace('{selected}', String(selectedIds.size))
              .replace('{total}', String(candidates.length))}
          </span>
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-raised transition-colors"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              disabled={currentModels.length === 0 && selectedIds.size === 0}
              onClick={() => onConfirm(selectedIds)}
              className="rounded-xl bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.98] transition-colors"
            >
              {i18nService.t('fetchModelsUpdateList')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ModelDiscoveryDialog;
