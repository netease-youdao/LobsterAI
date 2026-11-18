import { AgentId, AgentModelSelectionMode, AgentSource } from '@shared/agent/constants';
import { ModelPresetId } from '@shared/modelPresets/constants';
import { ProviderName } from '@shared/providers/constants';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { store } from '../store';
import { setAgents, setCurrentAgentId } from '../store/slices/agentSlice';
import { setLoggedOut } from '../store/slices/authSlice';
import { clearAgentSelectedModel, clearServerModels, type Model, selectAgentSelectedModel, setAvailableModels, setDefaultSelectedModel, setSelectedModel, setServerModels } from '../store/slices/modelSlice';
import type { Agent } from '../types/agent';
import { agentService } from './agent';
import { authService } from './auth';

const custom: Model = { id: 'same-id', name: 'Custom', providerKey: ProviderName.DeepSeek };
const plan: Model = { id: 'same-id', name: 'Plan', providerKey: ProviderName.LobsteraiServer, isServerModel: true };
const expert: Agent = {
  id: 'expert-model-test', name: 'Expert', description: '', identity: '', systemPrompt: '',
  model: 'lobsterai-server/same-id', modelSelectionMode: AgentModelSelectionMode.Inherit, thinkingLevel: '',
  workingDirectory: '', icon: '', skillIds: [], subagentAllowAgentIds: [], enabled: true,
  pinned: false, isDefault: false, source: AgentSource.Preset, presetId: 'preset-model-test', createdAt: 1, updatedAt: 1,
};
const addPreset = vi.fn();
const update = vi.fn();
const setPreference = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  addPreset.mockResolvedValue(expert);
  update.mockImplementation(async (_id, updates) => ({ ...expert, ...updates }));
  setPreference.mockResolvedValue({ success: true });
  vi.stubGlobal('window', { electron: { agents: { addPreset, update }, modelPresets: { setPreference } } });
  store.dispatch(clearServerModels());
  store.dispatch(clearAgentSelectedModel(AgentId.Main));
  store.dispatch(clearAgentSelectedModel(expert.id));
  store.dispatch(setAvailableModels([custom]));
  store.dispatch(setServerModels([plan]));
  store.dispatch(setDefaultSelectedModel(custom));
  store.dispatch(setCurrentAgentId(AgentId.Main));
  store.dispatch(setAgents([{ ...expert, id: AgentId.Main, source: AgentSource.Custom, isDefault: true }, expert]));
});

afterEach(() => {
  authService.destroy();
  store.dispatch(setLoggedOut());
  vi.unstubAllGlobals();
});

test('all preset callers pass the actual new-task model and propagate inherited mode into renderer state', async () => {
  await agentService.addPreset(expert.presetId);
  expect(addPreset).toHaveBeenCalledExactlyOnceWith(expert.presetId, { model: expert.model, thinkingLevel: '' });
  expect(store.getState().agent.agents.find(agent => agent.id === expert.id)?.modelSelectionMode).toBe(AgentModelSelectionMode.Inherit);
  expect(store.getState().model.defaultSelectedModel).toEqual(custom);
});

test('an inherited expert clears an obsolete virtual override that would hide the newly inherited model', async () => {
  const preset = { ...plan, id: 'yd-fast', presetId: ModelPresetId.Balanced };
  store.dispatch(setSelectedModel({ agentId: expert.id, model: preset }));
  await agentService.addPreset(expert.presetId);
  expect(setPreference).toHaveBeenCalledExactlyOnceWith(expert.id, null);
  expect(selectAgentSelectedModel(store.getState().model, expert.id, expert.model)).toEqual(plan);
});

test('explicit legacy expert preferences survive repeated summons', async () => {
  addPreset.mockResolvedValue({ ...expert, modelSelectionMode: AgentModelSelectionMode.Explicit, model: 'deepseek/same-id' });
  store.dispatch(setSelectedModel({ agentId: expert.id, model: custom }));
  await agentService.addPreset(expert.presetId);
  expect(setPreference).not.toHaveBeenCalled();
  expect(store.getState().model.selectedModelByAgent[expert.id]).toEqual(custom);
});

test('opting the active expert into inheritance captures the main choice and persists it with the mode', async () => {
  store.dispatch(setCurrentAgentId(expert.id));
  await agentService.updateAgent(expert.id, { modelSelectionMode: AgentModelSelectionMode.Inherit });
  expect(update).toHaveBeenCalledExactlyOnceWith(expert.id, {
    modelSelectionMode: AgentModelSelectionMode.Inherit, model: expert.model, thinkingLevel: '',
  });
});

test('the new-task choice is captured before an asynchronous summon completes', async () => {
  let finish!: (agent: Agent) => void;
  addPreset.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = agentService.addPreset(expert.presetId);
  store.dispatch(setAgents([{ ...expert, id: AgentId.Main, model: 'deepseek/same-id', source: AgentSource.Custom, isDefault: true }]));
  finish(expert);
  await pending;
  expect(addPreset).toHaveBeenCalledExactlyOnceWith(expert.presetId, { model: expert.model, thinkingLevel: '' });
});

test('a zero-session guest expert follows the authenticated new-task default after the real auth callback flow', async () => {
  store.dispatch(setLoggedOut());
  store.dispatch(setAvailableModels([]));
  store.dispatch(setServerModels([{ ...plan, accessible: false }]));
  store.dispatch(setAgents([{ ...expert, id: AgentId.Main, model: '', source: AgentSource.Custom, isDefault: true }]));
  addPreset.mockImplementation(async (_id, selection) => ({ ...expert, ...selection }));
  const created = await agentService.addPreset(expert.presetId);
  expect(created?.model).toBe('');
  expect(store.getState().cowork.sessions).toHaveLength(0);
  store.dispatch(setCurrentAgentId(expert.id));

  const getModels = vi.fn().mockResolvedValue({ success: true, models: [
    { modelId: 'yd-fast', modelName: 'Fast', provider: 'LobsterAI', apiFormat: 'openai', presetId: ModelPresetId.Balanced, accessible: true },
    { modelId: plan.id, modelName: plan.name, provider: 'LobsterAI', apiFormat: 'openai', accessible: true },
  ] });
  vi.stubGlobal('window', { electron: {
    auth: {
      exchange: vi.fn().mockResolvedValue({ success: true, user: { yid: 'fresh-user', userId: '123', nickname: 'New user', avatarUrl: null }, enterpriseContext: null }),
      getModels,
      getQuota: vi.fn().mockResolvedValue({ success: false }),
      getProfileSummary: vi.fn().mockResolvedValue({ success: false }),
    },
    modelPresets: { getPreferences: vi.fn().mockResolvedValue({ success: true, data: {} }) },
  } });
  expect(await authService.handleCallback('test-callback')).toBe(true);
  const state = store.getState();
  expect(state.auth.isLoggedIn).toBe(true);
  expect(state.cowork.sessions).toHaveLength(0);
  expect(state.agent.currentAgentId).toBe(expert.id);
  expect(selectAgentSelectedModel(state.model, expert.id, created?.model ?? '')).toEqual(
    selectAgentSelectedModel(state.model, AgentId.Main, ''),
  );
  expect(selectAgentSelectedModel(state.model, expert.id, '').presetId).toBe(ModelPresetId.Balanced);
});
