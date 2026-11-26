/** Device management is HTTP v2; the WebSocket wire protocol remains v1. */
export const REMOTE_CONNECTION_MANAGEMENT_CAPABILITY = 'device_connection_management_v2';
export const RemoteDeviceConnectionState = { Allowed: 'allowed', Removed: 'removed' } as const;
export const RemoteDeviceAdmissionState = {
  Online: 'online', Offline: 'offline', Connecting: 'connecting', Reconnecting: 'reconnecting', QuotaBlocked: 'quota_blocked',
  Disabled: 'disabled', Removed: 'removed', Unknown: 'unknown',
} as const;
export const RemoteConnectionReleaseState = { Pending: 'pending', Released: 'released', NotRequired: 'not_required' } as const;
export const RemoteConnectionSyncState = { Active: 'active', PausedQuota: 'paused_quota', PausedRemoved: 'paused_removed', Pending: 'pending', Error: 'error' } as const;
export const RemoteConnectionAction = { Remove: 'remove', Resume: 'resume' } as const;
export const RemoteConnectionReasonCode = { Removed: 'DEVICE_CONNECTION_REMOVED', VersionConflict: 'CONNECTION_VERSION_CONFLICT', OperationConflict: 'OPERATION_ID_CONFLICT' } as const;
export interface RemoteDeviceConnection {
  deviceId: string; name: string; platform?: string; instanceLabel?: string; hostName?: string; isCurrent?: boolean;
  connectionState: typeof RemoteDeviceConnectionState[keyof typeof RemoteDeviceConnectionState];
  connectionVersion: string;
  admissionState: typeof RemoteDeviceAdmissionState[keyof typeof RemoteDeviceAdmissionState];
  syncState?: typeof RemoteConnectionSyncState[keyof typeof RemoteConnectionSyncState];
  slotOccupied: boolean; slotExpiresAt?: string; blockReason?: string; retryAfterMs?: number;
  canRemove?: boolean; canResume?: boolean; resumeRequiresUpgrade?: boolean;
  releaseState?: typeof RemoteConnectionReleaseState[keyof typeof RemoteConnectionReleaseState];
}
export interface RemoteConnectionsSnapshot {
  supported: boolean; observedAt: string; presenceAvailable: boolean;
  quota: { maxOnlineDesktops: number; onlineSlotsUsed: number | null; scope: string };
  currentDevice: RemoteDeviceConnection | null; connections: RemoteDeviceConnection[];
}
export interface RemoteConnectionOperation {
  requestId: string; deviceId: string;
  connectionState: typeof RemoteDeviceConnectionState[keyof typeof RemoteDeviceConnectionState];
  connectionVersion: string;
  releaseState: typeof RemoteConnectionReleaseState[keyof typeof RemoteConnectionReleaseState];
  nextAction: string;
}
export interface RemoteConnectionsRequest { expectedAccountEpoch?: string }
export interface RemoteConnectionOperationRequest extends RemoteConnectionsRequest { requestId: string }
export interface RemoteConnectionResumeRequest extends RemoteConnectionOperationRequest { expectedConnectionVersion: string }
export interface RemoteConnectionRemoveRequest extends RemoteConnectionResumeRequest { deviceId: string }
