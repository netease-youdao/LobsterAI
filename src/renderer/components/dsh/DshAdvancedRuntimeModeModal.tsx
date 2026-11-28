import { ChevronDownIcon, CpuChipIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  DEFAULT_DSH_AGENT_PRESET_SETTINGS,
  DSH_AGENT_PRESET_SETTINGS_CHANGED_EVENT,
  DSH_PLUGINS_CHANGED_EVENT,
  type DshAgentPresetInfo,
  type DshAgentPresetSettings,
  dshHostService,
  loadDshAgentPresetSettings,
  saveDshAgentPresetSettings,
} from '@/services/dshHost';
import { i18nService } from '@/services/i18n';

import { DEFAULT_DSH_AGENT_PRESET_ID } from '../../../shared/dshEngine/hostConstants';
import Modal from '../common/Modal';
import { DshAgentPresetOptionList } from '../cowork/DshAgentPresetControl';
import {
  getUsableDshAgentPresets,
  resolveDshAgentPresetCopy,
} from '../cowork/dshAgentPresetViewModel';
import { SettingsSwitch } from '../settings/SettingsLayout';
import {
  SETTINGS_DESCRIPTION_TEXT,
  SETTINGS_ITEM_TITLE_TEXT,
  SETTINGS_META_TEXT,
} from '../settings/settingsTypography';

export interface DshAdvancedRuntimeModeModalProps {
  isOpen: boolean;
  onClose: () => void;
  hostHealthy: boolean;
}

const DROPDOWN_WIDTH = 340;
const DROPDOWN_ESTIMATED_MAX_HEIGHT = 384;
const VIEWPORT_PADDING = 16;

