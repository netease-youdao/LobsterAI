import {
  AgentId,
  type AgentLegacyIdentityCleanupResult,
  AgentLegacyIdentityCleanupStatus,
} from '@shared/agent';

import { store } from '../store';
import {
  addAgent,
  removeAgent,
  setAgents,
  setCurrentAgentId,
  setLoading,
  updateAgent as updateAgentAction,
} from '../store/slices/agentSlice';
import { clearCurrentSession } from '../store/slices/coworkSlice';
import { clearAgentSelectedModel } from '../store/slices/modelSlice';
import { clearActiveSkills, setActiveSkillIds } from '../store/slices/skillSlice';
import type { Agent, PresetAgent } from '../types/agent';

const syncActiveSkillsForCurrentAgent = (agentId: string, skillIds: string[]): void => {
  if (store.getState().agent.currentAgentId !== agentId) {
    return;
  }

  if (skillIds.length > 0) {
    store.dispatch(setActiveSkillIds(skillIds));
  } else {
    store.dispatch(clearActiveSkills());
  }
};

interface SwitchAgentOptions {
  targetSessionId?: string;
}

class AgentService {
  async loadAgents(): Promise<void> {
    store.dispatch(setLoading(true));
    try {
      const agents = await window.electron?.agents?.list();
      if (agents) {
        const mappedAgents = agents.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          icon: a.icon,
          model: a.model ?? '',
          thinkingLevel: a.thinkingLevel ?? '',
          workingDirectory: a.workingDirectory ?? '',
          enabled: a.enabled,
          pinned: a.pinned ?? false,
          pinOrder: a.pinOrder ?? null,
          sortOrder: a.sortOrder ?? null,
          isDefault: a.isDefault,
          source: a.source,
          skillIds: a.skillIds ?? [],
          subagentAllowAgentIds: a.subagentAllowAgentIds ?? [],
        }));
        store.dispatch(setAgents(mappedAgents));
      }
    } catch (error) {
      console.error('Failed to load agents:', error);
    } finally {
      store.dispatch(setLoading(false));
    }
  }

  async createAgent(request: {
    name: string;
    description?: string;
    systemPrompt?: string;
    identity?: string;
    model?: string;
    thinkingLevel?: Agent['thinkingLevel'];
    workingDirectory?: string;
    icon?: string;
    skillIds?: string[];
    subagentAllowAgentIds?: string[];
  }): Promise<Agent | null> {
    try {
      const agent = await window.electron?.agents?.create(request);
      if (agent) {
        store.dispatch(addAgent({
          id: agent.id,
          name: agent.name,
          description: agent.description,
          icon: agent.icon,
          model: agent.model ?? '',
          thinkingLevel: agent.thinkingLevel ?? '',
          workingDirectory: agent.workingDirectory ?? '',
          enabled: agent.enabled,
          pinned: agent.pinned ?? false,
          pinOrder: agent.pinOrder ?? null,
          sortOrder: agent.sortOrder ?? null,
          isDefault: agent.isDefault,
          source: agent.source,
          skillIds: agent.skillIds ?? [],
          subagentAllowAgentIds: agent.subagentAllowAgentIds ?? [],
        }));
        return agent;
      }
      return null;
    } catch (error) {
      console.error('Failed to create agent:', error);
      return null;
    }
  }

  async updateAgent(id: string, updates: {
    name?: string;
    description?: string;
    systemPrompt?: string;
    identity?: string;
    model?: string;
    thinkingLevel?: Agent['thinkingLevel'];
    workingDirectory?: string;
    icon?: string;
    skillIds?: string[];
    subagentAllowAgentIds?: string[];
    enabled?: boolean;
    pinned?: boolean;
    sortOrder?: number | null;
  }): Promise<Agent | null> {
    try {
      const agent = await window.electron?.agents?.update(id, updates);
      if (agent) {
        const skillIds = agent.skillIds ?? [];
        store.dispatch(updateAgentAction({
          id: agent.id,
          updates: {
            name: agent.name,
            description: agent.description,
            icon: agent.icon,
            model: agent.model ?? '',
            thinkingLevel: agent.thinkingLevel ?? '',
            workingDirectory: agent.workingDirectory ?? '',
            enabled: agent.enabled,
            pinned: agent.pinned ?? false,
            pinOrder: agent.pinOrder ?? null,
            sortOrder: agent.sortOrder ?? null,
            skillIds,
            subagentAllowAgentIds: agent.subagentAllowAgentIds ?? [],
          },
        }));
        // Only sync active skills when skillIds were explicitly updated,
        // to avoid clearing user's temporary skill selection on unrelated
        // updates (e.g. model change).
        if ('skillIds' in updates) {
          syncActiveSkillsForCurrentAgent(agent.id, skillIds);
        }
        return agent;
      }
      return null;
    } catch (error) {
      console.error('Failed to update agent:', error);
      return null;
    }
  }

  async reorderAgents(agentIds: string[]): Promise<boolean> {
    try {
      const agents = await window.electron?.agents?.reorder(agentIds);
      if (!agents) return false;
      const mappedAgents = agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        icon: agent.icon,
        model: agent.model ?? '',
        thinkingLevel: agent.thinkingLevel ?? '',
        workingDirectory: agent.workingDirectory ?? '',
        enabled: agent.enabled,
        pinned: agent.pinned ?? false,
        pinOrder: agent.pinOrder ?? null,
        sortOrder: agent.sortOrder ?? null,
        isDefault: agent.isDefault,
        source: agent.source,
        skillIds: agent.skillIds ?? [],
        subagentAllowAgentIds: agent.subagentAllowAgentIds ?? [],
      }));
      store.dispatch(setAgents(mappedAgents));
      return true;
    } catch (error) {
      console.error('Failed to reorder agents:', error);
      return false;
    }
  }

  async cleanupLegacyIdentityBlock(id: string): Promise<AgentLegacyIdentityCleanupResult> {
    try {
      const api = window.electron?.agents?.cleanupLegacyIdentityBlock;
      if (!api) {
        return {
          status: AgentLegacyIdentityCleanupStatus.Failed,
          error: 'Agent legacy identity cleanup API is unavailable',
        };
      }
      return await api(id);
    } catch (error) {
      console.warn('Failed to clean legacy agent identity block:', error);
      return {
        status: AgentLegacyIdentityCleanupStatus.Failed,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async deleteAgent(id: string): Promise<boolean> {
    try {
      const wasCurrentAgent = store.getState().agent.currentAgentId === id;
      const deleted = await window.electron?.agents?.delete(id);
      if (!deleted) {
        return false;
      }
      store.dispatch(removeAgent(id));
      store.dispatch(clearAgentSelectedModel(id));
      if (wasCurrentAgent) {
        this.switchAgent(AgentId.Main);
        const { coworkService } = await import('./cowork');
        coworkService.loadSessions(AgentId.Main);
      }
      return true;
    } catch (error) {
      console.error('Failed to delete agent:', error);
      return false;
    }
  }

  async getPresets(): Promise<PresetAgent[]> {
    try {
      const presets = await window.electron?.agents?.presets();
      return presets ?? [];
    } catch (error) {
      console.error('Failed to get presets:', error);
      return [];
    }
  }

  async getPresetTemplates(): Promise<PresetAgent[]> {
    try {
      const presets = await window.electron?.agents?.presetTemplates();
      return presets ?? [];
    } catch (error) {
      console.error('Failed to get preset agent templates:', error);
      return [];
    }
  }

  async addPreset(presetId: string): Promise<Agent | null> {
    try {
      const agent = await window.electron?.agents?.addPreset(presetId);
      if (agent) {
        store.dispatch(addAgent({
          id: agent.id,
          name: agent.name,
          description: agent.description,
          icon: agent.icon,
          model: agent.model ?? '',
          thinkingLevel: agent.thinkingLevel ?? '',
          workingDirectory: agent.workingDirectory ?? '',
          enabled: agent.enabled,
          pinned: agent.pinned ?? false,
          pinOrder: agent.pinOrder ?? null,
          sortOrder: agent.sortOrder ?? null,
          isDefault: agent.isDefault,
          source: agent.source,
          skillIds: agent.skillIds ?? [],
          subagentAllowAgentIds: agent.subagentAllowAgentIds ?? [],
        }));
        return agent;
      }
      return null;
    } catch (error) {
      console.error('Failed to add preset agent:', error);
      return null;
    }
  }

  switchAgent(agentId: string, options: SwitchAgentOptions = {}): void {
    store.dispatch(setCurrentAgentId(agentId));
    store.dispatch(clearCurrentSession(options.targetSessionId
      ? { sessionNavigationTargetId: options.targetSessionId }
      : undefined));
    const agent = store.getState().agent.agents.find((a) => a.id === agentId);
    if (agent?.skillIds?.length) {
      store.dispatch(setActiveSkillIds(agent.skillIds));
    } else {
      store.dispatch(clearActiveSkills());
    }
  }
}

export const agentService = new AgentService();
