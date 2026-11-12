import { describe, expect, test } from 'vitest';

import { ModelPresetId } from '../../../shared/modelPresets/constants';
import type { Model } from './modelSlice';
import modelReducer, {
  clearAgentSelectedModel,
  clearServerModels,
  selectAgentSelectedModel,
  setAvailableModels,
  setDefaultSelectedModel,
  setSelectedModel,
  setServerModels,
} from './modelSlice';

const modelA: Model = { id: 'gpt-4o', name: 'GPT-4o', providerKey: 'openai' };
const modelB: Model = { id: 'glm-5.1', name: 'GLM 5.1', providerKey: 'zhipu' };
const modelC: Model = { id: 'claude-3-sonnet', name: 'Claude 3 Sonnet', providerKey: 'anthropic' };
const serverModel: Model = { id: 'server-model', name: 'Server Model', providerKey: 'lobsterai-server', isServerModel: true };
const lockedServerModel: Model = { ...serverModel, accessible: false };
const customKimiModel: Model = { id: 'kimi-k2.6', name: 'Kimi K2.6', providerKey: 'moonshot' };
const serverKimiModel: Model = { id: 'kimi-k2.6', name: 'Kimi K2.6', providerKey: 'lobsterai-server', isServerModel: true };

function makeState(overrides?: Partial<ReturnType<typeof modelReducer>>) {
  const base = modelReducer(undefined, { type: 'init' });
  return { ...base, ...overrides };
}

describe('setSelectedModel', () => {
  test('writes per-agent model to map', () => {
    const state = modelReducer(undefined, setSelectedModel({ agentId: 'agent-1', model: modelA }));
    expect(state.selectedModelByAgent['agent-1']).toEqual(modelA);
  });

  test('overwrites existing per-agent model', () => {
    let state = modelReducer(undefined, setSelectedModel({ agentId: 'agent-1', model: modelA }));
    state = modelReducer(state, setSelectedModel({ agentId: 'agent-1', model: modelB }));
    expect(state.selectedModelByAgent['agent-1']).toEqual(modelB);
  });

  test('independent per-agent entries', () => {
    let state = modelReducer(undefined, setSelectedModel({ agentId: 'agent-1', model: modelA }));
    state = modelReducer(state, setSelectedModel({ agentId: 'agent-2', model: modelB }));
    expect(state.selectedModelByAgent['agent-1']).toEqual(modelA);
    expect(state.selectedModelByAgent['agent-2']).toEqual(modelB);
  });
});

describe('setDefaultSelectedModel', () => {
  test('sets app-level default model', () => {
    const state = modelReducer(undefined, setDefaultSelectedModel(modelB));
    expect(state.defaultSelectedModel).toEqual(modelB);
  });
});

describe('clearAgentSelectedModel', () => {
  test('removes agent entry from map', () => {
    let state = modelReducer(undefined, setSelectedModel({ agentId: 'agent-1', model: modelA }));
    state = modelReducer(state, clearAgentSelectedModel('agent-1'));
    expect(state.selectedModelByAgent['agent-1']).toBeUndefined();
  });

  test('no-op for non-existent agent', () => {
    const state = modelReducer(undefined, clearAgentSelectedModel('non-existent'));
    expect(Object.keys(state.selectedModelByAgent)).toHaveLength(0);
  });
});

describe('setAvailableModels', () => {
  test('re-matches per-agent models when available models change', () => {
    // Set up: agent has modelA selected
    let state = modelReducer(undefined, setSelectedModel({ agentId: 'agent-1', model: modelA }));

    // Update available models — modelA still present but with updated name
    const updatedModelA: Model = { ...modelA, name: 'GPT-4o (Updated)' };
    state = modelReducer(state, setAvailableModels([updatedModelA, modelB]));

    expect(state.selectedModelByAgent['agent-1'].name).toBe('GPT-4o (Updated)');
  });

  test('removes per-agent model when it is no longer available', () => {
    let state = modelReducer(undefined, setSelectedModel({ agentId: 'agent-1', model: modelA }));

    // Update available models — modelA removed
    state = modelReducer(state, setAvailableModels([modelB, modelC]));

    expect(state.selectedModelByAgent['agent-1']).toBeUndefined();
  });

  test('re-matches defaultSelectedModel', () => {
    let state = modelReducer(undefined, setDefaultSelectedModel(modelA));
    const updatedModelA: Model = { ...modelA, supportsImage: true };
    state = modelReducer(state, setAvailableModels([updatedModelA, modelB]));

    expect(state.defaultSelectedModel.supportsImage).toBe(true);
  });
});

