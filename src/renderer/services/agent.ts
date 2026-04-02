import { store } from '../store';
import {
  setAgents,
  setCurrentAgentId,
  setLoading,
  addAgent,
  updateAgent as updateAgentAction,
  removeAgent,
} from '../store/slices/agentSlice';
import { setActiveSkillIds, clearActiveSkills } from '../store/slices/skillSlice';
import { clearCurrentSession } from '../store/slices/coworkSlice';
import type { Agent, PresetAgent } from '../types/agent';

class AgentService {
  async loadAgents(): Promise<void> {
    store.dispatch(setLoading(true));
    try {
      const agents = await window.electron?.agents?.list();
      if (agents) {
        store.dispatch(setAgents(agents.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          icon: a.icon,
          enabled: a.enabled,
          isDefault: a.isDefault,
          source: a.source,
          skillIds: a.skillIds ?? [],
        }))));
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
    icon?: string;
    skillIds?: string[];
  }): Promise<Agent | null> {
    try {
      const agent = await window.electron?.agents?.create(request);
      if (agent) {
        store.dispatch(addAgent({
          id: agent.id,
          name: agent.name,
          description: agent.description,
          icon: agent.icon,
          enabled: agent.enabled,
          isDefault: agent.isDefault,
          source: agent.source,
          skillIds: agent.skillIds ?? [],
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
    icon?: string;
    skillIds?: string[];
    enabled?: boolean;
  }): Promise<Agent | null> {
    try {
      const agent = await window.electron?.agents?.update(id, updates);
      if (agent) {
        store.dispatch(updateAgentAction({
          id: agent.id,
          updates: {
            name: agent.name,
            description: agent.description,
            icon: agent.icon,
            enabled: agent.enabled,
            skillIds: agent.skillIds ?? [],
          },
        }));
        return agent;
      }
      return null;
    } catch (error) {
      console.error('Failed to update agent:', error);
      return null;
    }
  }

  async deleteAgent(id: string): Promise<boolean> {
    try {
      const wasCurrentAgent = store.getState().agent.currentAgentId === id;
      await window.electron?.agents?.delete(id);
      store.dispatch(removeAgent(id));
      if (wasCurrentAgent) {
        this.switchAgent('main');
        const { coworkService } = await import('./cowork');
        coworkService.loadSessions('main');
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

  async addPreset(presetId: string): Promise<Agent | null> {
    try {
      const agent = await window.electron?.agents?.addPreset(presetId);
      if (agent) {
        store.dispatch(addAgent({
          id: agent.id,
          name: agent.name,
          description: agent.description,
          icon: agent.icon,
          enabled: agent.enabled,
          isDefault: agent.isDefault,
          source: agent.source,
          skillIds: agent.skillIds ?? [],
        }));
        return agent;
      }
      return null;
    } catch (error) {
      console.error('Failed to add preset agent:', error);
      return null;
    }
  }

  switchAgent(agentId: string): void {
    store.dispatch(setCurrentAgentId(agentId));
    store.dispatch(clearCurrentSession());
    const agent = store.getState().agent.agents.find((a) => a.id === agentId);
    if (agent?.skillIds?.length) {
      store.dispatch(setActiveSkillIds(agent.skillIds));
    } else {
      store.dispatch(clearActiveSkills());
    }
  }

  // --- Import / Export ---

  async exportAgents(agentIds: string[]): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
      const result = await window.electron?.agents?.export(agentIds);
      return result ?? { success: false, error: 'Bridge not available' };
    } catch (error) {
      console.error('Failed to export agents:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Export failed' };
    }
  }

  async importAgents(): Promise<{
    success: boolean;
    imported?: Array<{ id: string; name: string }>;
    conflicts?: Array<{ id: string; name: string; existingAgentName: string; incomingAgentName: string }>;
    error?: string;
  }> {
    try {
      const result = await window.electron?.agents?.importFile();
      if (result?.success && result.imported?.length) {
        // Reload agents to pick up newly imported ones
        await this.loadAgents();
      }
      return result ?? { success: false, error: 'Bridge not available' };
    } catch (error) {
      console.error('Failed to import agents:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Import failed' };
    }
  }

  async confirmImport(resolutions: Array<{ id: string; action: string }>): Promise<{ success: boolean; importedCount?: number; error?: string }> {
    try {
      const result = await window.electron?.agents?.importConfirm(resolutions);
      if (result?.success) {
        // Reload agents to reflect resolved imports
        await this.loadAgents();
      }
      return result ?? { success: false, error: 'Bridge not available' };
    } catch (error) {
      console.error('Failed to confirm import:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Confirm import failed' };
    }
  }
}

export const agentService = new AgentService();
