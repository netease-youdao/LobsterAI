export const SettingsFormStatus = {
  Idle: 'idle',
  Dirty: 'dirty',
  Saving: 'saving',
  Saved: 'saved',
  Error: 'error',
} as const;
export type SettingsFormStatus = typeof SettingsFormStatus[keyof typeof SettingsFormStatus];

export const SettingsFormFooterMode = {
  DirtyBar: 'dirty-bar',
  Always: 'always',
} as const;
export type SettingsFormFooterMode = typeof SettingsFormFooterMode[keyof typeof SettingsFormFooterMode];

export const SettingsDirtyGuardAction = {
  Proceed: 'proceed',
  Prompt: 'prompt',
} as const;
export type SettingsDirtyGuardAction = typeof SettingsDirtyGuardAction[keyof typeof SettingsDirtyGuardAction];

export interface SettingsDirtyGuardEntry {
  isDirty: boolean;
  canSave: boolean;
  save?: () => Promise<boolean>;
  discard: () => void;
}

export type RegisterSettingsDirtyGuard = (entry: SettingsDirtyGuardEntry | null) => void;

export const resolveDirtyGuardAction = (
  entry: SettingsDirtyGuardEntry | null | undefined,
): SettingsDirtyGuardAction => (
  entry?.isDirty ? SettingsDirtyGuardAction.Prompt : SettingsDirtyGuardAction.Proceed
);

export const SETTINGS_FORM_SAVED_RESET_MS = 1800;
