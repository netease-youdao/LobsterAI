import type { Model } from '../../store/slices/modelSlice';
import type { CoworkAgentEngine } from '../../types/cowork';
import { resolveOpenClawModelRef } from '../../utils/openclawModelRef';

type ResolveAgentModelSelectionInput = {
  sessionModel?: string;
  agentModel: string;
  availableModels: Model[];
  fallbackModel: Model | null;
  engine: CoworkAgentEngine;
};

type ResolveAgentModelSelectionResult = {
  selectedModel: Model | null;
  usesFallback: boolean;
  hasInvalidExplicitModel: boolean;
};

export function resolveAgentModelSelection({
  sessionModel,
  agentModel,
  availableModels,
  fallbackModel,
}: ResolveAgentModelSelectionInput): ResolveAgentModelSelectionResult {
  const normalizedSessionModel = sessionModel?.trim() ?? '';
  if (normalizedSessionModel) {
    const explicitSessionModel = resolveOpenClawModelRef(normalizedSessionModel, availableModels) ?? null;
    if (explicitSessionModel) {
      return { selectedModel: explicitSessionModel, usesFallback: false, hasInvalidExplicitModel: false };
    }

    return { selectedModel: fallbackModel, usesFallback: true, hasInvalidExplicitModel: true };
  }

  const normalizedAgentModel = agentModel.trim();
  if (normalizedAgentModel) {
    const explicitModel = resolveOpenClawModelRef(normalizedAgentModel, availableModels) ?? null;
    if (explicitModel) {
      return { selectedModel: explicitModel, usesFallback: false, hasInvalidExplicitModel: false };
    }

    return { selectedModel: fallbackModel, usesFallback: true, hasInvalidExplicitModel: true };
  }

  return { selectedModel: fallbackModel, usesFallback: true, hasInvalidExplicitModel: false };
}
