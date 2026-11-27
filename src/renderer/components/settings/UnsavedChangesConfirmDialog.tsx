import React from 'react';

import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';
import {
  SETTINGS_ACTION_BUTTON_CLASS,
  SETTINGS_PRIMARY_BUTTON_CLASS,
} from './SettingsLayout';
import { SETTINGS_DESCRIPTION_TEXT, SETTINGS_META_TEXT } from './settingsTypography';

export interface UnsavedChangesConfirmDialogProps {
  isOpen: boolean;
  canSave: boolean;
  isSaving: boolean;
  errorMessage?: string | null;
  onContinueEditing: () => void;
  onDiscard: () => void;
  onSaveAndContinue?: () => void | Promise<void>;
}

const UnsavedChangesConfirmDialog: React.FC<UnsavedChangesConfirmDialogProps> = ({
  isOpen,
  canSave,
  isSaving,
  errorMessage,
  onContinueEditing,
  onDiscard,
  onSaveAndContinue,
}) => {
  if (!isOpen) return null;

  return (
    <Modal
      onClose={() => {
        if (!isSaving) onContinueEditing();
      }}
      onEscape={() => {
        if (!isSaving) onContinueEditing();
      }}
      overlayClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/35 px-4"
      className="w-full max-w-[420px] rounded-2xl border border-border bg-background p-5 shadow-modal"
    >
      <h3 className="text-base font-semibold text-foreground">
        {i18nService.t('settingsUnsavedTitle')}
      </h3>
      <p className={`mt-2 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
        {i18nService.t('settingsUnsavedDescription')}
      </p>
      {errorMessage ? (
        <p role="alert" className={`mt-2 ${SETTINGS_META_TEXT} text-red-500`}>
          {errorMessage}
        </p>
      ) : null}
      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={onContinueEditing}
          disabled={isSaving}
          className={SETTINGS_ACTION_BUTTON_CLASS}
        >
          {i18nService.t('settingsContinueEditing')}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={isSaving}
          className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-red-500/30 bg-red-500/10 px-3 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-400"
        >
          {i18nService.t('settingsDiscardChanges')}
        </button>
        {onSaveAndContinue && canSave ? (
          <button
            type="button"
            onClick={() => {
              void onSaveAndContinue();
            }}
            disabled={isSaving}
            className={SETTINGS_PRIMARY_BUTTON_CLASS}
          >
            {isSaving
              ? i18nService.t('saving')
              : i18nService.t('settingsSaveAndContinue')}
          </button>
        ) : null}
      </div>
    </Modal>
  );
};

export default UnsavedChangesConfirmDialog;