describe('setServerModels / clearServerModels', () => {
  test('setServerModels keeps a custom model selected when public server models are locked', () => {
    let state = modelReducer(undefined, setAvailableModels([modelA]));
    state = modelReducer(state, setDefaultSelectedModel(modelA));
    state = modelReducer(state, setServerModels([lockedServerModel]));

    expect(state.defaultSelectedModel).toEqual(modelA);
    expect(state.availableModels[0]).toEqual(lockedServerModel);
  });

  test('setServerModels displays a locked server model when no custom models exist', () => {
    let state = makeState({
      availableModels: [],
      defaultSelectedModel: modelA,
      selectedModelByAgent: {},
    });

    state = modelReducer(state, setServerModels([lockedServerModel]));

    expect(state.availableModels).toEqual([lockedServerModel]);
    expect(state.defaultSelectedModel).toEqual(lockedServerModel);
  });

  test('setServerModels drops the logged-out catalog placeholder for the first accessible model after login', () => {
    const publicCatalogModel: Model = {
      id: 'deepseek-flash',
      name: 'DeepSeek-V4.1-Flash',
      providerKey: 'lobsterai-server',
      isServerModel: true,
      accessible: false,
    };
    const fastPreset: Model = {
      id: 'yd-fast',
      presetId: ModelPresetId.Balanced,
      name: 'Fast',
      providerKey: 'lobsterai-server',
      isServerModel: true,
      accessible: true,
    };
    let state = makeState({
      availableModels: [],
      defaultSelectedModel: modelA,
      selectedModelByAgent: {},
    });

    // Logged out: the public catalog is all locked, so its first entry is only displayed.
    state = modelReducer(state, setServerModels([publicCatalogModel]));
    expect(state.defaultSelectedModel).toEqual(publicCatalogModel);

    // Logged in: the same model id is now accessible, but the user never chose it.
    state = modelReducer(state, setServerModels([fastPreset, { ...publicCatalogModel, accessible: true }]));

    expect(state.defaultSelectedModel).toEqual(fastPreset);
    expect(selectAgentSelectedModel(state, 'main', '')).toEqual(fastPreset);
  });

  test('setServerModels keeps an accessible default model when the catalog refreshes', () => {
    const fastPreset: Model = {
      id: 'yd-fast',
      presetId: ModelPresetId.Balanced,
      name: 'Fast',
      providerKey: 'lobsterai-server',
      isServerModel: true,
    };
    let state = makeState({
      availableModels: [fastPreset, serverModel],
      defaultSelectedModel: serverModel,
      selectedModelByAgent: {},
    });

    state = modelReducer(state, setServerModels([fastPreset, { ...serverModel, name: 'Server Model (Updated)' }]));

    expect(state.defaultSelectedModel.name).toBe('Server Model (Updated)');
  });

  test('setAvailableModels clears fallback custom models while preserving locked server models', () => {
    let state = makeState({
      availableModels: [lockedServerModel, modelA],
      defaultSelectedModel: modelA,
      selectedModelByAgent: {},
    });

    state = modelReducer(state, setAvailableModels([]));

    expect(state.availableModels).toEqual([lockedServerModel]);
    expect(state.defaultSelectedModel).toEqual(lockedServerModel);
  });

  test('setServerModels clears per-agent selections that resolve to locked server models', () => {
    let state = makeState({
      availableModels: [lockedServerModel, modelA],
      defaultSelectedModel: modelA,
      selectedModelByAgent: { 'agent-1': lockedServerModel },
    });

    state = modelReducer(state, setServerModels([lockedServerModel]));

    expect(state.selectedModelByAgent['agent-1']).toBeUndefined();
    expect(state.defaultSelectedModel).toEqual(modelA);
  });

  test('setServerModels syncs per-agent models', () => {
    let state = modelReducer(undefined, setSelectedModel({ agentId: 'agent-1', model: serverModel }));
    const updatedServerModel: Model = { ...serverModel, supportsImage: true };
    state = modelReducer(state, setServerModels([updatedServerModel]));

    expect(state.selectedModelByAgent['agent-1'].supportsImage).toBe(true);
  });

  test('setServerModels does not replace a same-id custom model selection', () => {
    let state = makeState({
      availableModels: [customKimiModel],
      defaultSelectedModel: customKimiModel,
      selectedModelByAgent: { 'agent-1': customKimiModel },
    });

    state = modelReducer(state, setServerModels([serverKimiModel]));

    expect(state.defaultSelectedModel).toEqual(customKimiModel);
    expect(state.selectedModelByAgent['agent-1']).toEqual(customKimiModel);
  });

  test('setAvailableModels does not replace a same-id server model selection', () => {
    let state = makeState({
      availableModels: [serverKimiModel],
      defaultSelectedModel: serverKimiModel,
      selectedModelByAgent: { 'agent-1': serverKimiModel },
    });

    state = modelReducer(state, setAvailableModels([customKimiModel]));

    expect(state.defaultSelectedModel).toEqual(serverKimiModel);
    expect(state.selectedModelByAgent['agent-1']).toEqual(serverKimiModel);
  });

  test('clearServerModels removes server model entries from per-agent map', () => {
    let state = modelReducer(undefined, setSelectedModel({ agentId: 'agent-1', model: serverModel }));
    // Ensure there's at least one non-server model available
    state = modelReducer(state, setAvailableModels([modelA]));
    state = modelReducer(state, setServerModels([serverModel]));
    state = modelReducer(state, clearServerModels());

    // serverModel no longer available → per-agent entry removed
    expect(state.selectedModelByAgent['agent-1']).toBeUndefined();
  });
});

