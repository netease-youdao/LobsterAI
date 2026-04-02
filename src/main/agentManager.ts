import type { CoworkStore, Agent, CreateAgentRequest, UpdateAgentRequest } from './coworkStore';
import { PRESET_AGENTS, presetToCreateRequest, type PresetAgent } from './presetAgents';
import type {
  AgentExportEnvelope,
  ExportedAgent,
  AgentConflict,
  ImportResolution,
} from './agentConstants';
import { ImportResolutionAction } from './agentConstants';

/**
 * AgentManager handles CRUD operations for agents and preset agent installation.
 * Agents are stored in the SQLite `agents` table via CoworkStore.
 */
export class AgentManager {
  private store: CoworkStore;

  constructor(store: CoworkStore) {
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

  createAgent(request: CreateAgentRequest): Agent {
    return this.store.createAgent(request);
  }

  updateAgent(agentId: string, updates: UpdateAgentRequest): Agent | null {
    return this.store.updateAgent(agentId, updates);
  }

  deleteAgent(agentId: string): boolean {
    return this.store.deleteAgent(agentId);
  }

  // --- Preset agents ---

  getPresetAgents(): PresetAgent[] {
    const existingAgents = this.store.listAgents();
    const existingPresetIds = new Set(
      existingAgents.filter(a => a.source === 'preset').map(a => a.presetId)
    );
    // Only return presets that haven't been added yet
    return PRESET_AGENTS.filter(p => !existingPresetIds.has(p.id));
  }

  getAllPresetAgents(): PresetAgent[] {
    return PRESET_AGENTS;
  }

  addPresetAgent(presetId: string): Agent | null {
    const preset = PRESET_AGENTS.find(p => p.id === presetId);
    if (!preset) return null;

    // Check if already installed
    const existing = this.store.getAgent(preset.id);
    if (existing) return existing;

    return this.store.createAgent(presetToCreateRequest(preset));
  }

  // --- Import / Export ---

  /**
   * Export agents by ID into a portable envelope.
   * Strips instance-local fields (enabled, isDefault, createdAt, updatedAt).
   */
  exportAgents(agentIds: string[]): AgentExportEnvelope {
    const agents: ExportedAgent[] = [];
    for (const id of agentIds) {
      const agent = this.store.getAgent(id);
      if (!agent) continue;
      agents.push({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        systemPrompt: agent.systemPrompt,
        identity: agent.identity,
        model: agent.model,
        icon: agent.icon,
        skillIds: agent.skillIds,
        source: agent.source,
        presetId: agent.presetId,
      });
    }
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      agents,
    };
  }

  /**
   * Validate raw JSON content as an agent export file.
   * Returns the parsed envelope on success or an error string on failure.
   */
  validateImportFile(content: string): { valid: true; envelope: AgentExportEnvelope } | { valid: false; error: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { valid: false, error: 'Invalid JSON format' };
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { valid: false, error: 'File must contain a JSON object' };
    }

    const obj = parsed as Record<string, unknown>;

    if (obj.version !== 1) {
      return { valid: false, error: 'Unsupported export format version' };
    }

    if (!Array.isArray(obj.agents) || obj.agents.length === 0) {
      return { valid: false, error: 'File contains no agents to import' };
    }

    const validAgents: ExportedAgent[] = [];
    for (const entry of obj.agents) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== 'string' || e.id.trim() === '') continue;
      if (typeof e.name !== 'string' || e.name.trim() === '') continue;

      validAgents.push({
        id: e.id,
        name: e.name,
        description: typeof e.description === 'string' ? e.description : '',
        systemPrompt: typeof e.systemPrompt === 'string' ? e.systemPrompt : '',
        identity: typeof e.identity === 'string' ? e.identity : '',
        model: typeof e.model === 'string' ? e.model : '',
        icon: typeof e.icon === 'string' ? e.icon : '',
        skillIds: Array.isArray(e.skillIds) ? (e.skillIds as string[]).filter(s => typeof s === 'string') : [],
        source: typeof e.source === 'string' ? e.source : 'custom',
        presetId: typeof e.presetId === 'string' ? e.presetId : '',
      });
    }

    if (validAgents.length === 0) {
      return { valid: false, error: 'No valid agent entries found (each must have id and name)' };
    }

    return {
      valid: true,
      envelope: {
        version: 1,
        exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : '',
        agents: validAgents,
      },
    };
  }

  /**
   * Separate agents in the envelope into those that can be auto-imported
   * (no ID collision) and those that conflict with existing agents.
   */
  detectConflicts(envelope: AgentExportEnvelope): { toImport: ExportedAgent[]; conflicts: AgentConflict[] } {
    const toImport: ExportedAgent[] = [];
    const conflicts: AgentConflict[] = [];

    for (const agent of envelope.agents) {
      const existing = this.store.getAgent(agent.id);
      if (existing) {
        conflicts.push({
          id: agent.id,
          name: agent.name,
          existingAgentName: existing.name,
          incomingAgentName: agent.name,
        });
      } else {
        toImport.push(agent);
      }
    }

    return { toImport, conflicts };
  }

  /**
   * Create agents from exported entries (no conflict check — caller must ensure no collisions).
   */
  importAgents(agents: ExportedAgent[]): Agent[] {
    const created: Agent[] = [];
    for (const entry of agents) {
      const agent = this.store.createAgent({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        systemPrompt: entry.systemPrompt,
        identity: entry.identity,
        model: entry.model,
        icon: entry.icon,
        skillIds: entry.skillIds,
        source: (entry.source as 'custom' | 'preset') || 'custom',
        presetId: entry.presetId,
      });
      created.push(agent);
    }
    return created;
  }

  /**
   * Apply user-chosen conflict resolutions for previously detected conflicts.
   */
  resolveConflicts(resolutions: ImportResolution[], pendingAgents: Map<string, ExportedAgent>): { importedCount: number } {
    let importedCount = 0;

    for (const resolution of resolutions) {
      const entry = pendingAgents.get(resolution.id);
      if (!entry) continue;

      switch (resolution.action) {
        case ImportResolutionAction.Overwrite: {
          this.store.updateAgent(resolution.id, {
            name: entry.name,
            description: entry.description,
            systemPrompt: entry.systemPrompt,
            identity: entry.identity,
            model: entry.model,
            icon: entry.icon,
            skillIds: entry.skillIds,
          });
          importedCount++;
          break;
        }
        case ImportResolutionAction.CreateNew: {
          this.store.createAgent({
            id: `${entry.id}-${Date.now()}`,
            name: entry.name,
            description: entry.description,
            systemPrompt: entry.systemPrompt,
            identity: entry.identity,
            model: entry.model,
            icon: entry.icon,
            skillIds: entry.skillIds,
            source: (entry.source as 'custom' | 'preset') || 'custom',
            presetId: entry.presetId,
          });
          importedCount++;
          break;
        }
        case ImportResolutionAction.Skip:
          break;
      }
    }

    return { importedCount };
  }
}
