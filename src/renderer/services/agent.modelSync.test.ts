import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { afterEach, expect, test, vi } from 'vitest';

import { ModelPresetId, modelPresetModelId } from '../../shared/modelPresets/constants';
import { resolveAgentModelSelection } from '../components/cowork/agentModelSelection';
import { buildCoworkStartPlan } from '../components/cowork/coworkStartRequest';
import { useHomeStartContext } from '../components/cowork/useHomeStartContext';
import { store } from '../store';
import { resetAccountSessionData } from '../store/accountSessionBoundary';
import { setCurrentAgentId } from '../store/slices/agentSlice';
import { setDraftPrompt } from '../store/slices/coworkSlice';
import { type Model, setSelectedModel, setServerModels } from '../store/slices/modelSlice';
import { setActiveSkillIds } from '../store/slices/skillSlice';
import type { Agent } from '../types/agent';
import { CoworkCollaborationMode } from '../types/cowork';
import { toOpenClawModelRef } from '../utils/openclawModelRef';
import { agentService } from './agent';
import { buildCoworkCapabilitySelection } from './coworkCapabilitySelection';

afterEach(() => { vi.unstubAllGlobals(); store.dispatch(resetAccountSessionData()); });

function readHomeContext() {
  const observed: { current?: ReturnType<typeof useHomeStartContext> } = {};
  function Probe() { observed.current = useHomeStartContext(); return null; }
  renderToStaticMarkup(createElement(Provider, { store, children: createElement(Probe) }));
  if (!observed.current) throw new Error('Home context did not render');
  return observed.current;
}

test('external Agent refresh updates the home picker and start request while preserving drafts and session overrides', async () => {
  store.dispatch(resetAccountSessionData());
  const fast: Model = { id: modelPresetModelId(ModelPresetId.Balanced), name: 'Fast', presetId: ModelPresetId.Balanced, providerKey: 'lobsterai-server', isServerModel: true };
  const ultimate: Model = { ...fast, id: modelPresetModelId(ModelPresetId.Ultimate), name: 'Ultimate', presetId: ModelPresetId.Ultimate };
  const agent: Agent = {
    id: 'agent', name: 'Agent', description: '', systemPrompt: '', identity: '', model: toOpenClawModelRef(fast), thinkingLevel: '',
    workingDirectory: '/work', icon: '', skillIds: [], subagentAllowAgentIds: [], enabled: true, pinned: false,
    isDefault: false, source: 'custom', presetId: '', createdAt: 1, updatedAt: 1,
  };
  let saved = agent;
  let onChanged: (() => void) | undefined;
  const setPreference = vi.fn().mockResolvedValue({ success: true });
  const list = vi.fn(async () => [saved]);
  vi.stubGlobal('window', { electron: {
    agents: {
      list,
      onChanged: (listener: () => void) => { onChanged = listener; },
      update: vi.fn(async (_id: string, updates: Partial<Agent>) => { saved = { ...saved, ...updates }; return saved; }),
    },
    modelPresets: { setPreference },
  } });
  store.dispatch(setServerModels([fast, ultimate]));
  await agentService.loadAgents();
  store.dispatch(setCurrentAgentId(agent.id));
  store.dispatch(setSelectedModel({ agentId: agent.id, model: fast }));
  store.dispatch(setSelectedModel({ agentId: 'other-agent', model: fast }));
  store.dispatch(setActiveSkillIds(['draft-skill']));
  store.dispatch(setDraftPrompt({ sessionId: '__home__', draft: 'Keep this draft' }));
  const coworkBefore = store.getState().cowork;
  expect(readHomeContext().selectedModel.presetId).toBe(ModelPresetId.Balanced);

  saved = { ...agent, model: toOpenClawModelRef(ultimate) };
  expect(onChanged).toBeTypeOf('function');
  onChanged!();
  await vi.waitFor(() => expect(store.getState().agent.agents[0].model).toBe(saved.model));
  const home = readHomeContext();
  expect(home.selectedModel.presetId).toBe(ModelPresetId.Ultimate);
  expect(home.startModel.model).toEqual(ultimate);
  const { options } = buildCoworkStartPlan({
    prompt: 'Task', title: 'Task', kitIds: [], capabilities: buildCoworkCapabilitySelection([], [], [], {}, []),
    collaborationMode: CoworkCollaborationMode.Default, cwd: home.workingDirectory, agentId: home.currentAgentId,
    modelRef: home.selectedModelRef, modelPresetId: home.selectedModel.presetId, thinkingLevel: home.thinkingLevel,
  });
  expect(options).toMatchObject({ modelPresetId: ModelPresetId.Ultimate, modelOverride: '', agentId: agent.id, cwd: '/work' });
  expect(store.getState().cowork).toBe(coworkBefore);
  expect(store.getState().skill.activeSkillIds).toEqual(['draft-skill']);
  expect(store.getState().model.selectedModelByAgent['other-agent']).toEqual(fast);
  expect(resolveAgentModelSelection({
    sessionModel: toOpenClawModelRef(fast), sessionPresetId: ModelPresetId.Balanced,
    agentModel: saved.model, availableModels: [fast, ultimate], fallbackModel: home.selectedModel, engine: 'openclaw',
  }).selectedModel?.presetId).toBe(ModelPresetId.Balanced);

  // A later preference/catalog reload must not restore the obsolete choice.
  store.dispatch(setSelectedModel({ agentId: agent.id, model: fast }));
  expect(readHomeContext().selectedModel.presetId).toBe(ModelPresetId.Ultimate);

  // Local edits still update the originating window without a change notification.
  await agentService.updateAgent(agent.id, { model: toOpenClawModelRef(fast), thinkingLevel: '' });
  expect(setPreference).toHaveBeenCalledWith(agent.id, null);
  expect(readHomeContext().selectedModel.presetId).toBe(ModelPresetId.Balanced);
  expect(store.getState().skill.activeSkillIds).toEqual(['draft-skill']);
});
