export const RemoteAgentSettings = { Capability: 'agent_settings_v1', SchemaVersion: 1, MaxBatchBytes: 524288 } as const;
export const RemoteAgentSettingsSection = { Model: 'model', Collaboration: 'collaboration', Identity: 'identity', Memory: 'memory', UserProfile: 'userProfile' } as const;
export type RemoteAgentSettingsSection = typeof RemoteAgentSettingsSection[keyof typeof RemoteAgentSettingsSection];
export const RemoteAgentSettingsAction = { Read: 'read', DirectUpdate: 'directUpdate', ConversationUpdate: 'conversationUpdate' } as const;
export const RemoteAgentSettingsStatus = { Active: 'active', Pending: 'pending', Revoked: 'revoked' } as const;
export interface RemoteAgentSettingsPermission { read: boolean; directUpdate: boolean; conversationUpdate: boolean }
export type RemoteAgentSettingsPermissions = Record<RemoteAgentSettingsSection, RemoteAgentSettingsPermission>;
export interface RemoteAgentSettingsBinding {
  bindingId: string; bindingVersion: string; mobileDeviceId: string; agentId: string;
  grantId: string; grantVersion: string; accountEpoch: string; sections: RemoteAgentSettingsPermissions;
  status: typeof RemoteAgentSettingsStatus[keyof typeof RemoteAgentSettingsStatus];
}
export interface RemoteAgentSettingsCandidate { mobileDeviceId: string; name: string; grantId: string; grantVersion: string }
export interface RemoteAgentSettingsAuthorization {
  expectedAccountEpoch: string; agentId: string; mobileDeviceId: string; grantId: string; grantVersion: string;
  sections: RemoteAgentSettingsPermissions;
}
export function emptyAgentSettingsPermissions(): RemoteAgentSettingsPermissions {
  return Object.fromEntries(Object.values(RemoteAgentSettingsSection).map(section => [section,
    { read: false, directUpdate: false, conversationUpdate: false }])) as RemoteAgentSettingsPermissions;
}

export function sameAccountAgentSettingsPermissions(conversationReady: boolean): RemoteAgentSettingsPermissions {
  return Object.fromEntries(Object.values(RemoteAgentSettingsSection).map(section => {
    const direct = section === RemoteAgentSettingsSection.Model || section === RemoteAgentSettingsSection.Collaboration;
    return [section, { read: true, directUpdate: direct, conversationUpdate: !direct && conversationReady }];
  })) as RemoteAgentSettingsPermissions;
}
