import { AgentId, AgentModelSelectionMode, AgentSource } from '@shared/agent/constants';
import { ModelPresetId } from '@shared/modelPresets/constants';
import { ProviderName } from '@shared/providers/constants';
import { LobsterAIRequestCapability } from '@shared/providers/lobsterAIRequestOptions';
import { ModelThinkingLevel } from '@shared/providers/modelThinking';
import { expect, test } from 'vitest';

import type { RootState } from '../store';
import { type Model, ServerModelLoadStatus } from '../store/slices/modelSlice';
import { toOpenClawModelRef } from '../utils/openclawModelRef';
import { captureExpertModelSelection, resolveNewTaskModelSelection } from './newTaskModelSelection';

const custom: Model = { id: 'shared-model', name: 'Custom', providerKey: ProviderName.DeepSeek };
const plan: Model = {
  ...custom, name: 'Plan', providerKey: ProviderName.LobsteraiServer, isServerModel: true,
  requestCapabilities: [LobsterAIRequestCapability.OptionsV1],
  thinkingConfig: {
    defaultLevel: ModelThinkingLevel.High,
    options: [{ level: ModelThinkingLevel.High, openclawLevel: 'high' }, { level: ModelThinkingLevel.Off, openclawLevel: 'off' }],
  },
};

function snapshot(selected: Model = plan): Pick<RootState, 'model' | 'agent'> {
  return {
    model: {
      defaultSelectedModel: custom, selectedModelByAgent: {},
      availableModels: [selected, custom], serverModelLoadStatus: ServerModelLoadStatus.Ready,
    },
    agent: {
      currentAgentId: AgentId.Main, loading: false, sidebarRevealAgentId: null,
      agents: [{
        id: AgentId.Main, name: 'Main', description: '', icon: '', model: toOpenClawModelRef(selected),
        thinkingLevel: ModelThinkingLevel.Off, workingDirectory: '', enabled: true, pinned: false,
        isDefault: true, source: AgentSource.Custom, skillIds: [], subagentAllowAgentIds: [],
      }],
    },
  };
}

test('summoning inherits the effective new-task plan and thinking level, not the stale global custom default', () => {
  const state = snapshot();
  const home = resolveNewTaskModelSelection(state.model, AgentId.Main, state.agent.agents[0]);
  expect(home.selectedModel).toEqual(plan);
  expect(captureExpertModelSelection(state)).toEqual({ model: home.selectedModelRef, thinkingLevel: home.thinkingLevel });
  expect(home.thinkingLevel).toBe(ModelThinkingLevel.Off);
});

test('a custom provider choice stays custom even when a same-ID plan model is available', () => {
  const state = snapshot(custom);
  state.model.availableModels = [plan, custom];
  state.model.defaultSelectedModel = plan;
  expect(captureExpertModelSelection(state)).toEqual({ model: toOpenClawModelRef(custom), thinkingLevel: '' });
});

test.each([
  [ModelPresetId.Balanced, 'yd-fast'],
  [ModelPresetId.Ultimate, 'yd-ultra'],
] as const)('inherits the %s virtual selection without binding its backend model early', (presetId, id) => {
  const preset = { ...plan, id, presetId };
  const state = snapshot(preset);
  const home = resolveNewTaskModelSelection(state.model, AgentId.Main, state.agent.agents[0]);
  expect(home.selectedModel.presetId).toBe(presetId);
  expect(home.selectedModelRef).toBe('');
  expect(captureExpertModelSelection(state)).toEqual({ model: toOpenClawModelRef(preset), thinkingLevel: ModelThinkingLevel.Off });
});

test('inherits a restored per-agent virtual preference using the same resolver as a new task', () => {
  const state = snapshot(custom);
  const preset = { ...plan, id: 'yd-fast', presetId: ModelPresetId.Balanced, presetThinkingLevel: ModelThinkingLevel.High };
  state.model.availableModels.unshift(preset);
  state.model.selectedModelByAgent[AgentId.Main] = preset;
  expect(captureExpertModelSelection(state)).toEqual({ model: toOpenClawModelRef(preset), thinkingLevel: ModelThinkingLevel.High });
});

