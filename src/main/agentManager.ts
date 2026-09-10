import { randomUUID } from 'crypto';

import { AgentAccessErrorCode, AgentId, AgentOwnerKind } from '../shared/agent/constants';
import type { RemoteOwner } from '../shared/remote/constants';
import { AgentAccessError, sameAgentOwner } from './agentOwnership';
import type { Agent, CoworkStore, CreateAgentRequest, UpdateAgentRequest } from './coworkStore';
import { PRESET_AGENTS, type PresetAgent, presetToCreateRequest } from './presetAgents';

/** Renderer-facing CRUD; internal runtime consumers continue to use raw CoworkStore reads. */
export class AgentManager {
  constructor(private readonly store: CoworkStore, private readonly getOwner: () => RemoteOwner | null = () => null) {}

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
      return agent.source === 'preset' && ownership && (owner
        ? ownership.ownerKind === AgentOwnerKind.Owned && sameAgentOwner(ownership.owner, owner)
        : ownership.ownerKind === AgentOwnerKind.Anonymous);
    });
  }

  getPresetAgents(): PresetAgent[] {
    const installed = new Set(this.installedPresets().map(agent => agent.presetId));
    return PRESET_AGENTS.filter(preset => !installed.has(preset.id));
  }

  getAllPresetAgents(): PresetAgent[] {
    return PRESET_AGENTS;
  }

  addPresetAgent(presetId: string, defaultModel?: string): Agent | null {
    const preset = PRESET_AGENTS.find(item => item.id === presetId);
    if (!preset) return null;
    const existing = this.installedPresets().find(agent => agent.presetId === presetId);
    if (existing) return existing;
    return this.createAgent({ ...presetToCreateRequest(preset), workingDirectory: '' }, defaultModel);
  }
}
