import { RemoteTelemetryEvent, RemoteTelemetryResult } from '../../shared/remote/telemetry';
import { remoteSyncErrorMetadata, remoteSyncRequestMetadata } from './remoteSyncLog';

export const RemoteBridgeTelemetry = {
  Stage: RemoteTelemetryEvent.SyncStage, Reconciled: RemoteTelemetryEvent.Reconciled, Capability: RemoteTelemetryEvent.Capability,
  CommandPrepared: RemoteTelemetryEvent.CommandPrepared, CommandDuplicate: RemoteTelemetryEvent.CommandDuplicate,
  CommandUnknown: RemoteTelemetryEvent.CommandUnknown, CommandReceipt: RemoteTelemetryEvent.CommandReceipt,
  InputPreparation: RemoteTelemetryEvent.Preparation,
} as const;

const routes: Array<[RegExp, string, string]> = [
  [/^\/control\//u, 'control_operation', 'control'],
  [/^\/sync\/live-projections/u, 'live_projection', 'live'],
  [/^\/sync\//u, 'unknown', 'history'],
  [/\/input-preparations(?:\/|$)/u, 'input_preparation', 'control'],
  [/\/session-deletions(?:\/|$)/u, 'deletion', 'control'],
  [/\/commands(?:\/|$)/u, 'command', 'control'],
  [/\/reply-content(?:\/|$)/u, 'reply_content', 'live'],
  [/\/(?:agents|models)(?:\/|$)/u, 'catalog', 'control'],
  [/\/(?:settings|name|access-requests)(?:\/|$)/u, 'connection', 'control'],
  [/^\/(?:devices|connection-tickets|capabilities)(?:\/|$)/u, 'connection', 'control'],
];

/** The raw path/body never enter the upload contract. */
export function remoteRequestTelemetryFields(pathname: string, method: string, body: unknown, apiVersion: number): Record<string, unknown> {
  const path = pathname.split('?')[0];
  const route = routes.find(([pattern]) => pattern.test(path));
  const metadata = remoteSyncRequestMetadata(path, body);
  return { ...metadata, operation: metadata?.operation ?? route?.[1] ?? 'unknown', lane: route?.[2] ?? 'control',
    method, apiVersion: String(apiVersion), requestFamily: 'remote_json' };
}

export function remoteRequestTelemetryOutcome(error: unknown, stage: string): string {
  const data = remoteSyncErrorMetadata(error);
  if (data.transportFailure === 'REMOTE_NETWORK_ADMISSION_BUSY') return RemoteTelemetryResult.Deferred;
  if (data.validation === 'Account changed during remote request' || data.validation === 'Account changed during remote response') return RemoteTelemetryResult.ContextChanged;
  if (data.validation === 'Invalid remote response' || data.validation === 'Remote response is too large') return RemoteTelemetryResult.Invalid;
  if (data.errorType === 'AbortError' && !data.transportFailure) return RemoteTelemetryResult.Cancelled;
  if (data.authStatus && !data.transportFailure && !data.transportErrorType) return RemoteTelemetryResult.Preflight;
  if (data.httpStatus > 0) return RemoteTelemetryResult.Rejected;
  if (stage === 'prepare') return RemoteTelemetryResult.Preflight;
  return data.transportFailure || data.errorType === 'TimeoutError' ? RemoteTelemetryResult.Transport : RemoteTelemetryResult.Unknown;
}


export function remoteRequestTelemetryFailureStage(error: unknown, stage: string): string {
  const data = remoteSyncErrorMetadata(error);
  if (data.transportFailure === 'REMOTE_NETWORK_ADMISSION_BUSY') return 'local_admission';
  if (data.authStatus && !data.transportFailure && !data.transportErrorType) return 'auth';
  return stage;
}
