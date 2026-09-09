/** Remote transport values are shared by main, preload and settings. */
export const RemoteIpc = {
  Changed: 'remote:changed', State: 'remote:state', Configure: 'remote:configure', Decide: 'remote:decide',
} as const;
export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_TEXT_BYTES = 16 * 1024;
export const REMOTE_MESSAGE_BYTES = 512 * 1024;
export const RemoteRunStatus = {
  Starting: 'starting', Running: 'running', WaitingApproval: 'waiting_approval',
  WaitingLocal: 'waiting_local', Cancelling: 'cancelling', Reconciling: 'reconciling',
  Succeeded: 'succeeded', Failed: 'failed', Cancelled: 'cancelled', Interrupted: 'interrupted',
} as const;
export type RemoteRunStatusValue = typeof RemoteRunStatus[keyof typeof RemoteRunStatus];
export interface RemoteOwner { userId: string; scopeKey: string }
export interface RemoteWorkspace { workspaceId: string; name: string; available: boolean }
export const RemoteCapability = { CreateSession: 'session.create', SameAccountAccess: 'same_account_access' } as const;
export const RemoteConnectionStatus = { Online: 'online', Offline: 'offline' } as const;
export const RemoteConnectionReason = {
  Connecting: 'connecting', Reconnecting: 'reconnecting', Disabled: 'disabled', SignedOut: 'signed_out',
  ServerUpgradeRequired: 'server_upgrade_required', ServerUnavailable: 'server_unavailable',
  DeviceUnavailable: 'device_unavailable', WorkspaceUnavailable: 'workspace_unavailable',
} as const;
export type RemoteConnectionReasonValue = typeof RemoteConnectionReason[keyof typeof RemoteConnectionReason];
export const RemoteSyncStatus = { Synced: 'synced', Pending: 'pending', Error: 'error' } as const;
export interface RemoteSettingsState {
  screenLocked?: boolean; hostName?: string; stateRevision?: number;
  connectionStatus?: typeof RemoteConnectionStatus[keyof typeof RemoteConnectionStatus];
  connectionReason?: RemoteConnectionReasonValue; errorCode?: number;
  settingsSyncStatus?: typeof RemoteSyncStatus[keyof typeof RemoteSyncStatus];
  nameSyncStatus?: typeof RemoteSyncStatus[keyof typeof RemoteSyncStatus];
  keepAwakeEnabled?: boolean; keepAwakeActive?: boolean; keepAwakeError?: string;
  enabled: boolean; connected: boolean; deviceId?: string; name: string;
  owner: RemoteOwner | null; workspaces: RemoteWorkspace[]; error?: string;
  accessRequests: Array<{ requestId: string; mobileDevice: { deviceId: string; name: string; platform: string }; permissions: string[]; expiresAt?: string }>;
}
export interface RemoteConfigureRequest { keepAwakeEnabled?: boolean; retry?: boolean; enabled?: boolean; name?: string; addWorkspace?: boolean; removeWorkspaceId?: string }
export interface RemoteSettingsApi {
  onChanged(listener: (state: RemoteSettingsState) => void): () => void;
  state(): Promise<RemoteSettingsState>;
  configure(input: RemoteConfigureRequest): Promise<RemoteSettingsState>;
  decide(requestId: string, decision: 'approve' | 'deny'): Promise<RemoteSettingsState>;
}
