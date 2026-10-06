import type { ModelThinkingLevel } from '@shared/providers/modelThinking';

export type AgentSource = 'custom' | 'preset';

export interface Agent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  identity: string;
  model: string;
  thinkingLevel: ModelThinkingLevel | '';
  workingDirectory: string;
  icon: string;
  skillIds: string[];
  subagentAllowAgentIds: string[];
  enabled: boolean;
  pinned: boolean;
  pinOrder?: number | null;
  sortOrder?: number | null;
  isDefault: boolean;
  source: AgentSource;
  presetId: string;
  createdAt: number;
  updatedAt: number;
}

export interface PresetAgent {
  id: string;
  name: string;
  nameEn: string;
  icon: string;
  description: string;
  descriptionEn: string;
  identity: string;
  identityEn: string;
  systemPrompt: string;
  systemPromptEn: string;
  skillIds: string[];
  installed?: boolean;
}

export interface CreateAgentRequest {
  id?: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  identity?: string;
  model?: string;
  thinkingLevel?: ModelThinkingLevel | '';
  workingDirectory?: string;
  icon?: string;
  skillIds?: string[];
  subagentAllowAgentIds?: string[];
  source?: string;
  presetId?: string;
}

export interface UpdateAgentRequest {
  name?: string;
  description?: string;
  systemPrompt?: string;
  identity?: string;
  model?: string;
  thinkingLevel?: ModelThinkingLevel | '';
  workingDirectory?: string;
  icon?: string;
  skillIds?: string[];
  subagentAllowAgentIds?: string[];
  enabled?: boolean;
  pinned?: boolean;
  sortOrder?: number | null;
}
