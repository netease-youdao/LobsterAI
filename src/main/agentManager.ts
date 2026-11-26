import { randomUUID } from 'node:crypto';

import { parseAgentAvatarImageUrl } from '../shared/agent/avatar';
import { AgentAccessErrorCode, AgentId, AgentModelSelectionMode, AgentOwnerKind, AgentSource } from '../shared/agent/constants';
import { usesInheritedAgentModel } from '../shared/agent/modelSelection';
import { usesManagedPresetAvatar } from '../shared/agent/presetAvatar';
import type { ExpertCatalog, PresetAgent } from '../shared/agent/presets';
import type { RemoteOwner } from '../shared/remote/constants';
import { AgentAccessError, sameAgentOwner } from './agentOwnership';
import type { Agent, CoworkStore, CreateAgentRequest, UpdateAgentRequest } from './coworkStore';
import { assertAgentSettingsLocalWriteAllowed } from './libs/agentSettingsConversation/runtime';
import { presetToCreateRequest } from './presetAgents';

/** Renderer-facing CRUD; internal runtime consumers continue to use raw CoworkStore reads. */
export class AgentManager {
  constructor(
    private readonly store: CoworkStore,
    private readonly loadCatalog: () => Promise<ExpertCatalog>,
    private readonly getOwner: () => RemoteOwner | null = () => null,
  ) {}

  captureOwner(): RemoteOwner | null {
    const owner = this.getOwner();
    return owner ? { ...owner } : null;
  }

  assertCurrentOwner(owner: RemoteOwner | null): void {
    if (!sameAgentOwner(owner, this.getOwner())) throw new AgentAccessError(AgentAccessErrorCode.AccountChanged);
  }

  assertAgentAccess(agentId: string): void {
    this.store.assertAgentAccess(agentId, this.getOwner());
  }

  listAgents(): Agent[] {
    return this.store.listVisibleAgents(this.getOwner());
  }

  getAgent(agentId: string): Agent | null {
    return this.store.getVisibleAgent(agentId, this.getOwner());
  }

  getDefaultAgent(): Agent {
    this.assertAgentAccess(AgentId.Main);
    return this.store.getAgent(AgentId.Main)!;
  }

  private assertSubagentAccess(ids: string[] | undefined, owner: RemoteOwner | null): void {
    ids?.forEach(id => this.store.assertAgentAccess(id, owner));
  }

  createAgent(request: CreateAgentRequest, defaultModel?: string): Agent {
    const owner = this.captureOwner();
    this.assertSubagentAccess(request.subagentAllowAgentIds, owner);
    return this.store.createAgent({
      ...request,
      id: request.id || randomUUID(),
      model: request.model?.trim() || defaultModel?.trim() || '',
      workingDirectory: request.workingDirectory?.trim() || '',
    }, owner);
  }

  updateAgent(agentId: string, updates: UpdateAgentRequest): Agent | null {
    assertAgentSettingsLocalWriteAllowed(agentId);
    const owner = this.captureOwner();
    this.store.assertAgentAccess(agentId, owner);
    this.assertSubagentAccess(updates.subagentAllowAgentIds, owner);
    if (updates.modelSelectionMode !== undefined
      && !Object.values(AgentModelSelectionMode).includes(updates.modelSelectionMode)) {
      throw new Error('Invalid agent model selection mode.');
    }
    if (updates.modelSelectionMode === AgentModelSelectionMode.Inherit
      && (agentId === AgentId.Main || this.store.getVisibleAgent(agentId, owner)?.source !== AgentSource.Preset)) {
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
    }, owner);
  }

  reorderAgents(agentIds: string[]): Agent[] {
    return this.store.reorderAgents(agentIds, this.getOwner());
  }

  deleteAgent(agentId: string): boolean {
    assertAgentSettingsLocalWriteAllowed(agentId);
    return this.store.deleteAgent(agentId, this.getOwner());
  }

  private installedPresets(): Agent[] {
    const owner = this.getOwner();
    return this.listAgents().filter(agent => {
      const ownership = this.store.agentOwnership.get(agent.id);
      return agent.source === AgentSource.Preset && ownership && (owner
        ? ownership.ownerKind === AgentOwnerKind.Owned && sameAgentOwner(ownership.owner, owner)
        : ownership.ownerKind === AgentOwnerKind.Anonymous);
    });
  }

  async getPresetAgents(): Promise<PresetAgent[]> {
    const owner = this.captureOwner();
    const presets = await this.getAllPresetAgents();
    this.assertCurrentOwner(owner);
    const installed = new Set(this.installedPresets().map(agent => agent.presetId));
    return presets.filter(preset => !installed.has(preset.id));
  }

  async getExpertCatalog(): Promise<ExpertCatalog> {
    const owner = this.captureOwner();
    const catalog = await this.loadCatalog();
    this.assertCurrentOwner(owner);
    const presets = new Map(catalog.experts.map(preset => [preset.id, preset]));
    for (const agent of this.installedPresets()) {
      const preset = presets.get(agent.presetId);
      // Unversioned catalogs retain their legacy cosmetic refresh. Versioned avatars install on consent.
      if (preset?.revision !== undefined || agent.presetRevision !== undefined) continue;
      const icon = preset?.icon;
      if (icon && parseAgentAvatarImageUrl(icon) && usesManagedPresetAvatar(agent) && agent.icon !== icon) {
        try {
          this.store.updatePresetAgentAvatar(agent.id, icon, owner);
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
    const owner = this.captureOwner();
    // Reuse only this owner's instance, preserving edits and offline availability.
    const findExisting = () => this.installedPresets().find(agent => agent.presetId === presetId);
    const reuse = (agent: Agent): Agent | null => {
      const updates: UpdateAgentRequest = {};
      if (!agent.enabled) updates.enabled = true;
      if (usesInheritedAgentModel(agent) && defaultModel !== undefined) {
        const model = defaultModel.trim();
        if (agent.model !== model) updates.model = model;
        if (agent.thinkingLevel !== thinkingLevel) updates.thinkingLevel = thinkingLevel;
      }
      return Object.keys(updates).length > 0 ? this.updateAgent(agent.id, { ...updates, modelSelectionMode: agent.modelSelectionMode }) : agent;
    };
    const existing = findExisting();
    if (existing) {
      return reuse(existing);
    }

    const preset = (await this.getAllPresetAgents()).find(item => item.id === presetId);
    this.assertCurrentOwner(owner);
    if (!preset) return null;
    // Concurrent catalog requests may have installed this owner's preset already.
    const createdMeanwhile = findExisting();
    if (createdMeanwhile) return reuse(createdMeanwhile);

    return this.createAgent({
      ...presetToCreateRequest(preset),
      // Historical ownership triggers can keep deleted IDs reserved.
      // presetId identifies the template; each new instance needs its own ID.
      id: randomUUID(),
      model: defaultModel?.trim() || '',
      modelSelectionMode: AgentModelSelectionMode.Inherit,
      thinkingLevel,
      workingDirectory: '',
    }, defaultModel);
  }
}
