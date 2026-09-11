/** Remote transport values are shared by main, preload and settings. */
export const RemoteIpc = {
  Changed: 'remote:changed', State: 'remote:state', Configure: 'remote:configure', Decide: 'remote:decide',
} as const;
export const RemoteSettingsError = { AccountChanged: 'remoteAccountChanged' } as const;
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
export const RemoteCapability = { DualApproval: 'approval_dual_control_v1', CreateSession: 'session.create', SameAccountAccess: 'same_account_access', SessionAgent: 'session_agent_v1', AgentCatalog: 'agent_catalog_v1', AgentSelection: 'agent_selection_v1', AgentOwnershipClaim: 'agent_ownership_claim_v1' } as const;
export const RemoteConnectionStatus = { Online: 'online', Offline: 'offline' } as const;
export const RemoteConnectionReason = {
  Connecting: 'connecting', Reconnecting: 'reconnecting', Disabled: 'disabled', SignedOut: 'signed_out',
  ServerUpgradeRequired: 'server_upgrade_required', ServerUnavailable: 'server_unavailable',
  DeviceUnavailable: 'device_unavailable', WorkspaceUnavailable: 'workspace_unavailable',
} as const;
export type RemoteConnectionReasonValue = typeof RemoteConnectionReason[keyof typeof RemoteConnectionReason];
export const RemoteSyncStatus = { Synced: 'synced', Pending: 'pending', Error: 'error' } as const;
export interface RemoteSettingsState {
  screenLocked?: boolean; hostName?: string; stateRevision?: number; accountEpoch?: string;
  connectionStatus?: typeof RemoteConnectionStatus[keyof typeof RemoteConnectionStatus];
  connectionReason?: RemoteConnectionReasonValue; errorCode?: number;
  settingsSyncStatus?: typeof RemoteSyncStatus[keyof typeof RemoteSyncStatus];
  nameSyncStatus?: typeof RemoteSyncStatus[keyof typeof RemoteSyncStatus];
  keepAwakeEnabled?: boolean; keepAwakeActive?: boolean; keepAwakeError?: string;
  enabled: boolean; connected: boolean; deviceId?: string; name: string;
  owner: RemoteOwner | null; workspaces: RemoteWorkspace[]; error?: string;
  accessRequests: Array<{ requestId: string; mobileDevice: { deviceId: string; name: string; platform: string }; permissions: string[]; expiresAt?: string }>;
}
export interface RemoteConfigureRequest { expectedAccountEpoch?: string; keepAwakeEnabled?: boolean; retry?: boolean; enabled?: boolean; name?: string; addWorkspace?: boolean; removeWorkspaceId?: string }
export interface RemoteSettingsApi {
  onChanged(listener: (state: RemoteSettingsState) => void): () => void;
  state(): Promise<RemoteSettingsState>;
  configure(input: RemoteConfigureRequest): Promise<RemoteSettingsState>;
  decide(requestId: string, decision: 'approve' | 'deny'): Promise<RemoteSettingsState>;
}

export const RemoteAgentState = { Available: 'available', Disabled: 'disabled', Deleted: 'deleted', Unknown: 'unknown' } as const;
export const RemoteAgentReason = { Disabled: 'AGENT_DISABLED', WorkspaceUnavailable: 'WORKSPACE_UNAVAILABLE' } as const;
export const REMOTE_AGENT_CATALOG_ITEMS = 200;
export const REMOTE_AGENT_CATALOG_BYTES = 256 * 1024;
export interface RemoteAgentSummary {
  agentId: string; name: string; icon: string | null; kind: 'default' | 'owned' | 'anonymous';
  version: string; state: typeof RemoteAgentState[keyof typeof RemoteAgentState];
}
export interface RemoteAgentCatalogItem {
  agentId: string; name: string; icon: string | null; kind: 'default' | 'owned'; version: string;
  enabled: boolean; defaultWorkspaceId: string | null; workspaceAvailable: boolean;
  unavailableReason: typeof RemoteAgentReason[keyof typeof RemoteAgentReason] | null;
}
