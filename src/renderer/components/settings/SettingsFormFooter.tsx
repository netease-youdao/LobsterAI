import React from 'react';

import { i18nService } from '../../services/i18n';
import {
  SettingsFormFooterMode,
  SettingsFormStatus,
} from './settingsDirtyGuard';
import {
  SETTINGS_ACTION_BUTTON_CLASS,
  SETTINGS_PRIMARY_BUTTON_CLASS,
  SettingsStatusBadge,
  SettingsStatusTone,
} from './SettingsLayout';
import { SETTINGS_META_TEXT } from './settingsTypography';

export interface SettingsFormStatusBadgeProps {
  status: SettingsFormStatus;
  dirtyLabel?: string;
  savingLabel?: string;
  savedLabel?: string;
  errorLabel?: string;
}

export const SettingsFormStatusBadge: React.FC<SettingsFormStatusBadgeProps> = ({
  status,
  dirtyLabel,
  savingLabel,
  savedLabel,
  errorLabel,
}) => {
  switch (status) {
    case SettingsFormStatus.Dirty:
      return (
        <SettingsStatusBadge
          tone={SettingsStatusTone.Warning}
          label={dirtyLabel ?? i18nService.t('decisionModelBadgeUnsaved')}
        />
      );
    case SettingsFormStatus.Saving:
      return (
        <SettingsStatusBadge
          tone={SettingsStatusTone.Progress}
          label={savingLabel ?? i18nService.t('saving')}
        />
      );
    case SettingsFormStatus.Saved:
      return (
        <SettingsStatusBadge
          tone={SettingsStatusTone.Success}
          label={savedLabel ?? i18nService.t('settingsSavedBadge')}
        />
      );
    case SettingsFormStatus.Error:
      return (
        <SettingsStatusBadge
          tone={SettingsStatusTone.Danger}
          label={errorLabel ?? i18nService.t('settingsSaveFailedBadge')}
        />
      );
    default:
      return null;
  }
};

export interface SettingsFormFooterProps {
  status: SettingsFormStatus;
  mode?: SettingsFormFooterMode;
  canSave: boolean;
  errorMessage?: string | null;
  saveLabel?: string;
  savingLabel?: string;
  discardLabel?: string;
  onSave: () => void | boolean | Promise<void | boolean>;
  onDiscard: () => void;
  leading?: React.ReactNode;
  className?: string;
}

export const SettingsFormFooter: React.FC<SettingsFormFooterProps> = ({
  status,
  mode = SettingsFormFooterMode.DirtyBar,
  canSave,
  errorMessage,
  saveLabel,
  savingLabel,
  discardLabel,
  onSave,
  onDiscard,
  leading,
  className = '',
}) => {
  const isSaving = status === SettingsFormStatus.Saving;
  const isDirtyOrActive = status === SettingsFormStatus.Dirty
    || status === SettingsFormStatus.Saving
    || status === SettingsFormStatus.Error;

  if (mode === SettingsFormFooterMode.DirtyBar && !isDirtyOrActive && !leading) {
    return null;
  }

  const showActionButtons = mode === SettingsFormFooterMode.Always || isDirtyOrActive;

  return (
    <div className={`space-y-2 ${className}`.trim()}>
      {errorMessage ? (
        <p role="alert" className={`${SETTINGS_META_TEXT} text-red-500`}>
          {errorMessage}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          {leading}
        </div>
        {showActionButtons ? (
          <div className="flex shrink-0 items-center justify-end gap-2">
            <button
              type="button"
              onClick={onDiscard}
              disabled={isSaving || (mode === SettingsFormFooterMode.Always && status === SettingsFormStatus.Idle)}
              className={SETTINGS_ACTION_BUTTON_CLASS}
            >
              {discardLabel ?? i18nService.t('settingsDiscardChanges')}
            </button>
            <button
              type="button"
              onClick={() => {
                void onSave();
              }}
              disabled={isSaving || !canSave}
              className={SETTINGS_PRIMARY_BUTTON_CLASS}
            >
              {isSaving
                ? (savingLabel ?? i18nService.t('saving'))
                : (saveLabel ?? i18nService.t('save'))}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
};
