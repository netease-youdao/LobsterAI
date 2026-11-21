// Pure helper for translating LobsterAI Agent records into DSH host sync specs
// (`DshHostAgentSpec`) for cross-agent discovery and specialist delegation.
// Zero Electron imports — directly unit-testable under Node Vitest.

import {
  AgentId,
  AgentModelSelectionMode,
  normalizeSubagentCollaborationMode,
  type SubagentCollaborationMode,
} from '../../../shared/agent/constants';
import type { Agent } from '../../coworkStore';
import type { DshHostAgentSpec } from './dshHostManager';

export interface DshAgentSkillCatalogItem {
  id: string;
  name?: string;
  description?: string;
  enabled: boolean;
}

export interface DshResolvedAgentModel {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface BuildDshHostAgentSpecsInput {
  agents: readonly Agent[];
  skills?: readonly DshAgentSkillCatalogItem[];
  resolveExplicitModel?: (agent: Agent) => DshResolvedAgentModel | null;
}

function normalizeAllowAgentIds(selfId: string, rawIds: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of rawIds ?? []) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed || trimmed === selfId || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function buildSkillSummariesForAgent(
  allowedSkillIds: readonly string[] | null,
  enabledSkills: readonly DshAgentSkillCatalogItem[],
): Array<{ id: string; name: string; description?: string }> {
  // Only attach compact skill summaries for agents with explicit skill allowlists
  // so unrestricted agents (like main) do not bloat the collaborator roster prompt.
  if (!allowedSkillIds || allowedSkillIds.length === 0) return [];
  const allowSet = new Set(allowedSkillIds.map(id => id.trim()).filter(Boolean));
  const summaries: Array<{ id: string; name: string; description?: string }> = [];
  const seen = new Set<string>();

  for (const skill of enabledSkills) {
    if (!skill.enabled) continue;
    const id = skill.id.trim();
    const name = skill.name?.trim() || id;
    if (!id || seen.has(id)) continue;
    if (!allowSet.has(id) && !allowSet.has(name)) continue;
    seen.add(id);
    summaries.push({
      id,
      name,
      ...(skill.description?.trim() ? { description: skill.description.trim() } : {}),
    });
  }

  return summaries;
}

export function buildDshHostAgentSpecs(input: BuildDshHostAgentSpecsInput): DshHostAgentSpec[] {
  const enabledSkills = (input.skills ?? []).filter(skill => skill.enabled);
  const specs: DshHostAgentSpec[] = [];
  const seen = new Set<string>();

  for (const agent of input.agents) {
    const id = agent.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const isMain = id === AgentId.Main;
    const explicitSkillIds = Array.isArray(agent.skillIds)
      ? agent.skillIds.map(s => s.trim()).filter(Boolean)
      : [];
    const allowedSkillIds = !isMain && explicitSkillIds.length > 0 ? explicitSkillIds : null;

    const usesInheritModel = agent.modelSelectionMode === AgentModelSelectionMode.Inherit;
    const resolvedModel = !usesInheritModel && agent.model.trim().length > 0
      ? input.resolveExplicitModel?.(agent) ?? null
      : null;

    const collaborationMode: SubagentCollaborationMode = normalizeSubagentCollaborationMode(
      agent.subagentCollaborationMode,
    );
    const allowAgentIds = normalizeAllowAgentIds(id, agent.subagentAllowAgentIds);
    const skillSummaries = buildSkillSummariesForAgent(allowedSkillIds, enabledSkills);

    specs.push({
      id,
      name: agent.name.trim() || id,
      description: agent.description?.trim() || '',
      enabled: Boolean(agent.enabled),
      ...(agent.presetId?.trim() ? { presetId: agent.presetId.trim() } : {}),
      ...(agent.systemPrompt?.trim() ? { systemPrompt: agent.systemPrompt } : {}),
      ...(agent.workingDirectory?.trim() ? { workingDirectory: agent.workingDirectory.trim() } : {}),
      allowedSkillIds,
      ...(resolvedModel ? { modelSelection: resolvedModel } : {}),
      collaborationMode,
      allowAgentIds,
      ...(skillSummaries.length > 0 ? { skillSummaries } : {}),
    });
  }

  return specs;
}