describe('selectAgentSelectedModel', () => {
  test('returns per-agent override when present', () => {
    const state = makeState({
      selectedModelByAgent: { 'agent-1': modelA },
      availableModels: [modelA, modelB],
      defaultSelectedModel: modelB,
    });

    const result = selectAgentSelectedModel(state, 'agent-1', '');
    expect(result).toEqual(modelA);
  });

  test('resolves from agent model ref when no override', () => {
    const state = makeState({
      selectedModelByAgent: {},
      availableModels: [modelA, modelB],
      defaultSelectedModel: modelB,
    });

    const result = selectAgentSelectedModel(state, 'agent-1', 'openai/gpt-4o');
    expect(result.id).toBe('gpt-4o');
  });

  test('uses explicit server agent model ref over a same-id custom override', () => {
    const state = makeState({
      selectedModelByAgent: { 'agent-1': customKimiModel },
      availableModels: [serverKimiModel, customKimiModel],
      defaultSelectedModel: customKimiModel,
    });

    const result = selectAgentSelectedModel(state, 'agent-1', 'lobsterai-server/kimi-k2.6');

    expect(result).toEqual(serverKimiModel);
  });

  test('uses explicit custom agent model ref over a same-id server override', () => {
    const state = makeState({
      selectedModelByAgent: { 'agent-1': serverKimiModel },
      availableModels: [serverKimiModel, customKimiModel],
      defaultSelectedModel: serverKimiModel,
    });

    const result = selectAgentSelectedModel(state, 'agent-1', 'moonshot/kimi-k2.6');

    expect(result).toEqual(customKimiModel);
  });

  test('ignores explicit agent model refs that resolve to locked server models', () => {
    const state = makeState({
      selectedModelByAgent: {},
      availableModels: [lockedServerModel, modelA],
      defaultSelectedModel: modelA,
    });

    const result = selectAgentSelectedModel(state, 'agent-1', 'lobsterai-server/server-model');

    expect(result).toEqual(modelA);
  });

  test('falls back to defaultSelectedModel when agent model is empty', () => {
    const state = makeState({
      selectedModelByAgent: {},
      availableModels: [modelA, modelB],
      defaultSelectedModel: modelB,
    });

    const result = selectAgentSelectedModel(state, 'agent-1', '');
    expect(result).toEqual(modelB);
  });

  test('falls back to defaultSelectedModel when agent model ref is invalid', () => {
    const state = makeState({
      selectedModelByAgent: {},
      availableModels: [modelA, modelB],
      defaultSelectedModel: modelB,
    });

    const result = selectAgentSelectedModel(state, 'agent-1', 'nonexistent/model');
    expect(result).toEqual(modelB);
  });
});
