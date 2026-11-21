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

/**
 * Resolve the delegated specialist agent's display name when a subagent run
 * belongs to a different LobsterAI agent than the parent session.
 */
export const getSubagentTargetAgentName = (
  subagent: Pick<SubagentSessionSummary, 'agentId'>,
  agents: Array<Pick<SubagentAgentDisplaySource, 'id' | 'name'>>,
  parentAgentId?: string | null,
): string | null => {
  const targetId = subagent.agentId?.trim();
  if (!targetId) return null;
  const normalizedParent = parentAgentId?.trim() || 'main';
  if (targetId === normalizedParent) return null;
  return getAgentDisplayNameById(targetId, agents) ?? targetId;
};

export const getSubagentDisplayInitial = (
  subagent: Pick<SubagentSessionSummary, 'label' | 'agentId'>,
  agents: Array<Pick<SubagentAgentDisplaySource, 'id' | 'name'>>,
  parentAgentId?: string | null,
): string => {
  const targetAgentName = getSubagentTargetAgentName(subagent, agents, parentAgentId);
  const source = (targetAgentName || getSubagentDisplayName(subagent, agents)).trim();
  return source.slice(0, 1).toUpperCase() || 'S';
};
