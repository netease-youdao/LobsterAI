import { describe, expect, test } from 'vitest';

import {
  DEFAULT_DSH_PERMISSION_PRESET,
  DshPermissionPreset,
} from '../../../shared/dshEngine/hostConstants';
import { i18nService } from '../../services/i18n';
import {
  getPermissionPresetOption,
  PERMISSION_PRESET_OPTIONS,
} from './permissionPresetOptions';

describe('permissionPresetOptions', () => {
  test('exposes all three DSH permission presets with localized full, short, and description labels', () => {
    expect(PERMISSION_PRESET_OPTIONS.map((option) => option.value)).toEqual([
      DshPermissionPreset.ReadOnly,
      DshPermissionPreset.WorkspaceWrite,
      DshPermissionPreset.FullAccess,
    ]);

    for (const language of ['zh', 'en'] as const) {
      i18nService.setLanguage(language, { persist: false });
      for (const option of PERMISSION_PRESET_OPTIONS) {
        expect(i18nService.t(option.labelKey)).not.toBe(option.labelKey);
        expect(i18nService.t(option.shortLabelKey)).not.toBe(option.shortLabelKey);
        expect(i18nService.t(option.descKey)).not.toBe(option.descKey);
      }
      expect(i18nService.t('coworkDefaultPermissionModeTitle')).not.toBe('coworkDefaultPermissionModeTitle');
      expect(i18nService.t('coworkDefaultPermissionModeDescription')).not.toBe('coworkDefaultPermissionModeDescription');
    }
  });

  test('resolves matching preset and falls back to the default preset for missing values', () => {
    expect(getPermissionPresetOption(DshPermissionPreset.ReadOnly).value).toBe(DshPermissionPreset.ReadOnly);
    expect(getPermissionPresetOption(DshPermissionPreset.FullAccess).value).toBe(DshPermissionPreset.FullAccess);
    expect(getPermissionPresetOption(undefined).value).toBe(DEFAULT_DSH_PERMISSION_PRESET);
    expect(getPermissionPresetOption(null).value).toBe(DEFAULT_DSH_PERMISSION_PRESET);
  });
});
