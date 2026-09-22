import { DefaultAgentAvatarIcon } from '../../shared/agent/avatar';
import {
  buildExpertTeamLeadPrompt,
  createExpertTeamInstance,
  EXPERT_TEAM_DEFINITIONS,
} from '../../shared/agent/expertTeams';
import { ExpertTeamPresetPrefix } from '../../shared/agent/teamInstallation';
import type { Agent, CoworkStore } from '../coworkStore';

/** Native agents keep team membership compatible with existing config, UI and backups. */
export function installExpertTeam(
  store: CoworkStore,
  definitionId: string,
  defaultModel: string,
  availableSkillIds: ReadonlySet<string>,
): { lead: Agent | null; members: Agent[]; missingSkillIds: string[] } {
  const definition = EXPERT_TEAM_DEFINITIONS.find(item => item.id === definitionId);
  if (!definition) throw new Error('Unknown expert team');
  const presetId = `${ExpertTeamPresetPrefix}${definition.id}`;
  const leadId = `expert-team-${definition.id}`;
  const instance = createExpertTeamInstance(definition, leadId, {});
  // Required skills are surfaced before creation. Never silently create a team
  // whose advertised tools are absent. Existing installations remain editable.
  const missingSkillIds = [...new Set([definition.lead, ...definition.roles]
    .flatMap(role => role.skillIds).filter(id => !availableSkillIds.has(id)))];
  const existing = store.listAgents().find(agent => agent.presetId === presetId);
  if (existing) {
    const members = existing.subagentAllowAgentIds
      .map(id => store.getAgent(id)).filter((agent): agent is Agent => agent !== null);
    if (members.length !== existing.subagentAllowAgentIds.length) {
      throw new Error('A team member was removed. Restore the member or edit the lead delegation settings.');
    }
    return { lead: existing, members, missingSkillIds };
  }
  if (missingSkillIds.length > 0) return { lead: null, members: [], missingSkillIds };
  const requestedIds = [leadId, ...instance.roles.map(role => role.runtimeAgentId)];
  if (new Set(requestedIds).size !== requestedIds.length || requestedIds.some(id => store.getAgent(id))) {
    throw new Error('Expert team agent IDs are already in use');
  }
  return store.runSessionTransaction(() => {
    const members = instance.roles.map(role => store.createAgent({
      id: role.runtimeAgentId,
      name: role.name,
      description: role.description,
      systemPrompt: role.systemPrompt,
      identity: role.description,
      skillIds: role.skillIds,
      icon: DefaultAgentAvatarIcon,
      model: defaultModel,
      source: 'preset',
      presetId: `${presetId}:${role.key}`,
    }));
    const lead = store.createAgent({
      id: leadId,
      name: definition.name,
      description: definition.description,
      systemPrompt: buildExpertTeamLeadPrompt(instance),
      identity: definition.lead.description,
      skillIds: definition.lead.skillIds,
      subagentAllowAgentIds: members.map(member => member.id),
      icon: DefaultAgentAvatarIcon,
      model: defaultModel,
      source: 'preset',
      presetId,
    });
    return { lead, members, missingSkillIds };
  });
}
