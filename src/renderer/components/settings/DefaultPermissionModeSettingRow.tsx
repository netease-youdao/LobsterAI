import React, { useEffect, useState } from 'react';

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
import FullAccessConfirmDialog from '../cowork/FullAccessConfirmDialog';
import {
  getPermissionPresetOption,
  PERMISSION_PRESET_OPTIONS,
  requiresPermissionPresetConfirmation,
} from '../cowork/permissionPresetOptions';
import ThemedSelect from '../ui/ThemedSelect';
import {
  SETTINGS_DESCRIPTION_TEXT,
  SETTINGS_ITEM_TITLE_TEXT,
} from './settingsTypography';

const DefaultPermissionModeSettingRow: React.FC = () => {
  const [preset, setPreset] = useState<DshPermissionPreset>(DEFAULT_DSH_PERMISSION_PRESET);
  const [updating, setUpdating] = useState(false);
  const [confirmFullAccessOpen, setConfirmFullAccessOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void dshHostService.getPermissionPreset().then((res) => {
      if (active) setPreset(res.defaultPreset ?? res.preset);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const handlePresetChanged = (event: Event) => {
      const detail = (event as CustomEvent<DshPermissionPresetChangedDetail>).detail;
      const reaction = shouldApplyPermissionPresetEvent(undefined, detail);
      if (reaction.apply && reaction.nextPreset) {
        setPreset(reaction.nextPreset);
      }
    };
    window.addEventListener(DSH_PERMISSION_PRESET_CHANGED_EVENT, handlePresetChanged);
    return () => {
      window.removeEventListener(DSH_PERMISSION_PRESET_CHANGED_EVENT, handlePresetChanged);
    };
  }, []);

  const currentOption = getPermissionPresetOption(preset);

  const applyPreset = async (nextPreset: DshPermissionPreset) => {
    if (nextPreset === preset || updating) return;
    setUpdating(true);
    try {
      const res = await dshHostService.setPermissionPreset(nextPreset);
      if (res.ok) {
        const applied = res.defaultPreset ?? res.preset ?? nextPreset;
        setPreset(applied);
      }
    } finally {
      setUpdating(false);
    }
  };

  const handleChange = (value: string) => {
    const nextPreset = value as DshPermissionPreset;
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
    <div>
      <div className="flex items-center justify-between gap-4">
        <h4 className={`min-w-0 flex-1 ${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
          {i18nService.t('coworkDefaultPermissionModeTitle')}
        </h4>
        <div className="w-[180px] shrink-0">
          <ThemedSelect
            id="default-permission-mode"
            value={preset}
            onChange={handleChange}
            options={PERMISSION_PRESET_OPTIONS.map((option) => ({
              value: option.value,
              label: i18nService.t(option.labelKey),
            }))}
          />
        </div>
      </div>
      <p className={`mt-1 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
        {i18nService.t('coworkDefaultPermissionModeDescription')}
      </p>
      <p className={`mt-0.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary/80`}>
        {i18nService.t(currentOption.descKey)}
      </p>
      <FullAccessConfirmDialog
        isOpen={confirmFullAccessOpen}
        confirming={updating}
        onCancel={() => setConfirmFullAccessOpen(false)}
        onConfirm={() => { void handleConfirmFullAccess(); }}
      />
    </div>
  );
};

export default DefaultPermissionModeSettingRow;
