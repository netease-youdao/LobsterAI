import { CheckIcon } from '@heroicons/react/24/outline';
import {
  getModelThinkingLevels,
  type ModelThinkingConfig,
  ModelThinkingLevel,
} from '@shared/providers/modelThinking';
import React, { useEffect, useRef } from 'react';

import { i18nService } from '../../services/i18n';

const THINKING_LEVEL_I18N_KEYS: Record<ModelThinkingLevel, string> = {
  [ModelThinkingLevel.Off]: 'modelThinkingLevelOff',
  [ModelThinkingLevel.Minimal]: 'modelThinkingLevelMinimal',
  [ModelThinkingLevel.Low]: 'modelThinkingLevelLow',
  [ModelThinkingLevel.Medium]: 'modelThinkingLevelMedium',
  [ModelThinkingLevel.High]: 'modelThinkingLevelHigh',
  [ModelThinkingLevel.XHigh]: 'modelThinkingLevelXHigh',
  [ModelThinkingLevel.Max]: 'modelThinkingLevelMax',
};

export const getModelThinkingLevelLabel = (level: ModelThinkingLevel): string => (
  i18nService.t(THINKING_LEVEL_I18N_KEYS[level])
);

interface ModelThinkingMenuProps {
  config: ModelThinkingConfig;
  selectedLevel: ModelThinkingLevel;
  onSelect: (level: ModelThinkingLevel) => void;
  onEscape: () => void;
}

const ModelThinkingMenu: React.FC<ModelThinkingMenuProps> = ({
  config,
  selectedLevel,
  onSelect,
  onEscape,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const levels = getModelThinkingLevels(config);
  const supportsOff = levels.includes(ModelThinkingLevel.Off);
  const enabledLevels = levels.filter(level => level !== ModelThinkingLevel.Off);
  const thinkingEnabled = selectedLevel !== ModelThinkingLevel.Off;
  const enabledFallback = config.defaultLevel !== ModelThinkingLevel.Off
    ? config.defaultLevel
    : enabledLevels[0];

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const selected = menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
      const first = menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
      (selected ?? first)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={i18nService.t('modelThinkingStrength')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onEscape();
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const items = Array.from(
          menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
        );
        if (items.length === 0) return;
        event.preventDefault();
        const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
        const nextIndex = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : event.key === 'ArrowDown'
              ? (currentIndex + 1 + items.length) % items.length
              : (currentIndex - 1 + items.length) % items.length;
        items[nextIndex]?.focus();
      }}
      className="overflow-hidden rounded-xl border border-border bg-surface shadow-popover"
    >
      {supportsOff && (
        <button
          type="button"
          role="switch"
          aria-checked={thinkingEnabled}
          onClick={() => {
            if (thinkingEnabled) {
              onSelect(ModelThinkingLevel.Off);
            } else if (enabledFallback) {
              onSelect(enabledFallback);
            }
          }}
          // A switch row, not a menu item: the toggle carries the state, so it
          // never paints a hover background the way the strength options do.
          className="flex w-full items-center justify-between gap-3 border-b border-border/60 px-3 py-2.5 text-left text-[13px] font-medium leading-5 text-foreground"
        >
          <span>{i18nService.t('modelThinkingMode')}</span>
          <span
            aria-hidden="true"
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
              thinkingEnabled ? 'bg-emerald-500' : 'bg-border'
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                thinkingEnabled ? 'translate-x-[18px]' : 'translate-x-0.5'
              }`}
            />
          </span>
        </button>
      )}

      <div className="px-3 pb-0.5 pt-2 text-[11px] font-medium leading-4 text-secondary">
        {i18nService.t('modelThinkingStrength')}
      </div>
      <div className="p-1.5 pt-0.5">
        {enabledLevels.map(level => {
          const selected = selectedLevel === level;
          return (
            <button
              key={level}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              onClick={() => onSelect(level)}
              // The persistent selected fill stays lighter than the hover fill so
              // the pointer highlight always reads stronger than the current value.
              className={`flex h-8 w-full items-center justify-between gap-3 rounded-lg px-2.5 text-left text-[13px] leading-5 text-foreground transition-colors hover:bg-surface-raised ${
                selected ? 'bg-surface-raised/45 font-semibold' : ''
              }`}
            >
              <span className="min-w-0 truncate">{getModelThinkingLevelLabel(level)}</span>
              {selected && <CheckIcon className="h-4 w-4 shrink-0 text-emerald-500" strokeWidth={2.5} />}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default ModelThinkingMenu;
