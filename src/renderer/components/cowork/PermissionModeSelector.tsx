import {
  CheckIcon,
  ChevronDownIcon,
  EyeIcon,
  ShieldCheckIcon,
  ShieldExclamationIcon,
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
  type DshPermissionPresetChangedDetail,
  shouldApplyPermissionPresetEvent,
} from '../../services/dshHost';
import { i18nService } from '../../services/i18n';
import FullAccessConfirmDialog from './FullAccessConfirmDialog';
import {
  getPermissionPresetOption,
  PERMISSION_PRESET_OPTIONS,
  requiresPermissionPresetConfirmation,
} from './permissionPresetOptions';

interface PermissionModeSelectorProps {
  sessionId?: string | null;
  compact?: boolean;
  disabled?: boolean;
}

const PRESET_ICONS: Record<DshPermissionPreset, React.ComponentType<{ className?: string }>> = {
  [DshPermissionPreset.ReadOnly]: EyeIcon,
  [DshPermissionPreset.WorkspaceWrite]: ShieldCheckIcon,
  [DshPermissionPreset.FullAccess]: ShieldExclamationIcon,
};

const PermissionModeSelector: React.FC<PermissionModeSelectorProps> = ({
  sessionId,
  compact = false,
  disabled = false,
}) => {
  const [preset, setPreset] = useState<DshPermissionPreset>(DEFAULT_DSH_PERMISSION_PRESET);
  const [open, setOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [confirmFullAccessOpen, setConfirmFullAccessOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const normalizedSessionId = typeof sessionId === 'string' && sessionId.trim()
    ? sessionId.trim()
    : undefined;

  useEffect(() => {
    setConfirmFullAccessOpen(false);
    let active = true;
    void dshHostService.getPermissionPreset(normalizedSessionId).then((res) => {
      if (active) setPreset(res.preset);
    });
    return () => {
      active = false;
    };
  }, [normalizedSessionId]);

  useEffect(() => {
    let active = true;
    const handlePresetChanged = (event: Event) => {
      const detail = (event as CustomEvent<DshPermissionPresetChangedDetail>).detail;
      const reaction = shouldApplyPermissionPresetEvent(normalizedSessionId, detail);
      if (reaction.apply && reaction.nextPreset) {
        setPreset(reaction.nextPreset);
      } else if (reaction.refetch && normalizedSessionId) {
        void dshHostService.getPermissionPreset(normalizedSessionId).then((res) => {
          if (active) setPreset(res.preset);
        });
      }
    };
    window.addEventListener(DSH_PERMISSION_PRESET_CHANGED_EVENT, handlePresetChanged);
    return () => {
      active = false;
      window.removeEventListener(DSH_PERMISSION_PRESET_CHANGED_EVENT, handlePresetChanged);
    };
  }, [normalizedSessionId]);

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

  const currentOption = getPermissionPresetOption(preset);
  const CurrentIcon = PRESET_ICONS[currentOption.value];

  const applyPreset = async (nextPreset: DshPermissionPreset) => {
    if (nextPreset === preset || updating) return;
    setUpdating(true);
    try {
      // Scope changes to the active session when inside a conversation; only
      // update the global default preset when on the home / new-session composer.
      const res = await dshHostService.setPermissionPreset(nextPreset, normalizedSessionId);
      if (res.ok) {
        setPreset(res.preset ?? nextPreset);
        const nextMeta = getPermissionPresetOption(nextPreset);
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: i18nService
            .t('coworkPermissionModeSwitchedToast')
            .replace('{mode}', i18nService.t(nextMeta.labelKey)),
        }));
      }
    } finally {
      setUpdating(false);
    }
  };

  const handleSelect = (nextPreset: DshPermissionPreset) => {
    setOpen(false);
    if (nextPreset === preset || updating) return;
    if (requiresPermissionPresetConfirmation(preset, nextPreset)) {
      setConfirmFullAccessOpen(true);
      return;
    }
    void applyPreset(nextPreset);
  };

  const handleConfirmFullAccess = async () => {
    await applyPreset(DshPermissionPreset.FullAccess);
    setConfirmFullAccessOpen(false);
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || updating}
        onClick={() => setOpen((prev) => !prev)}
        className={`flex items-center gap-1 rounded-lg transition-colors ${
          compact
            ? 'h-8 w-8 justify-center hover:bg-surface-raised'
            : 'h-8 px-2 hover:bg-surface-raised'
        } text-[13px] ${currentOption.accentClass} hover:text-foreground disabled:opacity-50 ${
          open ? 'bg-surface-raised text-foreground' : ''
        }`}
        aria-label={`${i18nService.t('coworkPermissionModeLabel')}: ${i18nService.t(currentOption.labelKey)}`}
        aria-expanded={open}
        title={`${i18nService.t('coworkPermissionModeLabel')}: ${i18nService.t(currentOption.labelKey)}`}
      >
        <CurrentIcon className="h-4 w-4 shrink-0" />
        {!compact && (
          <>
            <span className="max-w-[96px] truncate text-xs">
              {i18nService.t(currentOption.shortLabelKey)}
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
          {PERMISSION_PRESET_OPTIONS.map((option) => {
            const OptionIcon = PRESET_ICONS[option.value];
            const selected = option.value === preset;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => handleSelect(option.value)}
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
      <FullAccessConfirmDialog
        isOpen={confirmFullAccessOpen}
        confirming={updating}
        onCancel={() => setConfirmFullAccessOpen(false)}
        onConfirm={() => { void handleConfirmFullAccess(); }}
      />
    </div>
  );
};

export default PermissionModeSelector;
