import { i18nService } from '../services/i18n';
import type { SubagentSessionSummary } from '../types/cowork';
import { getAgentDisplayNameById } from './agentDisplay';

interface SubagentAgentDisplaySource {
  id: string;
  name?: string;
}

export const getSubagentDisplayName = (
  subagent: Pick<SubagentSessionSummary, 'label' | 'agentId'>,
  agents: Array<Pick<SubagentAgentDisplaySource, 'id' | 'name'>>,
): string => {
  const label = subagent.label?.trim();
  if (label) return label;

  const agentId = subagent.agentId?.trim();
  if (!agentId) return i18nService.t('subagentUnnamed');

  return getAgentDisplayNameById(agentId, agents) ?? agentId;
};

export const getSubagentDisplayInitial = (
  subagent: Pick<SubagentSessionSummary, 'label' | 'agentId'>,
  agents: Array<Pick<SubagentAgentDisplaySource, 'id' | 'name'>>,
): string => {
  const displayName = getSubagentDisplayName(subagent, agents).trim();
  return displayName.slice(0, 1).toUpperCase() || 'S';
};
