import { supportsLobsterAIRequestOptionsV1 } from '@shared/providers/lobsterAIRequestOptions';
import {
  getModelThinkingLevels,
  type ModelThinkingLevel,
} from '@shared/providers/modelThinking';
import { useMemo } from 'react';
import { useSelector } from 'react-redux';

import type { ModelPresetId } from '../../../shared/modelPresets/constants';
import { modelPresetToModel } from '../../services/modelPresets';
import type { RootState } from '../../store';
import { isSameModelIdentity, type Model, selectAgentSelectedModel } from '../../store/slices/modelSlice';
import type { CoworkAgentEngine } from '../../types/cowork';
import {
  getModelBillingSide,
  getModelRefBillingSide,
  ModelBillingSide,
  resolveOpenClawModelRef,
} from '../../utils/openclawModelRef';

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

export function resolveModelThinkingLevel(
  model: Pick<Model, 'presetId' | 'requestCapabilities' | 'thinkingConfig'> | null | undefined,
  persistedLevel: ModelThinkingLevel | '' | null | undefined,
): ModelThinkingLevel | undefined {
  const config = model?.thinkingConfig;
  if (model?.presetId || !config || !supportsLobsterAIRequestOptionsV1(model.requestCapabilities)) return undefined;
  if (persistedLevel && getModelThinkingLevels(config).includes(persistedLevel)) {
    return persistedLevel;
  }
  return config.defaultLevel;
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

type AgentStartModelResult = {
  /** The model a new session would start with. */
  model: Model | null;
  /** The agent's configured model, when that is not what the session would start with. */
  unavailableModelRef: string | null;
  /** Starting would silently swap plan billing and the user's own provider billing. */
  crossesBillingSide: boolean;
};

/**
 * A new session starts with the agent's resolved selection, which falls back
 * when the configured model is missing or not accessible. Within one billing
 * side that fallback stays silent; across plan and custom billing the user
 * must choose, because the other side spends a different account.
 */
export function resolveAgentStartModel({
  agentModel,
  availableModels,
  selectedModel,
}: {
  agentModel: string;
  availableModels: Model[];
  selectedModel: Model | null;
}): AgentStartModelResult {
  if (selectedModel?.presetId) return { model: selectedModel, unavailableModelRef: null, crossesBillingSide: false };
  const agentModelRef = agentModel.trim();
  if (!agentModelRef) return { model: selectedModel, unavailableModelRef: null, crossesBillingSide: false };

  const configuredModel = resolveOpenClawModelRef(agentModelRef, availableModels);
  if (
    configuredModel
    && configuredModel.accessible !== false
    && selectedModel
    && isSameModelIdentity(configuredModel, selectedModel)
  ) {
    return { model: selectedModel, unavailableModelRef: null, crossesBillingSide: false };
  }

  const configuredSide = getModelRefBillingSide(agentModelRef)
    ?? (configuredModel ? getModelBillingSide(configuredModel) : null);
  // Before the plan catalog loads, a missing plan model says nothing about its availability.
  const planCatalogLoaded = availableModels.some(model => getModelBillingSide(model) === ModelBillingSide.Plan);
  const crossesBillingSide = Boolean(
    selectedModel
    && configuredSide
    && getModelBillingSide(selectedModel) !== configuredSide
    && (configuredSide !== ModelBillingSide.Plan || planCatalogLoaded),
  );
  return { model: selectedModel, unavailableModelRef: agentModelRef, crossesBillingSide };
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