test('a restored virtual preference without a thinking choice keeps the preset default', () => {
  const state = snapshot(plan);
  const preset = { ...plan, id: 'yd-fast', presetId: ModelPresetId.Balanced };
  state.model.availableModels.unshift(preset);
  state.model.selectedModelByAgent[AgentId.Main] = preset;
  expect(resolveNewTaskModelSelection(state.model, AgentId.Main, state.agent.agents[0]).thinkingLevel).toBeUndefined();
  expect(captureExpertModelSelection(state)).toEqual({ model: toOpenClawModelRef(preset), thinkingLevel: '' });
});

test('re-summoning the active inherited expert reads the main new-task choice instead of its own old snapshot', () => {
  const state = snapshot();
  state.agent.currentAgentId = 'expert';
  state.agent.agents.push({ ...state.agent.agents[0], id: 'expert', isDefault: false,
    source: AgentSource.Preset, modelSelectionMode: AgentModelSelectionMode.Inherit, model: toOpenClawModelRef(custom) });
  expect(captureExpertModelSelection(state, 'expert').model).toBe(toOpenClawModelRef(plan));
  // A different source agent still contributes its own new-task model.
  expect(captureExpertModelSelection(state, 'another-expert').model).toBe(toOpenClawModelRef(custom));
});

test.each([ServerModelLoadStatus.Idle, ServerModelLoadStatus.Loading, ServerModelLoadStatus.Error])(
  'does not persist a temporary custom fallback while the plan catalog is %s', status => {
    const state = snapshot();
    state.model.availableModels = [custom];
    state.model.serverModelLoadStatus = status;
    expect(captureExpertModelSelection(state)).toEqual({ model: toOpenClawModelRef(plan), thinkingLevel: ModelThinkingLevel.Off });
  },
);

test('summoning preserves a blocked plan reference so it cannot bypass the new-task billing guard', () => {
  const state = snapshot();
  state.model.availableModels = [{ ...plan, accessible: false }, custom];
  const home = resolveNewTaskModelSelection(state.model, AgentId.Main, state.agent.agents[0]);
  expect(home.startModel.crossesBillingSide).toBe(true);
  expect(captureExpertModelSelection(state).model).toBe(toOpenClawModelRef(plan));
});

test('uses the ordinary same-billing fallback when an old plan model is unavailable', () => {
  const state = snapshot();
  const replacement = { ...plan, id: 'replacement' };
  state.model.availableModels = [replacement, custom];
  state.model.defaultSelectedModel = replacement;
  expect(captureExpertModelSelection(state).model).toBe(toOpenClawModelRef(replacement));
});

test('a new signed-out user does not pin the locked public catalog model before login', () => {
  const state = snapshot();
  const publicModel = { ...plan, accessible: false };
  state.agent.agents[0].model = '';
  state.model.availableModels = [publicModel];
  state.model.defaultSelectedModel = publicModel;
  expect(captureExpertModelSelection(state)).toEqual({ model: '', thinkingLevel: '' });

  // Login can expose a different default while keeping the public model usable.
  const loginDefault = { ...plan, id: 'yd-fast', presetId: ModelPresetId.Balanced };
  state.model.availableModels = [loginDefault, plan];
  state.model.defaultSelectedModel = loginDefault;
  const main = resolveNewTaskModelSelection(state.model, AgentId.Main, state.agent.agents[0]);
  const expert = resolveNewTaskModelSelection(state.model, 'new-expert', { model: '', thinkingLevel: '' });
  expect(expert.selectedModel).toEqual(main.selectedModel);
  expect(expert.selectedModel.presetId).toBe(ModelPresetId.Balanced);
});

test('an empty fresh-user catalog does not freeze the built-in model placeholder', () => {
  const state = snapshot(custom);
  state.agent.agents[0].model = '';
  state.model.availableModels = [];
  state.model.serverModelLoadStatus = ServerModelLoadStatus.Loading;
  expect(captureExpertModelSelection(state)).toEqual({ model: '', thinkingLevel: '' });
});
