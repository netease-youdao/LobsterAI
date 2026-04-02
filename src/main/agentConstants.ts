// ─── Agent Import/Export IPC Channels ────────────────────────────────────────

export const AgentIpcChannel = {
  Export: 'agents:export',
  ImportFile: 'agents:importFile',
  ImportConfirm: 'agents:importConfirm',
} as const;
export type AgentIpcChannel = typeof AgentIpcChannel[keyof typeof AgentIpcChannel];

// ─── Agent Import/Export Types ───────────────────────────────────────────────

/** Portable agent fields included in export (excludes instance-local state). */
export interface ExportedAgent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  identity: string;
  model: string;
  icon: string;
  skillIds: string[];
  source: string;
  presetId: string;
}

/** Top-level envelope for agent export JSON files. */
export interface AgentExportEnvelope {
  version: number;
  exportedAt: string;
  agents: ExportedAgent[];
}

/** Describes a conflict between an imported agent and an existing one. */
export interface AgentConflict {
  id: string;
  name: string;
  existingAgentName: string;
  incomingAgentName: string;
}

/** User's resolution choice for a single import conflict. */
export const ImportResolutionAction = {
  Overwrite: 'overwrite',
  CreateNew: 'createNew',
  Skip: 'skip',
} as const;
export type ImportResolutionAction = typeof ImportResolutionAction[keyof typeof ImportResolutionAction];

export interface ImportResolution {
  id: string;
  action: ImportResolutionAction;
}

// ─── IPC Response Types ─────────────────────────────────────────────────────

export interface AgentExportResponse {
  success: boolean;
  filePath?: string;
  error?: string;
}

export interface AgentImportFileResponse {
  success: boolean;
  imported?: Array<{ id: string; name: string }>;
  conflicts?: AgentConflict[];
  error?: string;
}

export interface AgentImportConfirmResponse {
  success: boolean;
  importedCount?: number;
  error?: string;
}
