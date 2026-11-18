import type { ModelThinkingLevel } from '@shared/providers/modelThinking';
import { useMemo } from 'react';
import { useSelector } from 'react-redux';

import type { OpenClawSessionPatch } from '../../../common/openclawSession';
import type { ModelPresetId } from '../../../shared/modelPresets/constants';
import { modelPresetToModel } from '../../services/modelPresets';
import type { RootState } from '../../store';
import { type Model, selectAgentSelectedModel } from '../../store/slices/modelSlice';
import type { CoworkAgentEngine } from '../../types/cowork';
import { resolveOpenClawModelRef } from '../../utils/openclawModelRef';

export { resolveAgentStartModel, resolveModelThinkingLevel } from '../../services/newTaskModelSelection';

type ResolveAgentModelSelectionInput = {
  sessionModel?: string;
  sessionPresetId?: ModelPresetId | null;
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

export function buildSessionModelSelectionPatch(model: string, thinkingLevel: ModelThinkingLevel | '', keepModel: boolean): OpenClawSessionPatch {
  return { ...(keepModel ? {} : { model }), thinkingLevel: thinkingLevel || null };
}

/**
 * Determine which Model object the prompt input should use for capability
 * checks (e.g. supportsImage).
 *
 * On the **home page** (no sessionId) the selectors use the current agent's
 * resolved model. Callers persist user changes to the agent model before
 * passing that value back here, so image capability checks must honour it.
 *
 * Inside a **session** (has sessionId) the agent-level resolution
 * (session override → agent model → fallback) is authoritative.
 */
export function resolveEffectiveModel({
  sessionId,
  agentSelectedModel,
  globalSelectedModel,
}: {
  sessionId: string | undefined;
  agentSelectedModel: Model | null;
  globalSelectedModel: Model | null;
}): Model | null {
  return sessionId ? agentSelectedModel : globalSelectedModel;
}

export function resolveAgentModelSelection({
  sessionModel,
  sessionPresetId,
  agentModel,
  availableModels,
  fallbackModel,
}: ResolveAgentModelSelectionInput): ResolveAgentModelSelectionResult {
  const normalizedSessionModel = sessionModel?.trim() ?? '';
  if (normalizedSessionModel) {
    const explicitSessionModel = resolveOpenClawModelRef(normalizedSessionModel, availableModels) ?? null;
    if (explicitSessionModel) {
      if (sessionPresetId) {
        const preset = availableModels.find(model => model.presetId === sessionPresetId);
        return { selectedModel: modelPresetToModel({
          presetId: sessionPresetId, costMultiplier: preset?.costMultiplier ?? 0,
          contextWindow: preset?.contextWindow, contextWindowOptions: preset?.contextWindowOptions,
          accessible: explicitSessionModel.accessible !== false, supportsImage: !!explicitSessionModel.supportsImage,
        }, explicitSessionModel), usesFallback: false, hasInvalidExplicitModel: explicitSessionModel.accessible === false };
      }
      return { selectedModel: explicitSessionModel, usesFallback: false, hasInvalidExplicitModel: false };
    }

    return { selectedModel: fallbackModel, usesFallback: true, hasInvalidExplicitModel: true };
  }

  if (fallbackModel?.presetId) return { selectedModel: fallbackModel, usesFallback: false, hasInvalidExplicitModel: false };
  const normalizedAgentModel = agentModel.trim();
  if (normalizedAgentModel) {
    const explicitModel = resolveOpenClawModelRef(normalizedAgentModel, availableModels) ?? null;
    if (explicitModel) {
      return { selectedModel: explicitModel, usesFallback: false, hasInvalidExplicitModel: false };
    }

    return { selectedModel: fallbackModel, usesFallback: true, hasInvalidExplicitModel: false };
  }

  return { selectedModel: fallbackModel, usesFallback: true, hasInvalidExplicitModel: false };
}


/**
 * Hook: resolve the effective selected model for a given agent.
 *
 * Shared by CoworkView (header) and CoworkPromptInput (prompt area) to avoid
 * duplicating the per-agent model resolution logic.
 */
export function useAgentSelectedModel(agentId: string, agentModelRef: string, allowPresets = true): Model {
  const modelState = useSelector((state: RootState) => state.model);
  return useMemo(
    () => {
      if (!allowPresets && modelState.selectedModelByAgent[agentId]?.presetId) {
        const selectedModelByAgent = { ...modelState.selectedModelByAgent };
        delete selectedModelByAgent[agentId];
        return selectAgentSelectedModel({ ...modelState, selectedModelByAgent }, agentId, agentModelRef);
      }
      return selectAgentSelectedModel(modelState, agentId, agentModelRef);
    },
    [modelState, agentId, agentModelRef, allowPresets],
  );
}
