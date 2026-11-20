import {
  BoltIcon,
  CheckIcon,
  ChevronDownIcon,
  EyeIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  DEFAULT_DSH_PERMISSION_PRESET,
  DshPermissionPreset,
} from '../../../shared/dshEngine/hostConstants';
import {
  DSH_PERMISSION_PRESET_CHANGED_EVENT,
  dshHostService,
} from '../../services/dshHost';
import { i18nService } from '../../services/i18n';

interface PermissionModeSelectorProps {
  sessionId?: string | null;
  compact?: boolean;
  disabled?: boolean;
}

interface PresetOptionMeta {
  value: DshPermissionPreset;
  labelKey: string;
  descKey: string;
  Icon: React.ComponentType<{ className?: string }>;
  accentClass: string;
}

const PRESET_OPTIONS: readonly PresetOptionMeta[] = [
  {
    value: DshPermissionPreset.ReadOnly,
    labelKey: 'coworkPermissionModeReadOnly',
    descKey: 'coworkPermissionModeReadOnlyDesc',
    Icon: EyeIcon,
    accentClass: 'text-secondary',
  },
  {
    value: DshPermissionPreset.WorkspaceWrite,
    labelKey: 'coworkPermissionModeWorkspaceWrite',
    descKey: 'coworkPermissionModeWorkspaceWriteDesc',
    Icon: ShieldCheckIcon,
    accentClass: 'text-secondary',
  },
  {
    value: DshPermissionPreset.FullAccess,
    labelKey: 'coworkPermissionModeFullAccess',
    descKey: 'coworkPermissionModeFullAccessDesc',
    Icon: BoltIcon,
    accentClass: 'text-amber-600 dark:text-amber-400',
  },
];

const PermissionModeSelector: React.FC<PermissionModeSelectorProps> = ({
  sessionId,
  compact = false,
  disabled = false,
}) => {
  const [preset, setPreset] = useState<DshPermissionPreset>(DEFAULT_DSH_PERMISSION_PRESET);
  const [open, setOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void dshHostService.getPermissionPreset(sessionId || undefined).then((res) => {
      if (active) setPreset(res.preset);
    });
    return () => {
      active = false;
    };
  }, [sessionId]);

  useEffect(() => {
    const handlePresetChanged = (event: Event) => {
      const detail = (event as CustomEvent<{
        preset?: DshPermissionPreset;
        defaultPreset?: DshPermissionPreset;
        sessionId?: string;
      }>).detail;
      if (!detail) return;
      if (!detail.sessionId || detail.sessionId === sessionId) {
        if (detail.preset) setPreset(detail.preset);
      }
    };
    window.addEventListener(DSH_PERMISSION_PRESET_CHANGED_EVENT, handlePresetChanged);
    return () => {
      window.removeEventListener(DSH_PERMISSION_PRESET_CHANGED_EVENT, handlePresetChanged);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menuWidth = 288;
      const clampedLeft = Math.max(12, Math.min(rect.left, window.innerWidth - menuWidth - 12));
      setMenuPos({
        left: clampedLeft,
        bottom: window.innerHeight - rect.top + 8,
      });
    };
    updatePosition();

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target)
        || menuRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const currentOption = PRESET_OPTIONS.find((opt) => opt.value === preset) ?? PRESET_OPTIONS[1];
  const CurrentIcon = currentOption.Icon;

  const handleSelect = async (nextPreset: DshPermissionPreset) => {
    setOpen(false);
    if (nextPreset === preset || updating) return;
    setUpdating(true);
    try {
      // Update global default + apply live to all active sessions so the chosen
      // mode stays consistent across current and subsequent conversations.
      const res = await dshHostService.setPermissionPreset(nextPreset);
      if (res.ok) {
        setPreset(res.preset ?? nextPreset);
        const nextMeta = PRESET_OPTIONS.find((opt) => opt.value === nextPreset);
        if (nextMeta) {
          window.dispatchEvent(new CustomEvent('app:showToast', {
            detail: i18nService
              .t('coworkPermissionModeSwitchedToast')
              .replace('{mode}', i18nService.t(nextMeta.labelKey)),
          }));
        }
      }
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || updating}
        onClick={() => setOpen((prev) => !prev)}
        className={`flex items-center gap-1.5 rounded-lg transition-colors ${
          compact
            ? 'h-8 px-1.5 hover:bg-surface-raised'
            : 'h-7 px-2 hover:bg-background/80'
        } text-[13px] ${currentOption.accentClass} hover:text-foreground disabled:opacity-50 ${
          open ? (compact ? 'bg-surface-raised text-foreground' : 'bg-background/80 text-foreground') : ''
        }`}
        aria-label={`${i18nService.t('coworkPermissionModeLabel')}: ${i18nService.t(currentOption.labelKey)}`}
        aria-expanded={open}
        title={`${i18nService.t('coworkPermissionModeLabel')}: ${i18nService.t(currentOption.labelKey)}`}
      >
        <CurrentIcon className="h-4 w-4 shrink-0" />
        {!compact && (
          <>
            <span className="max-w-[110px] truncate text-xs">
              {i18nService.t(currentOption.labelKey)}
            </span>
            <ChevronDownIcon className="h-3.5 w-3.5 shrink-0" />
          </>
        )}
      </button>

      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          style={{ left: menuPos.left, bottom: menuPos.bottom }}
          className="fixed z-50 w-72 rounded-xl border border-border bg-surface p-1.5 shadow-lg"
          role="menu"
        >
          <div className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wider text-secondary">
            {i18nService.t('coworkPermissionModeLabel')}
          </div>
          {PRESET_OPTIONS.map((option) => {
            const OptionIcon = option.Icon;
            const selected = option.value === preset;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => void handleSelect(option.value)}
                className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                  selected
                    ? 'bg-primary/10 text-foreground'
                    : 'text-foreground hover:bg-surface-raised'
                }`}
              >
                <OptionIcon className={`mt-0.5 h-4 w-4 shrink-0 ${selected ? 'text-primary' : option.accentClass}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">
                      {i18nService.t(option.labelKey)}
                    </span>
                    {selected && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-primary" />}
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-secondary">
                    {i18nService.t(option.descKey)}
                  </p>
                </div>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
};

export default PermissionModeSelector;
