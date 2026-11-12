import { parseAgentAvatarImageUrl } from '../shared/agent/avatar';
import { AgentId, AgentModelSelectionMode, AgentSource } from '../shared/agent/constants';
import { usesInheritedAgentModel } from '../shared/agent/modelSelection';
import { usesManagedPresetAvatar } from '../shared/agent/presetAvatar';
import type { ExpertCatalog, PresetAgent } from '../shared/agent/presets';
import type { Agent, CoworkStore, CreateAgentRequest, UpdateAgentRequest } from './coworkStore';
import { presetToCreateRequest } from './presetAgents';

/**
 * AgentManager handles CRUD operations for agents and preset agent installation.
 * Agents are stored in the SQLite `agents` table via CoworkStore.
 */
export class AgentManager {
  private store: CoworkStore;

  constructor(store: CoworkStore, private readonly loadCatalog: () => Promise<ExpertCatalog>) {
    this.store = store;
  }

  listAgents(): Agent[] {
    return this.store.listAgents();
  }

  getAgent(agentId: string): Agent | null {
    return this.store.getAgent(agentId);
  }

  getDefaultAgent(): Agent {
    const agents = this.store.listAgents();
    return agents.find(a => a.isDefault) || agents[0];
  }

  createAgent(request: CreateAgentRequest, defaultModel?: string): Agent {
    return this.store.createAgent({
      ...request,
      model: request.model?.trim() || defaultModel?.trim() || '',
      workingDirectory: request.workingDirectory?.trim() || '',
    });
  }

  updateAgent(agentId: string, updates: UpdateAgentRequest): Agent | null {
    if (updates.modelSelectionMode !== undefined
      && !Object.values(AgentModelSelectionMode).includes(updates.modelSelectionMode)) {
      throw new Error('Invalid agent model selection mode.');
    }
    if (updates.modelSelectionMode === AgentModelSelectionMode.Inherit
      && (agentId === AgentId.Main || this.store.getAgent(agentId)?.source !== AgentSource.Preset)) {
      throw new Error('Only preset experts can inherit a new-task model.');
    }
    return this.store.updateAgent(agentId, {
      ...updates,
      // Explicit edits opt out; automatic preset refreshes write to the store
      // directly so they do not turn an inherited binding into a user choice.
      ...(updates.modelSelectionMode === undefined
        && (updates.model !== undefined || updates.thinkingLevel !== undefined)
        ? { modelSelectionMode: AgentModelSelectionMode.Explicit } : {}),
      ...(updates.workingDirectory !== undefined
        ? { workingDirectory: updates.workingDirectory.trim() }
        : {}),
    });
  }

  reorderAgents(agentIds: string[]): Agent[] {
    return this.store.reorderAgents(agentIds);
  }

  deleteAgent(agentId: string): boolean {
    return this.store.deleteAgent(agentId);
  }

  // --- Preset agents ---

  async getPresetAgents(): Promise<PresetAgent[]> {
    const presets = await this.getAllPresetAgents();
    const existingAgents = this.store.listAgents();
    const existingPresetIds = new Set(
      existingAgents.filter(a => a.source === AgentSource.Preset).map(a => a.presetId)
    );
    // Only return presets that haven't been added yet
    return presets.filter(p => !existingPresetIds.has(p.id));
  }

  async getExpertCatalog(): Promise<ExpertCatalog> {
    const catalog = await this.loadCatalog();
    const presets = new Map(catalog.experts.map(preset => [preset.id, preset]));
    for (const agent of this.store.listAgents()) {
      const icon = presets.get(agent.presetId)?.icon;
      if (icon && parseAgentAvatarImageUrl(icon) && usesManagedPresetAvatar(agent) && agent.icon !== icon) {
        try {
          this.store.updatePresetAgentAvatar(agent.id, icon);
        } catch (error) {
          console.warn('[AgentManager] Failed to refresh preset avatar:', agent.id, error);
        }
      }
    }
    return catalog;
  }

  async getAllPresetAgents(): Promise<PresetAgent[]> {
    return (await this.getExpertCatalog()).experts;
  }

  async addPresetAgent(presetId: string, defaultModel?: string, thinkingLevel: Agent['thinkingLevel'] = ''): Promise<Agent | null> {
    // Reuse the user's instance, including their edits. Summoning also re-enables it.
    const findExisting = () => this.store.listAgents().find(agent => agent.source === AgentSource.Preset && agent.presetId === presetId);
    const reuse = (agent: Agent): Agent | null => {
      const updates: UpdateAgentRequest = {};
      if (!agent.enabled) updates.enabled = true;
      if (usesInheritedAgentModel(agent) && defaultModel !== undefined) {
        const model = defaultModel.trim();
        if (agent.model !== model) updates.model = model;
        if (agent.thinkingLevel !== thinkingLevel) updates.thinkingLevel = thinkingLevel;
      }
      return Object.keys(updates).length > 0 ? this.store.updateAgent(agent.id, updates) : agent;
    };
    const existing = findExisting();
    if (existing) {
      return reuse(existing);
    }

    const preset = (await this.getAllPresetAgents()).find(p => p.id === presetId);
    if (!preset) return null;
    // Concurrent callers can complete the same fetch before the first IPC returns.
    const createdMeanwhile = findExisting();
    if (createdMeanwhile) return reuse(createdMeanwhile);

    return this.store.createAgent({
      ...presetToCreateRequest(preset),
      // A custom/imported agent may already own the legacy preset ID.
      id: this.store.getAgent(preset.id) ? undefined : preset.id,
      model: defaultModel?.trim() || '',
      modelSelectionMode: AgentModelSelectionMode.Inherit,
      thinkingLevel,
      workingDirectory: '',
    });
  }
}
