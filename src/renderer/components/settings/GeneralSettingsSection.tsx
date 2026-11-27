import React from 'react';

import { TaskCompletionNotificationMode } from '../../../shared/notifications/constants';
import { i18nService, type LanguageType } from '../../services/i18n';
import ThemedSelect from '../ui/ThemedSelect';
import DefaultPermissionModeSettingRow from './DefaultPermissionModeSettingRow';
import { SettingsGroup, SettingsRow, SettingsToggleRow } from './SettingsLayout';
import { SETTINGS_DESCRIPTION_TEXT, SETTINGS_ITEM_TITLE_TEXT } from './settingsTypography';

interface GeneralSettingsSectionProps {
  language: LanguageType;
  onLanguageChange: (language: LanguageType) => void;
  artifactAutoPreviewEnabled: boolean;
  onToggleArtifactAutoPreview: () => void;
  taskCompletionNotificationMode: TaskCompletionNotificationMode;
  onTaskCompletionNotificationModeChange: (mode: TaskCompletionNotificationMode) => void;
  attentionNotificationsEnabled: boolean;
  onToggleAttentionNotifications: () => void;
  autoLaunch: boolean;
  isUpdatingAutoLaunch: boolean;
  onToggleAutoLaunch: () => void | Promise<void>;
  preventSleep: boolean;
  isUpdatingPreventSleep: boolean;
  onTogglePreventSleep: () => void | Promise<void>;
  quitConfirmation: boolean;
  isUpdatingQuitConfirmation: boolean;
  onToggleQuitConfirmation: () => void | Promise<void>;
  useSystemProxy: boolean;
  isUpdatingUseSystemProxy?: boolean;
  onToggleUseSystemProxy: () => void | Promise<void>;
}

const GeneralSettingsSection: React.FC<GeneralSettingsSectionProps> = ({
  language,
  onLanguageChange,
  artifactAutoPreviewEnabled,
  onToggleArtifactAutoPreview,
  taskCompletionNotificationMode,
  onTaskCompletionNotificationModeChange,
  attentionNotificationsEnabled,
  onToggleAttentionNotifications,
  autoLaunch,
  isUpdatingAutoLaunch,
  onToggleAutoLaunch,
  preventSleep,
  isUpdatingPreventSleep,
  onTogglePreventSleep,
  quitConfirmation,
  isUpdatingQuitConfirmation,
  onToggleQuitConfirmation,
  useSystemProxy,
  isUpdatingUseSystemProxy = false,
  onToggleUseSystemProxy,
}) => {
  const showSystemNotificationHint = window.electron.platform === 'win32'
    || (window.electron.platform === 'darwin' && !import.meta.env.DEV);

  return (
    <div className="space-y-8">
      <SettingsGroup title={i18nService.t('settingsGroupBasicsAndTasks')}>
        <SettingsRow>
          <div className="flex items-center justify-between gap-4">
            <h4 className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
              {i18nService.t('language')}
            </h4>
            <div className="w-[140px] shrink-0">
              <ThemedSelect
                id="language"
                value={language}
                onChange={(value) => {
                  onLanguageChange(value as LanguageType);
                }}
                options={[
                  { value: 'zh', label: i18nService.t('chinese') },
                  { value: 'en', label: i18nService.t('english') },
                ]}
              />
            </div>
          </div>
        </SettingsRow>

        <SettingsRow>
          <DefaultPermissionModeSettingRow />
        </SettingsRow>

        <SettingsRow>
          <SettingsToggleRow
            title={i18nService.t('artifactAutoPreviewEnabled')}
            description={i18nService.t('artifactAutoPreviewEnabledDescription')}
            checked={artifactAutoPreviewEnabled}
            onToggle={onToggleArtifactAutoPreview}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title={i18nService.t('settingsGroupNotifications')}
        footer={
          showSystemNotificationHint && (
            <p className="px-1 text-xs text-secondary">
              {i18nService.t('notificationSystemPermissionHint')}{' '}
              <button
                type="button"
                className="text-foreground underline underline-offset-2 transition-opacity hover:opacity-75"
                onClick={() => {
                  void window.electron.appInfo.openSystemNotificationSettings?.();
                }}
              >
                {i18nService.t('openSystemNotificationSettings')}
              </button>
            </p>
          )
        }
      >
        <SettingsRow>
          <div>
            <div className="flex items-center justify-between gap-4">
              <h4 className={`min-w-0 flex-1 ${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                {i18nService.t('taskCompletionNotificationMode')}
              </h4>
              <div className="w-[180px] shrink-0">
                <ThemedSelect
                  id="task-completion-notification-mode"
                  value={taskCompletionNotificationMode}
                  onChange={(value) => {
                    onTaskCompletionNotificationModeChange(value as TaskCompletionNotificationMode);
                  }}
                  options={[
                    {
                      value: TaskCompletionNotificationMode.Always,
                      label: i18nService.t('taskCompletionNotificationModeAlways'),
                    },
                    {
                      value: TaskCompletionNotificationMode.Unfocused,
                      label: i18nService.t('taskCompletionNotificationModeUnfocused'),
                    },
                    {
                      value: TaskCompletionNotificationMode.Off,
                      label: i18nService.t('taskCompletionNotificationModeOff'),
                    },
                  ]}
                />
              </div>
            </div>
            <p className={`mt-1 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
              {i18nService.t('taskCompletionNotificationModeDescription')}
            </p>
          </div>
        </SettingsRow>

        <SettingsRow>
          <SettingsToggleRow
            title={i18nService.t('permissionNotifications')}
            description={i18nService.t('permissionNotificationsDescription')}
            checked={attentionNotificationsEnabled}
            onToggle={onToggleAttentionNotifications}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={i18nService.t('settingsGroupAppAndNetwork')}>
        <SettingsRow>
          <SettingsToggleRow
            title={i18nService.t('autoLaunch')}
            description={i18nService.t('autoLaunchDescription')}
            checked={autoLaunch}
            disabled={isUpdatingAutoLaunch}
            onToggle={onToggleAutoLaunch}
          />
        </SettingsRow>

        <SettingsRow>
          <SettingsToggleRow
            title={i18nService.t('preventSleep')}
            description={i18nService.t('preventSleepDescription')}
            checked={preventSleep}
            disabled={isUpdatingPreventSleep}
            onToggle={onTogglePreventSleep}
          />
        </SettingsRow>

        <SettingsRow>
          <SettingsToggleRow
            title={i18nService.t('quitConfirmation')}
            description={i18nService.t('quitConfirmationDescription')}
            checked={quitConfirmation}
            disabled={isUpdatingQuitConfirmation}
            onToggle={onToggleQuitConfirmation}
          />
        </SettingsRow>

        <SettingsRow>
          <SettingsToggleRow
            title={i18nService.t('useSystemProxy')}
            description={i18nService.t('useSystemProxyDescription')}
            checked={useSystemProxy}
            disabled={isUpdatingUseSystemProxy}
            onToggle={onToggleUseSystemProxy}
          />
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
};

export default GeneralSettingsSection;
