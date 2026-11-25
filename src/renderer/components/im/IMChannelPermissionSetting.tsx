import React, { useEffect, useState } from 'react';

import {
  DEFAULT_DSH_PERMISSION_PRESET,
  DshPermissionPreset,
  parseDshPermissionPreset,
} from '../../../shared/dshEngine/hostConstants';
import { ImChannelPermissionMode } from '../../../shared/im/permissionPolicy';
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
} from '../cowork/permissionPresetOptions';
import { SettingsCard, SettingsItem } from '../settings/SettingsLayout';
import ThemedSelect from '../ui/ThemedSelect';

export interface IMChannelPermissionSettingProps {
  id: string;
  configuredPreset?: DshPermissionPreset | null;
  workingDirectory?: string;
  onChangePreset: (nextPreset: DshPermissionPreset | null) => Promise<void>;
  variant?: 'item' | 'card';
}

const IMChannelPermissionSetting: React.FC<IMChannelPermissionSettingProps> = ({
  id,
  configuredPreset,
  workingDirectory,
  onChangePreset,
  variant = 'card',
}) => {
  const [globalDefaultPreset, setGlobalDefaultPreset] = useState<DshPermissionPreset>(
    DEFAULT_DSH_PERMISSION_PRESET,
  );
  const [updating, setUpdating] = useState(false);
  const [confirmFullAccessOpen, setConfirmFullAccessOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void dshHostService.getPermissionPreset().then((res) => {
      if (active) {
        setGlobalDefaultPreset(res.defaultPreset ?? res.preset);
      }
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
        setGlobalDefaultPreset(reaction.nextPreset);
      }
    };
    window.addEventListener(DSH_PERMISSION_PRESET_CHANGED_EVENT, handlePresetChanged);
    return () => {
      window.removeEventListener(DSH_PERMISSION_PRESET_CHANGED_EVENT, handlePresetChanged);
    };
  }, []);

  const parsedConfigured = parseDshPermissionPreset(configuredPreset);
  const selectValue: ImChannelPermissionMode = parsedConfigured ?? ImChannelPermissionMode.FollowGlobal;
  const globalOption = getPermissionPresetOption(globalDefaultPreset);
  const activeOption = parsedConfigured ? getPermissionPresetOption(parsedConfigured) : null;
  const trimmedWorkingDirectory = workingDirectory?.trim() ?? '';

  const applySelection = async (nextPreset: DshPermissionPreset | null) => {
    if (updating) return;
    setUpdating(true);
    try {
      await onChangePreset(nextPreset);
      if (typeof window !== 'undefined') {
        const detail: DshPermissionPresetChangedDetail = {
          preset: nextPreset ?? globalDefaultPreset,
          defaultPreset: globalDefaultPreset,
        };
        window.dispatchEvent(new CustomEvent(DSH_PERMISSION_PRESET_CHANGED_EVENT, { detail }));
      }
    } finally {
      setUpdating(false);
    }
  };

  const handleChange = (rawValue: string) => {
    if (updating || rawValue === selectValue) return;
    if (rawValue === ImChannelPermissionMode.FollowGlobal) {
      void applySelection(null);
      return;
    }
    const nextPreset = parseDshPermissionPreset(rawValue);
    if (!nextPreset) return;
    if (
      nextPreset === DshPermissionPreset.FullAccess
      && parsedConfigured !== DshPermissionPreset.FullAccess
    ) {
      setConfirmFullAccessOpen(true);
      return;
    }
    void applySelection(nextPreset);
  };

  const handleConfirmFullAccess = async () => {
    await applySelection(DshPermissionPreset.FullAccess);
    setConfirmFullAccessOpen(false);
  };

  const options = [
    {
      value: ImChannelPermissionMode.FollowGlobal,
      label: i18nService
        .t('imChannelPermissionFollowGlobal')
        .replace('{preset}', i18nService.t(globalOption.shortLabelKey)),
    },
    ...PERMISSION_PRESET_OPTIONS.map((option) => ({
      value: option.value,
      label: i18nService.t(option.labelKey),
    })),
  ];

  const descriptionNode = (
    <div className="space-y-0.5">
      <div>
        {activeOption
          ? i18nService.t(activeOption.descKey)
          : i18nService.t('imChannelPermissionFollowGlobalHint')}
      </div>
      {trimmedWorkingDirectory && (
        <div className="truncate font-mono text-[11px] text-secondary/80" title={trimmedWorkingDirectory}>
          {i18nService
            .t('imChannelPermissionWorkspaceHint')
            .replace('{dir}', trimmedWorkingDirectory)}
        </div>
      )}
    </div>
  );

  const itemNode = (
    <>
      <SettingsItem
        title={i18nService.t('imChannelPermissionTitle')}
        description={descriptionNode}
        control={(
          <div className="w-[196px] shrink-0">
            <ThemedSelect
              id={id}
              value={selectValue}
              onChange={handleChange}
              options={options}
            />
          </div>
        )}
      />
      <FullAccessConfirmDialog
        isOpen={confirmFullAccessOpen}
        confirming={updating}
        onCancel={() => setConfirmFullAccessOpen(false)}
        onConfirm={() => { void handleConfirmFullAccess(); }}
      />
    </>
  );

  if (variant === 'item') {
    return itemNode;
  }

  return (
    <SettingsCard>
      {itemNode}
    </SettingsCard>
  );
};

export default IMChannelPermissionSetting;
