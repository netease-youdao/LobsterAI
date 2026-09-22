import { OpenClawGatewayRepairErrorCode } from '../../shared/openclawEngine/constants';
import { OpenClawRepairStage } from '../../shared/openclawEngine/repair';
import type { OpenClawGatewayRepairResult } from '../types/cowork';
import { i18nService } from './i18n';

const stageMessages: Record<OpenClawRepairStage, string> = {
  [OpenClawRepairStage.LockRecovery]: 'openClawRepairLockRecoveryFailed',
  [OpenClawRepairStage.Snapshot]: 'openClawRepairSnapshotFailed',
  [OpenClawRepairStage.Preparation]: 'openClawRepairPreparationFailed',
  [OpenClawRepairStage.Doctor]: 'openClawRepairDoctorFailed',
  [OpenClawRepairStage.Recovery]: 'openClawRepairRecoveryFailed',
  [OpenClawRepairStage.Configuration]: 'openClawRepairConfigurationFailed',
  [OpenClawRepairStage.Plugins]: 'openClawRepairPluginsFailed',
  [OpenClawRepairStage.Gateway]: 'openClawRepairGatewayFailed',
};

export function resolveOpenClawRepairError(result: OpenClawGatewayRepairResult, includeBackupPath = true): string {
  if (result.errorCode === OpenClawGatewayRepairErrorCode.Busy) return i18nService.t('openClawRepairBusyError');
  if (result.errorCode === OpenClawGatewayRepairErrorCode.ConfigApplyPending) return i18nService.t('openClawRepairConfigApplyPendingError');
  const stageKey = result.failedStage ? stageMessages[result.failedStage] : undefined;
  return [
    stageKey ? i18nService.t(stageKey) : undefined,
    result.error?.trim() || (!stageKey ? i18nService.t('openClawRepairFailed') : undefined),
    result.failurePath ? i18nService.t('openClawRepairFailurePath').replace('{path}', () => result.failurePath!) : undefined,
    includeBackupPath && result.backupPath ? i18nService.t('openClawRepairFilesPath').replace('{path}', () => result.backupPath!) : undefined,
  ].filter(Boolean).join('\n');
}
