import { ArchiveBoxIcon, ArrowPathIcon, ArrowPathRoundedSquareIcon } from '@heroicons/react/24/outline';
import React from 'react';

import { i18nService } from '../../services/i18n';
import ManualDataMigrationAction from './ManualDataMigrationAction';
import { SettingsGroup, SettingsRow, SettingsToggleRow } from './SettingsLayout';
import { SETTINGS_DESCRIPTION_TEXT, SETTINGS_ITEM_TITLE_TEXT } from './settingsTypography';

interface DataPrivacySettingsSectionProps {
  tempStorageUsageBytes: number | null;
  tempStorageCleanableBytes: number | null;
  tempStorageCleanResult: string | null;
  isLoadingTempCleanPreview: boolean;
  isCleaningTempStorage: boolean;
  formatSize: (sizeBytes?: number) => string;
  onOpenTempCleanConfirm: () => void;
  sqliteAutoBackupEnabled: boolean;
  onToggleSqliteAutoBackup: () => void;
  dataBackupResult: { path: string; sizeBytes?: number } | null;
  isBackingUpData: boolean;
  isRestoringData: boolean;
  onRevealDataBackup: () => void;
  onDataBackup: () => void;
  onOpenDataRestoreConfirm: () => void;
  usageAnalyticsEnabled: boolean;
  onToggleUsageAnalytics: () => void;
}

const DataPrivacySettingsSection: React.FC<DataPrivacySettingsSectionProps> = ({
  tempStorageUsageBytes,
  tempStorageCleanableBytes,
  tempStorageCleanResult,
  isLoadingTempCleanPreview,
  isCleaningTempStorage,
  formatSize,
  onOpenTempCleanConfirm,
  sqliteAutoBackupEnabled,
  onToggleSqliteAutoBackup,
  dataBackupResult,
  isBackingUpData,
  isRestoringData,
  onRevealDataBackup,
  onDataBackup,
  onOpenDataRestoreConfirm,
  usageAnalyticsEnabled,
  onToggleUsageAnalytics,
}) => (
  <div className="space-y-8">
    <SettingsGroup title={i18nService.t('settingsGroupStorageProtection')}>
      <SettingsRow>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h4 className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
              {i18nService.t('coworkTempUsageTitle')}
            </h4>
            <p className={`mt-1 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
              {tempStorageUsageBytes === null
                ? i18nService.t('coworkTempUsageLoading')
                : i18nService.t('coworkTempUsageLabel')
                    .replace('{size}', formatSize(tempStorageUsageBytes) || '0 B')
                    .replace(
                      '{cleanable}',
                      formatSize(tempStorageCleanableBytes ?? 0) || '0 B',
                    )}
            </p>
            <p className={`mt-1 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
              {i18nService.t('coworkTempUsageManualNote')}
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenTempCleanConfirm}
            disabled={isLoadingTempCleanPreview || isCleaningTempStorage || tempStorageCleanableBytes === 0}
            className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoadingTempCleanPreview
              ? i18nService.t('coworkTempPreviewLoading')
              : i18nService.t('coworkTempCleanNow')}
          </button>
        </div>
        {tempStorageCleanResult && (
          <p className={`mt-2 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{tempStorageCleanResult}</p>
        )}
      </SettingsRow>

      <SettingsRow>
        <SettingsToggleRow
          title={i18nService.t('sqliteAutoBackupEnabled')}
          description={i18nService.t('sqliteAutoBackupEnabledDescription')}
          checked={sqliteAutoBackupEnabled}
          onToggle={onToggleSqliteAutoBackup}
        />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title={i18nService.t('settingsGroupBackupMigration')}>
      {dataBackupResult && (
        <SettingsRow>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                {i18nService.t('openClawDataBackupSavedTitle')}
              </div>
              <div className="break-all font-mono text-xs leading-5 text-secondary">
                {dataBackupResult.path}
              </div>
              {formatSize(dataBackupResult.sizeBytes) && (
                <div className="text-xs text-secondary">
                  {i18nService.t('openClawDataBackupSize')}: {formatSize(dataBackupResult.sizeBytes)}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onRevealDataBackup}
              className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised active:scale-[0.98]"
            >
              {i18nService.t('showInFolder')}
            </button>
          </div>
        </SettingsRow>
      )}

      <SettingsRow>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-primary">
              <ArchiveBoxIcon className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0">
              <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                {i18nService.t('openClawDataBackupTitle')}
              </div>
              <div className={`mt-0.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
                {i18nService.t('openClawDataBackupDesc')}
              </div>
            </div>
          </div>
          <ManualDataMigrationAction onClick={onDataBackup}>
            {isBackingUpData && (
              <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
            )}
            {isBackingUpData
              ? i18nService.t('openClawDataBackupRunning')
              : i18nService.t('openClawDataBackupAction')}
          </ManualDataMigrationAction>
        </div>
      </SettingsRow>

      <SettingsRow>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-primary">
              <ArrowPathRoundedSquareIcon className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0">
              <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                {i18nService.t('openClawDataMigrationTitle')}
              </div>
              <div className={`mt-0.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
                {i18nService.t('openClawDataMigrationDesc')}
              </div>
            </div>
          </div>
          <ManualDataMigrationAction onClick={onOpenDataRestoreConfirm}>
            {isRestoringData && (
              <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
            )}
            {isRestoringData
              ? i18nService.t('openClawDataMigrationRunning')
              : i18nService.t('openClawDataMigrationAction')}
          </ManualDataMigrationAction>
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title={i18nService.t('settingsGroupPrivacy')}>
      <SettingsRow>
        <SettingsToggleRow
          title={i18nService.t('usageAnalyticsEnabled')}
          description={i18nService.t('usageAnalyticsEnabledDescription')}
          checked={usageAnalyticsEnabled}
          onToggle={onToggleUsageAnalytics}
        />
      </SettingsRow>
    </SettingsGroup>
  </div>
);

export default DataPrivacySettingsSection;
