import React from 'react';
import { i18nService } from '../../services/i18n';
import type { AppUpdateInfo } from '../../services/appUpdate';

interface AppUpdateModalProps {
  updateInfo: AppUpdateInfo;
  onConfirm: () => void;
  onCancel: () => void;
}

const AppUpdateModal: React.FC<AppUpdateModalProps> = ({ updateInfo, onConfirm, onCancel }) => {
  const { latestVersion, date, changeLog } = updateInfo;
  const lang = i18nService.getLanguage();
  const currentLog = changeLog[lang];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop">
      <div className="modal-content w-full max-w-md mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-modal overflow-hidden">
        <div className="px-5 pt-5 pb-4">
          <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('updateAvailableTitle')}
          </h3>
          <p className="mt-1.5 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            v{latestVersion}{date ? ` · ${date}` : ''}
          </p>

          {currentLog.title && (
            <p className="mt-3 text-sm font-medium dark:text-claude-darkText text-claude-text">
              {currentLog.title}
            </p>
          )}

          {currentLog.content.length > 0 && (
            <ul className="mt-2 space-y-1.5 max-h-48 overflow-y-auto">
              {currentLog.content.map((item, index) => (
                <li key={index} className="flex items-start gap-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-claude-accent/60" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-5 pb-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
          >
            {i18nService.t('updateAvailableCancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3 py-1.5 text-sm rounded-lg bg-claude-accent text-white hover:bg-claude-accentHover transition-colors"
          >
            {i18nService.t('updateAvailableConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AppUpdateModal;
