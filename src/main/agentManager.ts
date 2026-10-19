import { randomUUID } from 'crypto';

import { parseAgentAvatarImageUrl } from '../shared/agent/avatar';
import { AgentAccessErrorCode, AgentId, AgentOwnerKind, AgentSource } from '../shared/agent/constants';
import { usesManagedPresetAvatar } from '../shared/agent/presetAvatar';
import type { ExpertCatalog, PresetAgent } from '../shared/agent/presets';
import type { RemoteOwner } from '../shared/remote/constants';
import { AgentAccessError, sameAgentOwner } from './agentOwnership';
import type { Agent, CoworkStore, CreateAgentRequest, UpdateAgentRequest } from './coworkStore';
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
      id: randomUUID(),
      model: request.model?.trim() || defaultModel?.trim() || '',
      workingDirectory: request.workingDirectory?.trim() || '',
    }, owner);
  }

  updateAgent(agentId: string, updates: UpdateAgentRequest): Agent | null {
    const owner = this.captureOwner();
    this.store.assertAgentAccess(agentId, owner);
    this.assertSubagentAccess(updates.subagentAllowAgentIds, owner);
    return this.store.updateAgent(agentId, {
      ...updates,
      ...(updates.workingDirectory !== undefined ? { workingDirectory: updates.workingDirectory.trim() } : {}),
    }, owner);
  }

  reorderAgents(agentIds: string[]): Agent[] {
    return this.store.reorderAgents(agentIds, this.getOwner());
  }

  deleteAgent(agentId: string): boolean {
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
      const icon = presets.get(agent.presetId)?.icon;
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

  async addPresetAgent(presetId: string, defaultModel?: string): Promise<Agent | null> {
    const owner = this.captureOwner();
    // Reuse only this owner's instance, preserving edits and offline availability.
    const findExisting = () => this.installedPresets().find(agent => agent.presetId === presetId);
    const existing = findExisting();
    if (existing) return existing.enabled ? existing : this.updateAgent(existing.id, { enabled: true });

    const preset = (await this.getAllPresetAgents()).find(item => item.id === presetId);
    this.assertCurrentOwner(owner);
    if (!preset) return null;
    // Concurrent catalog requests may have installed this owner's preset already.
    const createdMeanwhile = findExisting();
    if (createdMeanwhile) return createdMeanwhile.enabled ? createdMeanwhile : this.updateAgent(createdMeanwhile.id, { enabled: true });
    return this.createAgent({ ...presetToCreateRequest(preset), workingDirectory: '' }, defaultModel);
  }
}
