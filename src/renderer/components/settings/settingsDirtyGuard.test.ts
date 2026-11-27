import { describe, expect, test, vi } from 'vitest';

import {
  resolveDirtyGuardAction,
  SettingsDirtyGuardAction,
  type SettingsDirtyGuardEntry,
} from './settingsDirtyGuard';

describe('resolveDirtyGuardAction', () => {
  test('proceeds when no guard is registered', () => {
    expect(resolveDirtyGuardAction(null)).toBe(SettingsDirtyGuardAction.Proceed);
    expect(resolveDirtyGuardAction(undefined)).toBe(SettingsDirtyGuardAction.Proceed);
  });

  test('proceeds when registered guard is not dirty', () => {
    const entry: SettingsDirtyGuardEntry = {
      isDirty: false,
      canSave: true,
      discard: vi.fn(),
    };
    expect(resolveDirtyGuardAction(entry)).toBe(SettingsDirtyGuardAction.Proceed);
  });

  test('prompts when registered guard has unsaved changes', () => {
    const entry: SettingsDirtyGuardEntry = {
      isDirty: true,
      canSave: true,
      save: vi.fn(async () => true),
      discard: vi.fn(),
    };
    expect(resolveDirtyGuardAction(entry)).toBe(SettingsDirtyGuardAction.Prompt);
  });
});
