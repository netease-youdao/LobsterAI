import { OpenClawConfigApplyPendingReason, OpenClawEngineErrorCode } from '../../shared/openclawEngine/constants';
import type { OpenClawEngineStatus } from '../types/cowork';
import { i18nService } from './i18n';

/**
 * A task-admission reply that only says a config change is still unapplied.
 * The gateway keeps running, so it must not drive the global startup overlay,
 * which only a later engine status event could clear.
 */
export function isConfigApplyPendingStatus(status: OpenClawEngineStatus | null | undefined): boolean {
  return status?.configApplyPending === true;
}

/** User-facing reason a task was refused with ENGINE_NOT_READY. */
export function resolveEngineNotReadyMessage(status: OpenClawEngineStatus | null | undefined): string {
  if (status?.errorCode === OpenClawEngineErrorCode.ConfigApplyStalled) {
    return i18nService.t('coworkErrorConfigApplyStalled');
  }
  if (isConfigApplyPendingStatus(status)) {
    return status?.configApplyPendingReason === OpenClawConfigApplyPendingReason.ModelSettings
      ? i18nService.t('coworkErrorConfigApplyPendingForModel')
      : i18nService.t('coworkErrorConfigApplyPending');
  }
  return i18nService.t('coworkErrorEngineNotReady');
}
