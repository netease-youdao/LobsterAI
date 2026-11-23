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
import {
  getPermissionPresetOption,
  PERMISSION_PRESET_OPTIONS,
} from '../cowork/permissionPresetOptions';
import ThemedSelect from '../ui/ThemedSelect';
import {
  SETTINGS_DESCRIPTION_TEXT,
  SETTINGS_ITEM_TITLE_TEXT,
} from './settingsTypography';

const DefaultPermissionModeSettingRow: React.FC = () => {
  const [preset, setPreset] = useState<DshPermissionPreset>(DEFAULT_DSH_PERMISSION_PRESET);
  const [updating, setUpdating] = useState(false);

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

  const handleChange = async (value: string) => {
    const nextPreset = value as DshPermissionPreset;
    if (nextPreset === preset || updating) return;
    setUpdating(true);
    try {
      const res = await dshHostService.setPermissionPreset(nextPreset);
      if (res.ok) {
        const applied = res.defaultPreset ?? res.preset ?? nextPreset;
        setPreset(applied);
        const appliedOption = getPermissionPresetOption(applied);
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: i18nService
            .t('coworkPermissionModeSwitchedToast')
            .replace('{mode}', i18nService.t(appliedOption.labelKey)),
        }));
      }
    } finally {
      setUpdating(false);
    }
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
            onChange={(value) => { void handleChange(value); }}
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
    </div>
  );
};

export default DefaultPermissionModeSettingRow;
