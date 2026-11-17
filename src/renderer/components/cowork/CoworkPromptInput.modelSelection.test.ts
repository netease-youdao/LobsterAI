import { configureStore } from '@reduxjs/toolkit';
import { AgentSource } from '@shared/agent/constants';
import { AuthSessionStatus } from '@shared/auth/constants';
import { ModelPresetId } from '@shared/modelPresets/constants';
import { ProviderName } from '@shared/providers';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { agentService } from '../../services/agent';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { modelPresetName } from '../../services/modelPresets';
import { store as applicationStore } from '../../store';
import coworkReducer, { setCurrentSession } from '../../store/slices/coworkSlice';
import { type Model, ServerModelLoadStatus } from '../../store/slices/modelSlice';
import type { Agent } from '../../types/agent';
import { type CoworkSession, CoworkSessionStatusValue } from '../../types/cowork';
import ModelSelector, { ModelSelectorGroup } from '../ModelSelector';
import CoworkPromptInput from './CoworkPromptInput';

vi.hoisted(() => {
  vi.stubGlobal('navigator', { platform: 'MacIntel' });
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), electron: {} });
});
vi.mock('../../services/agent', () => ({ agentService: { updateAgent: vi.fn() } }));
vi.mock('../../services/cowork', () => ({ coworkService: {
  selectSessionModelPreset: vi.fn(), patchSession: vi.fn(), refreshContextUsage: vi.fn(),
} }));
vi.mock('../../services/useMediaPreferences', () => ({ useMediaPreferences: vi.fn() }));
vi.mock('../../services/logReporter', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/logReporter')>(), reportYdAnalyzer: vi.fn(),
}));
// This suite renders callbacks without a DOM; layout effects are covered by the Electron check.
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useLayoutEffect: react.useEffect,
    default: { ...react, useLayoutEffect: react.useEffect } };
});

let selectorProps: React.ComponentProps<typeof ModelSelector>;
vi.mock('../ModelSelector', async importOriginal => {
  const original = await importOriginal<typeof import('../ModelSelector')>();
  return { ...original, default: (props: React.ComponentProps<typeof ModelSelector>) => {
    selectorProps = props;
    return React.createElement(original.default, props);
  } };
});

const fast: Model = {
  id: 'yd-fast', name: 'Fast', presetId: ModelPresetId.Balanced,
  providerKey: ProviderName.LobsteraiServer, isServerModel: true, accessible: true,
};
const currentFlash: Model = {
  id: 'deepseek-flash-YoudaoInner', name: 'Flash',
  providerKey: ProviderName.LobsteraiServer, isServerModel: true, accessible: true,
};
const custom: Model = { id: 'gpt-test', name: 'Custom', providerKey: ProviderName.OpenAI };
const agent: Agent = {
  id: 'test-agent', name: 'Test agent', model: 'openai/gpt-test', thinkingLevel: '',
  description: '', systemPrompt: '', identity: '', workingDirectory: '', icon: '', skillIds: [],
  subagentAllowAgentIds: [], enabled: true, pinned: false, isDefault: false,
  source: AgentSource.Custom, presetId: '', createdAt: 1, updatedAt: 1,
};
const oldSession: CoworkSession = {
  id: 'old-chat', title: 'Old chat', agentId: agent.id,
  modelOverride: 'lobsterai-server/deepseek-flash', modelPresetId: ModelPresetId.Balanced,
  claudeSessionId: null, scheduledTaskId: null, status: CoworkSessionStatusValue.Completed,
  pinned: false, cwd: '', systemPrompt: '', executionMode: 'local', activeSkillIds: [],
  messages: [{ id: 'history', type: 'user', content: 'Existing conversation', timestamp: 1 }],
  messagesOffset: 0, totalMessages: 1, createdAt: 1, updatedAt: 1,
};
const invalidFastHint = i18nService.t('sessionModelPresetInvalidHint')
  .replace('{preset}', modelPresetName(ModelPresetId.Balanced));
const sendButton = (html: string) => html.match(new RegExp(`<button[^>]*aria-label="${i18nService.t('sendMessage')}"[^>]*>`))?.[0];

function setup(options: { session?: CoworkSession; models?: Model[]; loadStatus?: ServerModelLoadStatus } = {}) {
  const base = applicationStore.getState();
  const session = options.session ?? oldSession;
  const initialState = {
    ...base,
    auth: { ...base.auth, isLoggedIn: true, isLoading: false, sessionStatus: AuthSessionStatus.Authenticated },
    agent: { ...base.agent, currentAgentId: agent.id, agents: [agent] },
    model: { ...base.model, availableModels: options.models ?? [fast, currentFlash, custom],
      defaultSelectedModel: custom, selectedModelByAgent: {},
      serverModelLoadStatus: options.loadStatus ?? ServerModelLoadStatus.Ready },
    cowork: { ...base.cowork, currentSession: session, currentSessionId: session.id,
      draftPrompts: { [session.id]: 'Continue' } },
  };
  const store = configureStore({ reducer: (state = initialState, action) => ({
    ...state, cowork: coworkReducer(state.cowork, action),
  }) });
  const render = () => renderToStaticMarkup(React.createElement(Provider, {
    store, children: React.createElement(CoworkPromptInput, {
      sessionId: session.id, size: 'large', showModelSelector: true, onSubmit: vi.fn(),
    }),
  }));
  vi.mocked(coworkService.selectSessionModelPreset).mockImplementation(async (_id, presetId) => {
    const updated = { ...session, modelPresetId: presetId,
      modelOverride: `${ProviderName.LobsteraiServer}/${currentFlash.id}` };
    store.dispatch(setCurrentSession(updated));
    return updated;
  });
  vi.mocked(coworkService.patchSession).mockImplementation(async (_id, patch) => {
    const updated = { ...session, modelPresetId: null, modelOverride: patch.model ?? session.modelOverride };
    store.dispatch(setCurrentSession(updated));
    return updated;
  });
  return { store, render };
}