export const DshAdvancedRuntimeModeModal: React.FC<DshAdvancedRuntimeModeModalProps> = ({
  isOpen,
  onClose,
  hostHealthy,
}) => {
  const t = (key: string) => i18nService.t(key);
  const [settings, setSettings] = useState<DshAgentPresetSettings>(DEFAULT_DSH_AGENT_PRESET_SETTINGS);
  const [presets, setPresets] = useState<DshAgentPresetInfo[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const loadPresets = useCallback(async () => {
    try {
      const res = await dshHostService.listAgentPresets();
      if (res?.ok) {
        setPresets(res.usablePresets);
      }
    } catch {
      // Best-effort preset discovery.
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setPickerOpen(false);
      return undefined;
    }
    let active = true;
    void loadDshAgentPresetSettings().then((loaded) => {
      if (active) setSettings(loaded);
    });
    void loadPresets();
    const onSettingsChanged = (event: Event) => {
      const detail = (event as CustomEvent<DshAgentPresetSettings>).detail;
      if (active && detail) setSettings(detail);
    };
    const offConn = dshHostService.onConnectionChanged(() => void loadPresets());
    const offPlugins = dshHostService.onPluginsChanged(() => void loadPresets());
    const onLocalChange = () => void loadPresets();
    window.addEventListener(DSH_AGENT_PRESET_SETTINGS_CHANGED_EVENT, onSettingsChanged);
    window.addEventListener(DSH_PLUGINS_CHANGED_EVENT, onLocalChange);
    return () => {
      active = false;
      offConn();
      offPlugins();
      window.removeEventListener(DSH_AGENT_PRESET_SETTINGS_CHANGED_EVENT, onSettingsChanged);
      window.removeEventListener(DSH_PLUGINS_CHANGED_EVENT, onLocalChange);
    };
  }, [isOpen, loadPresets]);

  useLayoutEffect(() => {
    if (!pickerOpen) return undefined;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(DROPDOWN_WIDTH, window.innerWidth - VIEWPORT_PADDING * 2);
      const left = Math.max(
        VIEWPORT_PADDING,
        Math.min(rect.right - width, window.innerWidth - width - VIEWPORT_PADDING),
      );
      const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PADDING;
      const spaceAbove = rect.top - VIEWPORT_PADDING;
      const openUpward = spaceBelow < 240 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(
        180,
        Math.min(DROPDOWN_ESTIMATED_MAX_HEIGHT, (openUpward ? spaceAbove : spaceBelow) - 8),
      );
      setDropdownStyle(
        openUpward
          ? { position: 'fixed', left, bottom: window.innerHeight - rect.top + 6, width, maxHeight }
          : { position: 'fixed', left, top: rect.bottom + 6, width, maxHeight },
      );
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const handleOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !dropdownRef.current?.contains(target)) {
        setPickerOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside, true);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleOutside, true);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [pickerOpen]);

  const usablePresets = useMemo(() => {
    const usable = getUsableDshAgentPresets(presets);
    if (usable.length > 0) return usable;
    return [{ id: DEFAULT_DSH_AGENT_PRESET_ID, isDefault: true }];
  }, [presets]);

  const effectiveSelectedDefaultId = useMemo(() => {
    if (usablePresets.some((preset) => preset.id === settings.defaultPresetId)) {
      return settings.defaultPresetId;
    }
    return DEFAULT_DSH_AGENT_PRESET_ID;
  }, [usablePresets, settings.defaultPresetId]);

  const selectedCopy = resolveDshAgentPresetCopy(effectiveSelectedDefaultId, usablePresets, t);

  const updateSettings = async (patch: Partial<DshAgentPresetSettings>) => {
    const next: DshAgentPresetSettings = { ...settings, ...patch };
    setSettings(next);
    await saveDshAgentPresetSettings(next);
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={() => {
          setPickerOpen(false);
          onClose();
        }}
        onEscape={() => {
          if (pickerOpen) {
            setPickerOpen(false);
            return;
          }
          onClose();
        }}
        overlayClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
        className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-modal"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CpuChipIcon className="h-4 w-4 text-secondary" />
            <h3 className="text-base font-semibold text-foreground">
              {t('dshAdvancedRuntimeModeTitle')}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            className="rounded-lg p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 divide-y divide-border rounded-xl border border-border bg-surface-raised/30">
          {/* Master opt-in switch */}
          <div className="flex items-start justify-between gap-4 px-4 py-3.5">
            <div className="min-w-0">
              <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                {t('dshAdvancedRuntimeModeEnableLabel')}
              </div>
              <p className={`mt-0.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
                {t('dshAdvancedRuntimeModeDesc')}
              </p>
            </div>
            <div className="shrink-0 pt-0.5">
              <SettingsSwitch
                checked={settings.enabled}
                label={t('dshAdvancedRuntimeModeEnableLabel')}
                onClick={() => {
                  setPickerOpen(false);
                  void updateSettings({ enabled: !settings.enabled });
                }}
              />
            </div>
          </div>

          {/* Default preset for new sessions (shown when enabled) */}
          {settings.enabled && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                    {t('dshAdvancedRuntimeModeDefaultLabel')}
                  </div>
                  <p className={`mt-0.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
                    {t('dshAdvancedRuntimeModeDefaultDesc')}
                  </p>
                </div>

                <button
                  ref={triggerRef}
                  type="button"
                  disabled={!hostHealthy || usablePresets.length <= 1}
                  onClick={() => setPickerOpen((prev) => !prev)}
                  aria-haspopup="menu"
                  aria-expanded={pickerOpen}
                  aria-label={t('dshAdvancedRuntimeModeDefaultLabel')}
                  className="inline-flex h-8 min-w-[148px] max-w-[200px] shrink-0 items-center justify-between gap-2 rounded-lg border border-border bg-surface px-2.5 text-xs font-medium text-foreground transition-colors hover:border-foreground/30 hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="truncate">{selectedCopy.name}</span>
                  <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-secondary" />
                </button>
              </div>

              <div className={`px-4 py-2.5 ${SETTINGS_META_TEXT} text-secondary`}>
                {t('dshAdvancedRuntimeModeComposerHint')}
              </div>
            </>
          )}
        </div>
      </Modal>

      {isOpen && pickerOpen && createPortal(
        <div
          ref={dropdownRef}
          role="menu"
          aria-label={t('dshAdvancedRuntimeModeDefaultLabel')}
          style={dropdownStyle}
          className="z-[70] flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-popover"
        >
          <DshAgentPresetOptionList
            presets={usablePresets}
            selectedId={effectiveSelectedDefaultId}
            maxHeightClassName="max-h-full"
            onSelect={(presetId) => {
              setPickerOpen(false);
              void updateSettings({ defaultPresetId: presetId });
            }}
          />
        </div>,
        document.body,
      )}
    </>
  );
};

export default DshAdvancedRuntimeModeModal;
