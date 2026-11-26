export const AgentId = {
  Main: 'main',
} as const;

export type AgentId = typeof AgentId[keyof typeof AgentId];

export const AgentSource = {
  Custom: 'custom',
  Preset: 'preset',
} as const;

export type AgentSource = typeof AgentSource[keyof typeof AgentSource];

export const AgentModelSelectionMode = {
  Inherit: 'inherit',
  Explicit: 'explicit',
} as const;
export type AgentModelSelectionMode = typeof AgentModelSelectionMode[keyof typeof AgentModelSelectionMode];

export const SubagentCollaborationMode = {
  All: 'all',
  Allowlist: 'allowlist',
  Disabled: 'disabled',
} as const;
export type SubagentCollaborationMode =
  typeof SubagentCollaborationMode[keyof typeof SubagentCollaborationMode];

export function normalizeSubagentCollaborationMode(
  raw: unknown,
  fallback: SubagentCollaborationMode = SubagentCollaborationMode.All,
): SubagentCollaborationMode {
  if (
    raw === SubagentCollaborationMode.All
    || raw === SubagentCollaborationMode.Allowlist
    || raw === SubagentCollaborationMode.Disabled
  ) {
    return raw;
  }
  return fallback;
}

export const AgentIpcChannel = {
  List: 'agents:list',
  Get: 'agents:get',
  Create: 'agents:create',
  Update: 'agents:update',
  Reorder: 'agents:reorder',
  Delete: 'agents:delete',
  GenerateDraft: 'agents:generateDraft',
  GenerateDraftChunk: 'agents:generateDraft:chunk',
  CancelDraft: 'agents:generateDraft:cancel',
  CleanupLegacyIdentityBlock: 'agents:cleanupLegacyIdentityBlock',
  Presets: 'agents:presets',
  PresetTemplates: 'agents:presetTemplates',
  ExpertCatalog: 'agents:expertCatalog',
  AddPreset: 'agents:addPreset',
  UpgradePreset: 'agents:upgradePreset',
  DismissPresetUpdate: 'agents:dismissPresetUpdate',
  IsExpertBusy: 'agents:isExpertBusy',
  /** Main to renderer: agents were changed by another window. */
  Changed: 'agents:changed',
} as const;

export type AgentIpcChannel = typeof AgentIpcChannel[keyof typeof AgentIpcChannel];

export const AgentUiEvent = {
  OpenImSettings: 'agent:open-im-settings',
  OpenMemorySettings: 'agent:open-memory-settings',
} as const;

export type AgentUiEvent = typeof AgentUiEvent[keyof typeof AgentUiEvent];

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

export const AgentOwnerKind = {
  Default: 'default',
  Owned: 'owned',
  Anonymous: 'anonymous',
  Quarantined: 'quarantined',
} as const;
export type AgentOwnerKind = typeof AgentOwnerKind[keyof typeof AgentOwnerKind];

export const AgentAccessErrorCode = {
  Unavailable: 'agentAccessUnavailable',
  IdentityReused: 'agentIdentityReused',
  DefaultProtected: 'agentDefaultProtected',
  ForeignSessions: 'agentForeignSessions',
  Busy: 'agentDeleteBusy',
  AccountChanged: 'agentAccountChanged',
} as const;
export type AgentAccessErrorCode = typeof AgentAccessErrorCode[keyof typeof AgentAccessErrorCode];
