import { useMemo } from 'react';
import { useSelector } from 'react-redux';

import {
  resolveBlockingEnterpriseQuotaReason,
  usesLobsterAIServerQuota,
} from '../../features/enterpriseAccount/modelQuotaGate';
import { selectEnterpriseAccountContext } from '../../features/enterpriseAccount/selectors';
import { resolveNewTaskModelSelection } from '../../services/newTaskModelSelection';
import type { RootState } from '../../store';
import { selectCoworkConfig } from '../../store/selectors/coworkSelectors';

/**
 * What a new session started from a home composer runs with: the current
 * agent, its folder, model and thinking level, and whether enterprise quota
 * blocks it. Shared by the home page and the desktop companion's composer.
 */
export function useHomeStartContext() {
  const config = useSelector(selectCoworkConfig);
  const enterpriseAccountContext = useSelector(selectEnterpriseAccountContext);
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const agents = useSelector((state: RootState) => state.agent.agents);
  const modelState = useSelector((state: RootState) => state.model);
  const currentAgent = agents.find((agent) => agent.id === currentAgentId);
  const modelSelection = useMemo(() => resolveNewTaskModelSelection(modelState, currentAgentId, currentAgent),
    [modelState, currentAgentId, currentAgent]);
  const { selectedModel } = modelSelection;
  const quotaReason = enterpriseAccountContext?.quotaStatus.available === false
    ? enterpriseAccountContext.quotaStatus.reason
    : null;
  return {
    config,
    currentAgentId,
    currentAgent,
    workingDirectory: currentAgent?.workingDirectory?.trim() || config.workingDirectory || '',
    ...modelSelection,
    usesServerQuota: usesLobsterAIServerQuota(selectedModel),
    quotaReason,
    blockingQuotaReason: resolveBlockingEnterpriseQuotaReason(quotaReason, selectedModel),
  };
}
