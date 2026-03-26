import React from 'react';
import { i18nService } from '@/services/i18n';

const PRIVACY_URL = 'https://c.youdao.com/dict/hardware/lobsterai/lobsterai_service.html';

interface PrivacyDialogProps {
  onAccept: () => void;
  onReject: () => void;
}

const PrivacyDialog: React.FC<PrivacyDialogProps> = ({ onAccept, onReject }) => {
  const handleLinkClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    await window.electron.shell.openExternal(PRIVACY_URL);
  };

  const desc = i18nService.t('privacyDialogDesc');
  const linkText = i18nService.t('privacyDialogLinkText');
  const parts = desc.split('{link}');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop">
      <div className="modal-content w-full max-w-md mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-modal overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-6 pb-2">
          <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text text-center">
            {i18nService.t('privacyDialogTitle')}
          </h2>
        </div>

        {/* Content */}
        <div className="px-6 py-4">
          <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary text-center leading-relaxed">
            {parts[0]}
            <a
              href={PRIVACY_URL}
              onClick={handleLinkClick}
              className="text-claude-accent hover:text-claude-accentHover underline"
            >
              {linkText}
            </a>
            {parts[1]}
          </p>
        </div>

        {/* Buttons */}
        <div className="px-6 pb-6 pt-2 flex gap-3">
          <button
            onClick={onReject}
            className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover hover:opacity-80 transition-opacity"
          >
            {i18nService.t('privacyDialogReject')}
          </button>
          <button
            onClick={onAccept}
            className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-white bg-claude-accent hover:bg-claude-accentHover transition-colors"
          >
            {i18nService.t('privacyDialogAccept')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PrivacyDialog;
