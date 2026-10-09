import { useMemo } from 'react';
import { useSelector } from 'react-redux';

import {
  resolveBlockingEnterpriseQuotaReason,
  usesLobsterAIServerQuota,
} from '../../features/enterpriseAccount/modelQuotaGate';
import { selectEnterpriseAccountContext } from '../../features/enterpriseAccount/selectors';
import type { RootState } from '../../store';
import { selectCoworkConfig } from '../../store/selectors/coworkSelectors';
import { toOpenClawModelRef } from '../../utils/openclawModelRef';
import { resolveAgentStartModel, resolveModelThinkingLevel, useAgentSelectedModel } from './agentModelSelection';

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
  const availableModels = useSelector((state: RootState) => state.model.availableModels);
  const currentAgent = agents.find((agent) => agent.id === currentAgentId);
  const selectedModel = useAgentSelectedModel(currentAgentId, currentAgent?.model ?? '');
  const startModel = useMemo(() => resolveAgentStartModel({
    agentModel: currentAgent?.model ?? '',
    availableModels,
    selectedModel,
  }), [availableModels, currentAgent?.model, selectedModel]);
  const quotaReason = enterpriseAccountContext?.quotaStatus.available === false
    ? enterpriseAccountContext.quotaStatus.reason
    : null;
  return {
    config,
    currentAgentId,
    currentAgent,
    workingDirectory: currentAgent?.workingDirectory?.trim() || config.workingDirectory || '',
    selectedModel,
    selectedModelRef: selectedModel ? toOpenClawModelRef(selectedModel) : '',
    startModel,
    usesServerQuota: usesLobsterAIServerQuota(selectedModel),
    quotaReason,
    blockingQuotaReason: resolveBlockingEnterpriseQuotaReason(quotaReason, selectedModel),
    thinkingLevel: resolveModelThinkingLevel(selectedModel, currentAgent?.thinkingLevel),
  };
}
