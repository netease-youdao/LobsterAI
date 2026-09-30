import type { RemoteOwner } from '../../shared/remote/constants';
import { RemoteFileReason } from '../../shared/remote/files';
import { RemoteInputReason } from '../../shared/remote/input';
import { RemoteTelemetryEvent } from '../../shared/remote/telemetry';
import { remoteSyncErrorMetadata } from './remoteSyncLog';
import { captureRemoteTelemetry } from './remoteTelemetry';

export const RemoteFileTelemetry = {
  File: RemoteTelemetryEvent.File, Input: RemoteTelemetryEvent.Preparation,
  Stage: RemoteTelemetryEvent.SyncStage, WorkerExit: RemoteTelemetryEvent.WorkerExit, WorkerRestart: RemoteTelemetryEvent.WorkerRestart,
  InputDownload: 'input_download', DesktopInput: 'desktop_input_upload', Artifact: 'artifact_upload',
  Discovery: 'discovery', Snapshot: 'snapshot', Upload: 'upload', Complete: 'complete', Publish: 'publish',
  Reference: 'reference', LocalCommit: 'local_commit', Download: 'download', Validate: 'validate', Write: 'write',
  LocalReady: 'local_ready', ServerReady: 'server_ready', Cleanup: 'cleanup', Retry: 'retry',
  Started: 'started', Succeeded: 'succeeded', Failed: 'failed', Deferred: 'deferred', Cancelled: 'cancelled', Skipped: 'skipped',
  FileOperation: 'FILE_OPERATION_FAILED', LocalIo: 'LOCAL_IO_FAILED', ContextChanged: 'CONTEXT_CHANGED',
  ResponseInvalid: 'RESPONSE_INVALID', RequestRejected: 'REQUEST_REJECTED', DiscoveryUnavailable: 'DISCOVERY_UNAVAILABLE',
} as const;
const knownReasons = new Set<string>([...Object.values(RemoteFileReason), ...Object.values(RemoteInputReason),
  'ASSET_FILE_CHANGED', 'ASSET_MISSING', 'ASSET_UPLOAD_FAILED', 'ASSET_EXPIRED', 'ACCESS_DENIED',
  'INPUT_TOTAL_TOO_LARGE', 'ACCOUNT_FILE_COUNT_LIMIT', 'UNBOUND_FILE_QUOTA_EXCEEDED', 'ACCOUNT_FILE_QUOTA_EXCEEDED',
  'TASK_FILE_QUOTA_EXCEEDED', 'FILE_QUOTA_INCONSISTENT', 'PRIVATE_INPUT_STORAGE_UNAVAILABLE',
]);
const ioCodes = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EROFS', 'EMFILE', 'ENFILE', 'ENOENT']);

/** Only finite classifications cross the telemetry boundary; messages and paths never do. */
export function remoteFileTelemetryReason(error: unknown): string {
  try {
    if (error !== null && typeof error === 'object') {
      const value = error as { reason?: unknown; message?: unknown; code?: unknown };
      if (typeof value.code === 'string' && ioCodes.has(value.code)) return RemoteFileTelemetry.LocalIo;
      if (typeof value.reason === 'string' && knownReasons.has(value.reason)) return value.reason;
      if (typeof value.message === 'string' && knownReasons.has(value.message)) return value.message;
    }
  } catch { /* Error objects are not a trusted telemetry schema. */ }
  return RemoteFileTelemetry.FileOperation;
}
export function captureRemoteFileTelemetry(owner: RemoteOwner, fields: Record<string, unknown> = {}) {
  return captureRemoteTelemetry({ lane: 'files', remote_owner_id: owner.userId, owner_scope_id: owner.scopeKey, ...fields });
}
export function remoteFileRequestFailure(error: unknown, response?: Response): string {
  let metadata: Record<string, unknown>;
  try { metadata = remoteSyncErrorMetadata(error); } catch { return 'unknown'; }
  if (['REMOTE_NETWORK_ADMISSION_BUSY', 'REMOTE_NETWORK_BUSY'].includes(String(metadata.transportFailure))) return 'local_deferred';
  if (['REMOTE_NETWORK_REQUEST_INVALID', 'REMOTE_NETWORK_REQUEST_BUDGET', 'REMOTE_NETWORK_WORKER_UNAVAILABLE', 'REMOTE_NETWORK_RESTART_BUDGET'].includes(String(metadata.transportFailure))) return 'preflight_failed';
  if (metadata.transportFailure === 'REMOTE_NETWORK_CANCELLED') return 'cancelled';
  if ([RemoteInputReason.Account, RemoteFileReason.Access, 'ACCESS_DENIED'].includes(remoteFileTelemetryReason(error))) return 'context_changed';
  if (remoteFileTelemetryReason(error) === RemoteFileTelemetry.LocalIo) return 'local_processing_failed';
  if (response) return response.ok ? 'response_invalid' : 'response_rejected';
  if (metadata.authStatus && !metadata.transportFailure && !metadata.transportErrorType) return 'preflight_failed';
  return 'transport_failed';
}
export function remoteFileRequestOperation(pathname: string): string {
  const route = pathname.split('?')[0];
  if (/\/parts\/\d+$/u.test(route)) return 'file_part';
  if (/\/complete$/u.test(route)) return 'file_complete';
  if (/\/publish$/u.test(route)) return 'file_publish';
  if (/\/references$/u.test(route)) return 'file_reference';
  if (/\/resume$/u.test(route)) return 'file_resume';
  if (/\/versions$/u.test(route)) return 'file_version';
  if (/\/sync-state$/u.test(route)) return 'file_sync_state';
  if (/\/file-policy$/u.test(route)) return 'file_policy';
  if (/\/input-assets(?:\/|$)/u.test(route)) return 'input_asset';
  if (/\/artifact-uploads(?:\/|$)/u.test(route)) return 'artifact_upload';
  return 'artifact_manifest';
}

export function remoteFileRequestFailureFields(result: string, error: unknown, response?: Response): Record<string, unknown> {
  const stages: Record<string, string> = { local_deferred: 'local_admission', preflight_failed: 'before_send', transport_failed: 'transport',
    local_processing_failed: 'local_processing', response_rejected: 'api', response_invalid: 'protocol', context_changed: 'context', cancelled: 'context' };
  let metadata: Record<string, unknown> = {};
  try { metadata = remoteSyncErrorMetadata(error); } catch { /* Preserve the result if diagnostic metadata is unavailable. */ }
  const { authStatus, authFailureKind, transportFailure, transportErrorType, transportSystemCode } = metadata;
  const authFailure = authStatus && !transportFailure && !transportErrorType;
  return { authStatus, authFailureKind, transportFailure, transportErrorType, transportSystemCode,
    failure_stage: authFailure ? 'auth' : stages[result] || 'transport',
    reason: remoteFileTelemetryReason(error), http_status: response?.status }; 
}


export function remoteFileRequestBytes(body: unknown): number | undefined {
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}
