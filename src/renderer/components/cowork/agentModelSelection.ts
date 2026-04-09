import type { Model } from '../../store/slices/modelSlice';
import type { CoworkAgentEngine } from '../../types/cowork';
import { resolveOpenClawModelRef } from '../../utils/openclawModelRef';

type ResolveAgentModelSelectionInput = {
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
  agentModel,
  availableModels,
  fallbackModel,
  engine,
}: ResolveAgentModelSelectionInput): ResolveAgentModelSelectionResult {
  if (engine !== 'openclaw') {
    return { selectedModel: fallbackModel, usesFallback: false, hasInvalidExplicitModel: false };
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
