import type { RemoteOwner } from './constants';

export const RemoteAgentSettings = { Capability: 'agent_settings_v1', SchemaVersion: 1, MaxBatchBytes: 524288 } as const;
export const RemoteAgentSettingsSection = { Model: 'model', Collaboration: 'collaboration', Identity: 'identity', Memory: 'memory', UserProfile: 'userProfile' } as const;
export type RemoteAgentSettingsSection = typeof RemoteAgentSettingsSection[keyof typeof RemoteAgentSettingsSection];
export const RemoteAgentSettingsAction = { Read: 'read', DirectUpdate: 'directUpdate', ConversationUpdate: 'conversationUpdate' } as const;
export const RemoteAgentSettingsIpc = { State: 'remote:agent-settings:state', Authorize: 'remote:agent-settings:authorize', Revoke: 'remote:agent-settings:revoke' } as const;
export const RemoteAgentSettingsStatus = { Active: 'active', Pending: 'pending', Revoked: 'revoked' } as const;
export interface RemoteAgentSettingsPermission { read: boolean; directUpdate: boolean; conversationUpdate: boolean }
export type RemoteAgentSettingsPermissions = Record<RemoteAgentSettingsSection, RemoteAgentSettingsPermission>;
export interface RemoteAgentSettingsBinding {
  bindingId: string; bindingVersion: string; mobileDeviceId: string; agentId: string;
  grantId: string; grantVersion: string; accountEpoch: string; sections: RemoteAgentSettingsPermissions;
  status: typeof RemoteAgentSettingsStatus[keyof typeof RemoteAgentSettingsStatus];
}
export interface RemoteAgentSettingsCandidate { mobileDeviceId: string; name: string; grantId: string; grantVersion: string }
export interface RemoteAgentSettingsAccessState {
  supported: boolean; conversationReady: boolean; accountEpoch: string; owner: RemoteOwner | null;
  candidates: Array<RemoteAgentSettingsCandidate & { shortLabel?: string }>; agents: Array<{ agentId: string; name: string }>;
  bindings: Array<RemoteAgentSettingsBinding & { shortLabel?: string }>;
}
export interface RemoteAgentSettingsAuthorization {
  expectedAccountEpoch: string; agentId: string; mobileDeviceId: string; grantId: string; grantVersion: string;
  sections: RemoteAgentSettingsPermissions;
}
export interface RemoteAgentSettingsRevoke { expectedAccountEpoch: string; bindingId: string; bindingVersion: string }
export interface RemoteAgentSettingsApi {
  agentSettingsState(): Promise<RemoteAgentSettingsAccessState>;
  authorizeAgentSettings(input: RemoteAgentSettingsAuthorization): Promise<RemoteAgentSettingsAccessState>;
  revokeAgentSettings(input: RemoteAgentSettingsRevoke): Promise<RemoteAgentSettingsAccessState>;
}
export function emptyAgentSettingsPermissions(): RemoteAgentSettingsPermissions {
  return Object.fromEntries(Object.values(RemoteAgentSettingsSection).map(section => [section,
    { read: false, directUpdate: false, conversationUpdate: false }])) as RemoteAgentSettingsPermissions;
}
