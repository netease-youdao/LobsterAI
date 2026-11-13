import { type RemoteSyncRecoveryDisplay, RemoteSyncRecoveryReason, RemoteSyncRecoveryState } from '../../../shared/remote/recovery';
import { i18nService } from '../../services/i18n';

const statusKeys = {
  [RemoteSyncRecoveryState.Waiting]: 'remoteRecoveryWaiting',
  [RemoteSyncRecoveryState.Checking]: 'remoteRecoveryChecking',
  [RemoteSyncRecoveryState.Recovering]: 'remoteRecoveryRecovering',
  [RemoteSyncRecoveryState.Blocked]: 'remoteRecoveryBlocked',
} as const;
const reasonKeys = {
  [RemoteSyncRecoveryReason.Protocol]: 'remoteRecoveryProtocolHelp',
  [RemoteSyncRecoveryReason.Request]: 'remoteRecoveryRequestHelp',
  [RemoteSyncRecoveryReason.Conflict]: 'remoteRecoveryConflictHelp',
  [RemoteSyncRecoveryReason.Unavailable]: 'remoteRecoveryUnavailableHelp',
} as const;
export function recoveryStatusLabel(recovery?: RemoteSyncRecoveryDisplay): string | null {
  const key = recovery && statusKeys[recovery.state];
  return key ? i18nService.t(key) : null;
}
export function recoveryReasonText(recovery?: RemoteSyncRecoveryDisplay): string | null {
  const key = recovery?.reason && reasonKeys[recovery.reason];
  return key ? i18nService.t(key) : null;
}
export function recoveryNextProbeText(recovery?: RemoteSyncRecoveryDisplay, now = Date.now()): string | null {
  const at = recovery?.nextProbeAt;
  return recovery?.state === RemoteSyncRecoveryState.Waiting && Number.isSafeInteger(at) && at! > now && at! <= 8_640_000_000_000_000
    ? i18nService.t('remoteRecoveryNextProbe').replace('{time}', new Date(at!).toLocaleTimeString()) : null;
}