beforeEach(() => vi.clearAllMocks());

describe('old chat model recovery', () => {
  test('reselects Fast directly when its concrete model disappeared, without changing the agent default', async () => {
    const { store, render } = setup();
    const before = render();
    expect(before).toContain(invalidFastHint);
    expect(sendButton(before)).toContain('disabled');
    expect(selectorProps.value).toMatchObject({ name: modelPresetName(ModelPresetId.Balanced), isServerModel: true });
    await selectorProps.onChange!(fast, { group: ModelSelectorGroup.Server });
    expect(coworkService.selectSessionModelPreset).toHaveBeenCalledExactlyOnceWith(oldSession.id, ModelPresetId.Balanced, undefined);
    expect(store.getState().cowork.currentSession?.modelOverride).toBe('lobsterai-server/deepseek-flash-YoudaoInner');
    expect(store.getState().cowork.currentSession?.messages).toEqual(oldSession.messages);
    const after = render();
    expect(after).not.toContain(invalidFastHint);
    expect(sendButton(after)).not.toContain('disabled');
    expect(selectorProps.value?.presetId).toBe(ModelPresetId.Balanced);
    expect(agentService.updateAgent).not.toHaveBeenCalled();
    expect(store.getState().agent.agents[0]).toEqual(agent);
    expect(store.getState().model.defaultSelectedModel).toEqual(custom);
    expect(store.getState().model.selectedModelByAgent).toEqual({});
  });

  test('reselects Fast when the old concrete model is still listed but access was revoked', async () => {
    const oldModel = { ...currentFlash, id: 'deepseek-flash', accessible: false };
    const { render } = setup({ models: [fast, oldModel, currentFlash, custom] });
    render();
    await selectorProps.onChange!(fast, { group: ModelSelectorGroup.Server });
    expect(coworkService.selectSessionModelPreset).toHaveBeenCalledOnce();
    expect(agentService.updateAgent).not.toHaveBeenCalled();
  });

  test('keeps a valid Fast binding when the same preset is selected again', async () => {
    const { render } = setup({ session: { ...oldSession,
      modelOverride: `${ProviderName.LobsteraiServer}/${currentFlash.id}` } });
    render();
    await selectorProps.onChange!(fast, { group: ModelSelectorGroup.Server });
    expect(coworkService.selectSessionModelPreset).not.toHaveBeenCalled();
    expect(coworkService.patchSession).not.toHaveBeenCalled();
    expect(agentService.updateAgent).not.toHaveBeenCalled();
  });

  test('keeps custom-model recovery local to the session', async () => {
    const { store, render } = setup();
    render();
    await selectorProps.onChange!(custom, { group: ModelSelectorGroup.User });
    expect(coworkService.patchSession).toHaveBeenCalledExactlyOnceWith(oldSession.id, {
      model: 'openai/gpt-test', thinkingLevel: null,
    });
    expect(store.getState().cowork.currentSession?.modelPresetId).toBeNull();
    expect(agentService.updateAgent).not.toHaveBeenCalled();
    expect(store.getState().agent.agents[0]).toEqual(agent);
  });

  test('allows choosing a concrete plan model without changing the agent default', async () => {
    const { store, render } = setup();
    render();
    await selectorProps.onChange!(currentFlash, { group: ModelSelectorGroup.Server });
    expect(coworkService.patchSession).toHaveBeenCalledExactlyOnceWith(oldSession.id, {
      model: `${ProviderName.LobsteraiServer}/${currentFlash.id}`, thinkingLevel: null,
    });
    expect(store.getState().cowork.currentSession?.modelPresetId).toBeNull();
    expect(agentService.updateAgent).not.toHaveBeenCalled();
  });

  test.each([
    [ServerModelLoadStatus.Loading, 'modelSelectorLoading'],
    [ServerModelLoadStatus.Error, 'modelSelectorUnavailable'],
  ] as const)('shows catalog %s separately from an invalid binding and keeps recovery accessible', (loadStatus, key) => {
    const { render } = setup({ models: [], loadStatus });
    const html = render();
    expect(html).toContain(i18nService.t(key));
    expect(html).not.toContain(invalidFastHint);
    expect(html).not.toContain(i18nService.t('agentModelInvalidHint'));
    expect(sendButton(html)).toContain('disabled');
    expect(selectorProps.disabled).toBe(false);
  });

  test('preserves the old binding after a failed recovery and lets the user retry', async () => {
    const { store, render } = setup();
    vi.mocked(coworkService.selectSessionModelPreset).mockRejectedValueOnce(new Error('Model lookup failed'));
    render();
    await selectorProps.onChange!(fast, { group: ModelSelectorGroup.Server });
    expect(store.getState().cowork.currentSession).toEqual(oldSession);
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ detail: 'Model lookup failed' }));
    render();
    expect(selectorProps.disabled).toBe(false);
    await selectorProps.onChange!(fast, { group: ModelSelectorGroup.Server });
    expect(coworkService.selectSessionModelPreset).toHaveBeenCalledTimes(2);
    expect(store.getState().cowork.currentSession?.modelOverride).toBe('lobsterai-server/deepseek-flash-YoudaoInner');
    expect(agentService.updateAgent).not.toHaveBeenCalled();
  });
});
