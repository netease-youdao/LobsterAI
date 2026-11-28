import { CheckIcon, ChevronRightIcon, CpuChipIcon, LockClosedIcon } from '@heroicons/react/24/outline';
import React from 'react';

import type { DshAgentPresetInfo } from '@/services/dshHost';
import { i18nService } from '@/services/i18n';

import { DEFAULT_DSH_AGENT_PRESET_ID } from '../../../shared/dshEngine/hostConstants';
import {
  PROMPT_MENU_ROW_CLASS,
  PROMPT_SUBMENU_POSITION_CLASS,
  type PromptMenuItemControl,
} from '../common/promptSubmenu';
import XMarkIcon from '../icons/XMarkIcon';
import Tooltip, { TooltipPosition } from '../ui/Tooltip';
import {
  getUsableDshAgentPresets,
  isBuiltinDeveloperDshAgentPreset,
  resolveDshAgentPresetCopy,
  resolveEffectiveDshAgentPresetId,
  shouldShowLockedDshAgentPresetBadge,
} from './dshAgentPresetViewModel';

export interface DshAgentPresetOptionListProps {
  presets: readonly DshAgentPresetInfo[];
  selectedId: string;
  onSelect: (presetId: string) => void;
  showHeader?: boolean;
  maxHeightClassName?: string;
}

