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
      <div className="modal-content w-full max-w-md mx-4 bg-surface rounded-2xl shadow-modal overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-6 pb-2">
          <h2 className="text-lg font-semibold text-foreground text-center">
            {i18nService.t('privacyDialogTitle')}
          </h2>
        </div>

        {/* Content */}
        <div className="px-6 py-4">
          <p className="text-sm text-secondary text-center leading-relaxed">
            {parts[0]}
            <a
              href={PRIVACY_URL}
              onClick={handleLinkClick}
              className="text-primary hover:text-primary-hover underline"
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
            className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-secondary bg-surface-raised hover:opacity-80 transition-opacity"
          >
            {i18nService.t('privacyDialogReject')}
          </button>
          <button
            onClick={onAccept}
            className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-white bg-primary hover:bg-primary-hover transition-colors"
          >
            {i18nService.t('privacyDialogAccept')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PrivacyDialog;
