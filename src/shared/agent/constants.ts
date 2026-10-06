export const AgentId = {
  Main: 'main',
} as const;

export type AgentId = typeof AgentId[keyof typeof AgentId];

export const AgentIpcChannel = {
  List: 'agents:list',
  Get: 'agents:get',
  Create: 'agents:create',
  Update: 'agents:update',
  Reorder: 'agents:reorder',
  Delete: 'agents:delete',
  CleanupLegacyIdentityBlock: 'agents:cleanupLegacyIdentityBlock',
  Presets: 'agents:presets',
  PresetTemplates: 'agents:presetTemplates',
  AddPreset: 'agents:addPreset',
} as const;

export type AgentIpcChannel = typeof AgentIpcChannel[keyof typeof AgentIpcChannel];

export const AgentLegacyIdentityCleanupStatus = {
  Cleaned: 'cleaned',
  Skipped: 'skipped',
  Failed: 'failed',
} as const;

export type AgentLegacyIdentityCleanupStatus =
  typeof AgentLegacyIdentityCleanupStatus[keyof typeof AgentLegacyIdentityCleanupStatus];

export const AgentLegacyIdentityCleanupSkipReason = {
  NoAgentsMd: 'no-agents-md',
  NoLegacyBlock: 'no-legacy-block',
  LowConfidence: 'low-confidence',
} as const;

export type AgentLegacyIdentityCleanupSkipReason =
  typeof AgentLegacyIdentityCleanupSkipReason[keyof typeof AgentLegacyIdentityCleanupSkipReason];

export type AgentLegacyIdentityCleanupResult =
  | {
      status: typeof AgentLegacyIdentityCleanupStatus.Cleaned;
      backupPath: string;
      removedChars: number;
    }
  | {
      status: typeof AgentLegacyIdentityCleanupStatus.Skipped;
      reason: AgentLegacyIdentityCleanupSkipReason;
    }
  | {
      status: typeof AgentLegacyIdentityCleanupStatus.Failed;
      error: string;
    };

export const LegacyAgentName = {
  Main: 'main',
} as const;

export const DefaultAgentProfile = {
  Name: 'LobsterAI',
} as const;
