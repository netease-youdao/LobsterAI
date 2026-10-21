import type { AgentSource } from '@shared/agent/constants';
import type { ModelThinkingLevel } from '@shared/providers/modelThinking';

export type { AgentSource } from '@shared/agent/constants';

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
  iconCustomized?: boolean;
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

export type { PresetAgent } from '@shared/agent/presets';

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
