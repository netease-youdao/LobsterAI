// Pure helper for translating LobsterAI Agent records into DSH host sync specs
// (`DshHostAgentSpec`) for cross-agent discovery and specialist delegation.
// Zero Electron imports — directly unit-testable under Node Vitest.

import {
  AgentId,
  AgentModelSelectionMode,
  normalizeSubagentCollaborationMode,
  type SubagentCollaborationMode,
} from '../../../shared/agent/constants';
import { deriveAgentRoutingDescription } from '../../../shared/agent/description';
import {
  DSH_HTML_RENDER_TOOL,
  DshProgressiveCapability,
} from '../../../shared/dshEngine/hostConstants';
import { canonicalizeDshProviderId } from '../../../shared/providers/constants';
import { CoreSkillId } from '../../../shared/skills/constants';
import type { Agent } from '../../coworkStore';
import type { DshHostAgentSpec } from './dshHostManager';

const EXPERT_PRESET_DEFAULT_CAPABILITIES: Readonly<Record<string, readonly DshProgressiveCapability[]>> = {
  'xiaohongshu-editor': [DshProgressiveCapability.HtmlRender],
  'xiaohongshu-viral-expert': [DshProgressiveCapability.HtmlRender],
};

const VALID_PROGRESSIVE_CAPABILITIES = new Set<string>(Object.values(DshProgressiveCapability));

/**
 * Resolve progressive host capabilities that should be pre-unlocked whenever a
 * session runs as the given LobsterAI agent (direct session or delegated subagent).
 */
export function resolveHostCapabilitiesForAgent(
  agent: Pick<Agent, 'id' | 'presetId' | 'systemPrompt' | 'skillIds'> | undefined,
  declaredCapabilities?: readonly string[],
): DshProgressiveCapability[] {
  if (!agent) return [];
  const caps = new Set<DshProgressiveCapability>();

  if (Array.isArray(declaredCapabilities)) {
    for (const raw of declaredCapabilities) {
      const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      if (VALID_PROGRESSIVE_CAPABILITIES.has(normalized)) {
        caps.add(normalized as DshProgressiveCapability);
      }
    }
  }

  for (const key of [agent.presetId, agent.id]) {
    const normalized = typeof key === 'string' ? key.trim().toLowerCase() : '';
    const presetCaps = normalized ? EXPERT_PRESET_DEFAULT_CAPABILITIES[normalized] : undefined;
    if (presetCaps) {
      for (const cap of presetCaps) caps.add(cap);
    }
  }

  if (typeof agent.systemPrompt === 'string' && agent.systemPrompt.includes(DSH_HTML_RENDER_TOOL)) {
    caps.add(DshProgressiveCapability.HtmlRender);
  }

  if (Array.isArray(agent.skillIds)) {
    for (const rawSkill of agent.skillIds) {
      if (typeof rawSkill === 'string' && rawSkill.trim().toLowerCase() === 'skin-creator') {
        caps.add(DshProgressiveCapability.SkinManage);
      }
    }
  }

  return [...caps];
}

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
    const rawResolvedModel = !usesInheritModel && agent.model.trim().length > 0
      ? input.resolveExplicitModel?.(agent) ?? null
      : null;
    const resolvedModel = rawResolvedModel
      ? {
          ...rawResolvedModel,
          provider: canonicalizeDshProviderId(rawResolvedModel.provider),
        }
      : null;

    const collaborationMode: SubagentCollaborationMode = normalizeSubagentCollaborationMode(
      agent.subagentCollaborationMode,
    );
    const allowAgentIds = normalizeAllowAgentIds(id, agent.subagentAllowAgentIds);
    const skillSummaries = buildSkillSummariesForAgent(allowedSkillIds, enabledSkills);
    const hostCapabilities = isMain ? [] : resolveHostCapabilitiesForAgent(agent);

    specs.push({
      id,
      name: agent.name.trim() || id,
      description: deriveAgentRoutingDescription(agent),
      enabled: Boolean(agent.enabled),
      ...(agent.presetId?.trim() ? { presetId: agent.presetId.trim() } : {}),
      ...(agent.systemPrompt?.trim() ? { systemPrompt: agent.systemPrompt } : {}),
      ...(agent.workingDirectory?.trim() ? { workingDirectory: agent.workingDirectory.trim() } : {}),
      allowedSkillIds,
      ...(hostCapabilities.length > 0 ? { hostCapabilities } : {}),
      ...(resolvedModel ? { modelSelection: resolvedModel } : {}),
      collaborationMode,
      allowAgentIds,
      ...(skillSummaries.length > 0 ? { skillSummaries } : {}),
    });
  }

  return specs;
}

function normalizeSkillIdList(rawIds: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of rawIds ?? []) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/** A typed /skill-creator command selects the skill for this user message only. */
export function resolveSelectedSkillIdsForTurn(userMessage: string, messageSkillIds?: readonly string[]): string[] {
  const selected = normalizeSkillIdList(Array.isArray(messageSkillIds) ? messageSkillIds : []);
  const command = userMessage.trimStart().split(/\s/, 1)[0];
  if (command === `/${CoreSkillId.SkillCreator}` && !selected.includes(CoreSkillId.SkillCreator)) {
    selected.push(CoreSkillId.SkillCreator);
  }
  return selected;
}

/**
 * Resolve the DSH `allowedSkillIds` allowlist for a Cowork turn.
 *
 * - Explicit empty `optionSkillIds` (`[]`, e.g. Plan Mode / PPT Outline)
 *   suppresses all skills (`[]`).
 * - Restricted experts (`agentId !== 'main'` with non-empty `agentSkillIds`)
 *   are bounded by `agentSkillIds`; any non-empty `optionSkillIds` is
 *   intersected with `agentSkillIds` so composer selections cannot bypass
 *   the expert's binding.
 * - Unrestricted agents (`main`, or experts with empty `agentSkillIds`) return
 *   `null` so composer selections act as preferred-candidate routing hints
 *   without banning other globally enabled skills.
 */
export function resolveAllowedSkillIdsForTurn(input: {
  agentId?: string;
  agentSkillIds?: readonly string[] | null;
  optionSkillIds?: readonly string[];
}): string[] | null {
  if (Array.isArray(input.optionSkillIds) && input.optionSkillIds.length === 0) {
    return [];
  }

  const normalizedAgentId = input.agentId?.trim() || AgentId.Main;
  const normalizedAgentSkillIds = normalizedAgentId !== AgentId.Main
    ? normalizeSkillIdList(input.agentSkillIds)
    : [];

  if (normalizedAgentSkillIds.length > 0) {
    if (Array.isArray(input.optionSkillIds) && input.optionSkillIds.length > 0) {
      const allowedSet = new Set(normalizedAgentSkillIds);
      return normalizeSkillIdList(input.optionSkillIds).filter((id) => allowedSet.has(id));
    }
    return normalizedAgentSkillIds;
  }

  return null;
}
