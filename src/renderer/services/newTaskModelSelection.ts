import { AgentId } from '@shared/agent/constants';
import type { AgentModelSelection } from '@shared/agent/modelSelection';
import { parseModelPresetModelId } from '@shared/modelPresets/constants';
import { supportsLobsterAIRequestOptionsV1 } from '@shared/providers/lobsterAIRequestOptions';
import { getModelThinkingLevels, type ModelThinkingLevel } from '@shared/providers/modelThinking';

import type { RootState } from '../store';
import { isSameModelIdentity, type Model, selectAgentSelectedModel, ServerModelLoadStatus } from '../store/slices/modelSlice';
import type { Agent } from '../types/agent';
import {
  getModelBillingSide,
  getModelRefBillingSide,
  ModelBillingSide,
  resolveOpenClawModelRef,
  toOpenClawModelRef,
} from '../utils/openclawModelRef';

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

/** Shared source of truth for the home composer and expert preparation. */
export function resolveNewTaskModelSelection(
  modelState: RootState['model'],
  agentId: string,
  agent?: Pick<Agent, 'model' | 'thinkingLevel'>,
) {
  const agentModel = agent?.model ?? '';
  const selectedModel = selectAgentSelectedModel(modelState, agentId, agentModel);
  const startModel = resolveAgentStartModel({ agentModel, availableModels: modelState.availableModels, selectedModel });
  return {
    selectedModel,
    startModel,
    // Virtual plan models bind to a concrete model only when a session starts.
    selectedModelRef: selectedModel && !selectedModel.presetId ? toOpenClawModelRef(selectedModel) : '',
    thinkingLevel: selectedModel?.presetId
      ? selectedModel.presetThinkingLevel
        ?? (parseModelPresetModelId(agentModel) === selectedModel.presetId ? agent?.thinkingLevel || undefined : undefined)
      : resolveModelThinkingLevel(selectedModel, agent?.thinkingLevel),
  };
}

/** Capture before switching agents or awaiting installation/catalog downloads. */
export function captureExpertModelSelection(
  state: Pick<RootState, 'model' | 'agent'>,
  targetAgentId?: string,
): AgentModelSelection {
  // Re-summoning the active expert must not inherit its own stale snapshot.
  const sourceAgentId = state.agent.currentAgentId === targetAgentId ? AgentId.Main : state.agent.currentAgentId;
  const sourceAgent = state.agent.agents.find(agent => agent.id === sourceAgentId);
  const selection = resolveNewTaskModelSelection(state.model, sourceAgentId, sourceAgent);
  const unavailableRef = selection.startModel.unavailableModelRef;
  const pendingPlan = unavailableRef
    && getModelRefBillingSide(unavailableRef) === ModelBillingSide.Plan
    && state.model.serverModelLoadStatus !== ServerModelLoadStatus.Ready;
  // Keep an unresolved/blocked reference so summoning cannot bypass the
  // home composer's plan-vs-custom billing guard or freeze a loading fallback.
  const preserveRef = unavailableRef && (selection.startModel.crossesBillingSide || pendingPlan);
  const selectedModel = selection.selectedModel;
  // A signed-out public catalog (or a loading placeholder) is not a user
  // choice. Leave the binding empty so login can supply the new-task default.
  const hasUsableSelection = selectedModel
    && selectedModel.accessible !== false && selectedModel.busy !== true
    && state.model.availableModels.some(model => isSameModelIdentity(model, selectedModel));
  return {
    model: preserveRef ? unavailableRef
      : hasUsableSelection ? toOpenClawModelRef(selectedModel) : sourceAgent?.model ?? '',
    thinkingLevel: preserveRef ? sourceAgent?.thinkingLevel ?? '' : hasUsableSelection ? selection.thinkingLevel ?? '' : '',
  };
}
