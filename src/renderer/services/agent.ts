import {
  AgentId,
  type AgentLegacyIdentityCleanupResult,
  AgentLegacyIdentityCleanupStatus,
  AgentModelSelectionMode,
  AgentSource,
  normalizeSubagentCollaborationMode,
  type SubagentCollaborationMode,
} from '@shared/agent';
import { usesInheritedAgentModel } from '@shared/agent/modelSelection';
import { type ExpertCatalog, ExpertUiEvent, ExpertUpgradeStatus } from '@shared/agent/presets';

import { store } from '../store';
import {
  addAgent,
  removeAgent,
  setAgents,
  setCurrentAgentId,
  setExpertRevisions,
  setLoading,
  updateAgent as updateAgentAction,
} from '../store/slices/agentSlice';
import { clearCurrentSession } from '../store/slices/coworkSlice';
import { clearAgentSelectedModel } from '../store/slices/modelSlice';
import { clearActiveSkills, setActiveSkillIds } from '../store/slices/skillSlice';
import type { Agent, PresetAgent } from '../types/agent';
import { i18nService } from './i18n';
import { captureExpertModelSelection } from './newTaskModelSelection';
import { resetDraftAnalytics } from './usageAnalytics';

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
  private watchingExternalChanges = false;

  async upgradePreset(agentId: string, revision: number) {
    const status = await window.electron.agents.upgradePreset(agentId, revision);
    if (status === ExpertUpgradeStatus.Updated) await this.loadAgents();
    return status;
  }

  isExpertBusy(agentId: string): Promise<boolean> {
    return window.electron.agents.isExpertBusy(agentId);
  }

  async dismissPresetUpdate(agentId: string, revision: number): Promise<boolean> {
    const dismissed = await window.electron.agents.dismissPresetUpdate(agentId, revision);
    if (dismissed) await this.loadAgents();
    return dismissed;
  }

  async loadExpertCatalog(): Promise<ExpertCatalog> {
    const catalog = await window.electron.agents.expertCatalog();
    const revisions: Record<string, number> = {};
    for (const expert of catalog.experts) {
      if (expert.revision !== undefined) revisions[expert.id] = expert.revision;
    }
    store.dispatch(setExpertRevisions(revisions));
    return catalog;
  }

  async loadAgents(): Promise<void> {
    if (!this.watchingExternalChanges) {
      // Agents edited in another window (e.g. the desktop companion's composer) reload here too.
      this.watchingExternalChanges = true;
      window.electron?.agents?.onChanged?.(() => { void this.loadAgents(); });
    }
    store.dispatch(setLoading(true));
    try {
      const agents = await window.electron?.agents?.list();
      if (agents) {
        const mappedAgents = agents.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          icon: a.icon,
          iconCustomized: a.iconCustomized,
          model: a.model ?? '',
          modelSelectionMode: a.modelSelectionMode,
          thinkingLevel: a.thinkingLevel ?? '',
          workingDirectory: a.workingDirectory ?? '',
          enabled: a.enabled,
          pinned: a.pinned ?? false,
          pinOrder: a.pinOrder ?? null,
          sortOrder: a.sortOrder ?? null,
          isDefault: a.isDefault,
          source: a.source,
          presetId: a.presetId,
          presetRevision: a.presetRevision,
          dismissedPresetRevision: a.dismissedPresetRevision,
          skillIds: a.skillIds ?? [],
          subagentCollaborationMode: normalizeSubagentCollaborationMode(a.subagentCollaborationMode),
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
    subagentCollaborationMode?: SubagentCollaborationMode;
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
          iconCustomized: agent.iconCustomized,
          model: agent.model ?? '',
          modelSelectionMode: agent.modelSelectionMode,
          thinkingLevel: agent.thinkingLevel ?? '',
          workingDirectory: agent.workingDirectory ?? '',
          enabled: agent.enabled,
          pinned: agent.pinned ?? false,
          pinOrder: agent.pinOrder ?? null,
          sortOrder: agent.sortOrder ?? null,
          isDefault: agent.isDefault,
          source: agent.source,
          presetId: agent.presetId,
          presetRevision: agent.presetRevision,
          skillIds: agent.skillIds ?? [],
          subagentCollaborationMode: normalizeSubagentCollaborationMode(agent.subagentCollaborationMode),
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
    modelSelectionMode?: AgentModelSelectionMode;
    thinkingLevel?: Agent['thinkingLevel'];
    workingDirectory?: string;
    icon?: string;
    skillIds?: string[];
    subagentCollaborationMode?: SubagentCollaborationMode;
    subagentAllowAgentIds?: string[];
    enabled?: boolean;
    pinned?: boolean;
    sortOrder?: number | null;
  }): Promise<Agent | null> {
    try {
      const effectiveUpdates = updates.modelSelectionMode === AgentModelSelectionMode.Inherit
        ? { ...updates, ...captureExpertModelSelection(store.getState(), id) } : updates;
      const agent = await window.electron?.agents?.update(id, effectiveUpdates);
      if (agent) {
        if (effectiveUpdates.model !== undefined) {
          // Agent.model is now authoritative for virtual models too.
          const cleared = await window.electron.modelPresets.setPreference(id, null);
          if (!cleared.success) throw new Error(cleared.error || i18nService.t('agentSaveFailed'));
          store.dispatch(clearAgentSelectedModel(id));
        }
        const skillIds = agent.skillIds ?? [];
        store.dispatch(updateAgentAction({
          id: agent.id,
          updates: {
            name: agent.name,
            description: agent.description,
            icon: agent.icon,
            iconCustomized: agent.iconCustomized,
            model: agent.model ?? '',
            modelSelectionMode: agent.modelSelectionMode,
            thinkingLevel: agent.thinkingLevel ?? '',
            workingDirectory: agent.workingDirectory ?? '',
            enabled: agent.enabled,
            pinned: agent.pinned ?? false,
            pinOrder: agent.pinOrder ?? null,
            sortOrder: agent.sortOrder ?? null,
            skillIds,
            subagentCollaborationMode: normalizeSubagentCollaborationMode(agent.subagentCollaborationMode),
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
        iconCustomized: agent.iconCustomized,
        model: agent.model ?? '',
        modelSelectionMode: agent.modelSelectionMode,
        thinkingLevel: agent.thinkingLevel ?? '',
        workingDirectory: agent.workingDirectory ?? '',
        enabled: agent.enabled,
        pinned: agent.pinned ?? false,
        pinOrder: agent.pinOrder ?? null,
        sortOrder: agent.sortOrder ?? null,
        isDefault: agent.isDefault,
        source: agent.source,
        presetId: agent.presetId,
        presetRevision: agent.presetRevision,
        skillIds: agent.skillIds ?? [],
        subagentCollaborationMode: normalizeSubagentCollaborationMode(agent.subagentCollaborationMode),
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
      window.dispatchEvent?.(new Event(ExpertUiEvent.Preparing));
      const state = store.getState();
      const existing = state.agent.agents.find(agent => agent.source === AgentSource.Preset && agent.presetId === presetId);
      const modelSelection = captureExpertModelSelection(state, existing?.id);
      const agent = await window.electron?.agents?.addPreset(presetId, modelSelection);
      if (agent) {
        if (usesInheritedAgentModel(agent)) {
          const cleared = await window.electron.modelPresets?.setPreference(agent.id, null);
          if (cleared && !cleared.success) throw new Error(cleared.error || i18nService.t('agentSaveFailed'));
          store.dispatch(clearAgentSelectedModel(agent.id));
        }
        store.dispatch(addAgent({
          id: agent.id,
          name: agent.name,
          description: agent.description,
          icon: agent.icon,
          iconCustomized: agent.iconCustomized,
          model: agent.model ?? '',
          modelSelectionMode: agent.modelSelectionMode,
          thinkingLevel: agent.thinkingLevel ?? '',
          workingDirectory: agent.workingDirectory ?? '',
          enabled: agent.enabled,
          pinned: agent.pinned ?? false,
          pinOrder: agent.pinOrder ?? null,
          sortOrder: agent.sortOrder ?? null,
          isDefault: agent.isDefault,
          source: agent.source,
          presetId: agent.presetId,
          presetRevision: agent.presetRevision,
          skillIds: agent.skillIds ?? [],
          subagentCollaborationMode: normalizeSubagentCollaborationMode(agent.subagentCollaborationMode),
          subagentAllowAgentIds: agent.subagentAllowAgentIds ?? [],
        }));
        return agent;
      }
      return null;
    } catch (error) {
      console.error('Failed to add preset agent:', error);
      throw error;
    }
  }

  switchAgent(agentId: string, options: SwitchAgentOptions = {}): void {
    resetDraftAnalytics();
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