export const DshAgentPresetOptionList: React.FC<DshAgentPresetOptionListProps> = ({
  presets,
  selectedId,
  onSelect,
  showHeader = false,
  maxHeightClassName = 'max-h-96',
}) => {
  const t = (key: string) => i18nService.t(key);

  return (
    <>
      {showHeader && (
        <div className="px-3 py-1.5 text-[11px] font-medium text-secondary">
          {t('dshAgentPresetLabel')}
        </div>
      )}
      <div className={`${maxHeightClassName} overflow-y-auto p-1`}>
        {presets.map((preset) => {
          const selected = preset.id === selectedId;
          const copy = resolveDshAgentPresetCopy(preset.id, presets, t);
          const isDefault = preset.id === DEFAULT_DSH_AGENT_PRESET_ID;
          const isBuiltin = !isDefault && isBuiltinDeveloperDshAgentPreset(preset.id);
          return (
            <button
              key={preset.id}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              onClick={() => onSelect(preset.id)}
              className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                selected ? 'bg-surface-raised text-foreground' : 'text-foreground hover:bg-surface-raised'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium leading-5 text-foreground">
                    {copy.name}
                  </span>
                  {isDefault && (
                    <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] leading-none text-secondary">
                      {t('dshAgentPresetDefaultTag')}
                    </span>
                  )}
                  {isBuiltin && (
                    <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] leading-none text-secondary">
                      {t('dshAgentPresetBuiltinTag')}
                    </span>
                  )}
                </div>
                {copy.description && (
                  <p className="mt-0.5 text-xs leading-[18px] text-secondary">
                    {copy.description}
                  </p>
                )}
              </div>
              <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center">
                {selected && <CheckIcon className="h-4 w-4 text-primary" strokeWidth={2.2} />}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
};

export interface DshAgentPresetMenuItemProps {
  value?: string | null;
  presets: readonly DshAgentPresetInfo[];
  onSelect: (presetId: string) => void;
  disabled?: boolean;
  menuItem: PromptMenuItemControl;
}

export const DshAgentPresetMenuItem: React.FC<DshAgentPresetMenuItemProps> = ({
  value,
  presets,
  onSelect,
  disabled = false,
  menuItem,
}) => {
  const visiblePresets = getUsableDshAgentPresets(presets);
  const hasSelectable = visiblePresets.some(
    (preset) => preset.id.trim() !== DEFAULT_DSH_AGENT_PRESET_ID,
  );
  if (!hasSelectable) return null;

  const effectiveId = resolveEffectiveDshAgentPresetId(value, visiblePresets);
  const isCustomPreset = effectiveId !== DEFAULT_DSH_AGENT_PRESET_ID;
  const openSubmenu = () => {
    if (!disabled) menuItem.onOpenChange(true);
  };

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={openSubmenu}
        onMouseEnter={openSubmenu}
        onFocus={openSubmenu}
        className={`${PROMPT_MENU_ROW_CLASS} ${menuItem.open ? 'bg-surface-raised' : 'hover:bg-surface-raised'}`}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={menuItem.open}
      >
        <CpuChipIcon className="h-5 w-5 shrink-0 text-secondary" />
        <span className="min-w-0 flex-1 truncate">{i18nService.t('dshAgentPresetMenuItem')}</span>
        {isCustomPreset && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
            aria-hidden="true"
          />
        )}
        <ChevronRightIcon className="h-4 w-4 shrink-0 text-secondary" />
      </button>

      {menuItem.open && (
        <div
          role="menu"
          aria-label={i18nService.t('dshAgentPresetLabel')}
          className={`${PROMPT_SUBMENU_POSITION_CLASS[menuItem.side]} z-[60] w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-popover`}
        >
          <DshAgentPresetOptionList
            presets={visiblePresets}
            selectedId={effectiveId}
            onSelect={onSelect}
            showHeader
          />
        </div>
      )}
    </>
  );
};

export interface DshAgentPresetPillProps {
  mode: 'active-pill' | 'locked';
  value?: string | null;
  presets: readonly DshAgentPresetInfo[];
  enabled?: boolean;
  disabled?: boolean;
  compact?: boolean;
  onOpenPicker?: () => void;
  onReset?: () => void;
}

export const DshAgentPresetPill: React.FC<DshAgentPresetPillProps> = ({
  mode,
  value,
  presets,
  enabled = false,
  disabled = false,
  compact = false,
  onOpenPicker,
  onReset,
}) => {
  const t = (key: string) => i18nService.t(key);

  if (mode === 'locked') {
    if (!shouldShowLockedDshAgentPresetBadge(value)) return null;
    const { name: label } = resolveDshAgentPresetCopy(value, presets, t);
    return (
      <Tooltip
        content={t('dshAgentPresetLockedHint')}
        position={TooltipPosition.Top}
        delay={250}
      >
        <span
          className="inline-flex h-7 max-w-[140px] shrink-0 items-center gap-1 rounded-lg bg-surface-raised px-2 text-xs text-secondary"
          aria-label={`${t('dshAgentPresetLabel')}: ${label}`}
        >
          <LockClosedIcon className="h-3 w-3 shrink-0" />
          <span className="truncate">{label}</span>
        </span>
      </Tooltip>
    );
  }

  if (!enabled || !shouldShowLockedDshAgentPresetBadge(value)) {
    return null;
  }

  const { name: label } = resolveDshAgentPresetCopy(value, presets, t);

  return (
    <div
      data-dsh-agent-preset-pill="true"
      className={`inline-flex h-7 min-w-0 ${compact ? 'max-w-[116px]' : 'max-w-[168px]'} shrink-0 items-center overflow-hidden rounded-lg border border-border/80 bg-surface-raised/70 text-xs text-foreground transition-colors hover:bg-surface-raised`}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onOpenPicker}
        className="flex min-w-0 flex-1 items-center gap-1 py-1 pl-2 pr-1 text-left transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        title={`${t('dshAgentPresetLabel')}: ${label}`}
        aria-label={`${t('dshAgentPresetLabel')}: ${label}`}
      >
        <CpuChipIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {onReset && (
        <button
          type="button"
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onReset();
          }}
          className="flex h-full shrink-0 items-center justify-center rounded-r-lg px-1 text-secondary transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          title={t('dshAgentPresetResetTooltip')}
          aria-label={t('dshAgentPresetResetTooltip')}
        >
          <XMarkIcon className="h-3 w-3" />
        </button>
      )}
    </div>
  );
};

export default DshAgentPresetPill;
