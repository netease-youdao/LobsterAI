export type AgentSource = 'custom' | 'preset';

export interface Agent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  identity: string;
  model: string;
  icon: string;
  skillIds: string[];
  enabled: boolean;
  isDefault: boolean;
  source: AgentSource;
  presetId: string;
  createdAt: number;
  updatedAt: number;
}

export interface PresetAgent {
  id: string;
  name: string;
  icon: string;
  description: string;
  systemPrompt: string;
  skillIds: string[];
  installed: boolean;
}

export interface CreateAgentRequest {
  id?: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  identity?: string;
  model?: string;
  icon?: string;
  skillIds?: string[];
  source?: string;
  presetId?: string;
}

export interface UpdateAgentRequest {
  name?: string;
  description?: string;
  systemPrompt?: string;
  identity?: string;
  model?: string;
  icon?: string;
  skillIds?: string[];
  enabled?: boolean;
}
