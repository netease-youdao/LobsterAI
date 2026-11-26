import { OpenClawProviderId, ProviderName } from '@shared/providers/constants';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { getModelRefBillingSide, matchesOpenClawModelRef, ModelBillingSide, resolveOpenClawModelRef } from './openclawModelRef';

afterEach(() => { vi.restoreAllMocks(); });

describe('resolveOpenClawModelRef', () => {
  test('resolves legacy OpenAI Codex refs to the canonical OpenAI provider', () => {
    const model = {
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      providerKey: ProviderName.OpenAI,
      openClawProviderId: OpenClawProviderId.OpenAI,
    };

    expect(resolveOpenClawModelRef('openai-codex/gpt-5.4', [model])).toBe(model);
  });

  test('keeps compatibility with old OpenAI OAuth model lists', () => {
    const model = {
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      providerKey: ProviderName.OpenAI,
      openClawProviderId: OpenClawProviderId.OpenAICodex,
    };

    expect(resolveOpenClawModelRef('openai/gpt-5.4', [model])).toBe(model);
  });

  test('follows a renamed provider by model id on the same billing side', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const renamed = { id: 'qwen3.8-max', name: 'Qwen', providerKey: 'qwen', openClawProviderId: 'qwen-portal' };

    expect(resolveOpenClawModelRef('qwen/qwen3.8-max', [renamed])).toBe(renamed);
  });

  test('never resolves a custom model ref to a plan model with the same id, or back', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const planModel = { id: 'qwen3.8-max', name: 'Qwen Plan', providerKey: ProviderName.LobsteraiServer, isServerModel: true };
    const customModel = { id: 'glm-5', name: 'GLM', providerKey: 'zhipu', openClawProviderId: 'zai' };

    expect(resolveOpenClawModelRef('qwen/qwen3.8-max', [planModel])).toBeNull();
    expect(resolveOpenClawModelRef('lobsterai-server/glm-5', [customModel])).toBeNull();
    expect(resolveOpenClawModelRef('lobsterai-server/qwen3.8-max', [planModel])).toBe(planModel);
  });

  test('resolves and matches canonical DSH vs OpenClaw provider aliases across all 5 pairs', () => {
    const models = [
      { id: 'glm-5.3', name: 'GLM', providerKey: ProviderName.Zhipu, openClawProviderId: OpenClawProviderId.Zai },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini', providerKey: ProviderName.Gemini, openClawProviderId: OpenClawProviderId.Google },
      { id: 'gpt-5-mini', name: 'Copilot', providerKey: ProviderName.Copilot, openClawProviderId: OpenClawProviderId.LobsteraiCopilot },
      { id: 'MiniMax-M3', name: 'MiniMax', providerKey: ProviderName.Minimax, openClawProviderId: OpenClawProviderId.MinimaxPortal },
      { id: 'gpt-5.4', name: 'OpenAI', providerKey: ProviderName.OpenAI, openClawProviderId: OpenClawProviderId.OpenAI },
    ];

    expect(resolveOpenClawModelRef('zhipu/glm-5.3', models)).toBe(models[0]);
    expect(resolveOpenClawModelRef('gemini/gemini-3.1-pro-preview', models)).toBe(models[1]);
    expect(resolveOpenClawModelRef('github-copilot/gpt-5-mini', models)).toBe(models[2]);
    expect(resolveOpenClawModelRef('minimax/MiniMax-M3', models)).toBe(models[3]);
    expect(resolveOpenClawModelRef('openai-codex/gpt-5.4', models)).toBe(models[4]);

    expect(matchesOpenClawModelRef('zhipu/glm-5.3', models[0])).toBe(true);
    expect(matchesOpenClawModelRef('github-copilot/gpt-5-mini', models[2])).toBe(true);
    expect(matchesOpenClawModelRef('minimax/MiniMax-M3', models[3])).toBe(true);
  });
});

test('getModelRefBillingSide reads the provider prefix', () => {
  expect(getModelRefBillingSide('lobsterai-server/qwen3.8-flash')).toBe(ModelBillingSide.Plan);
  expect(getModelRefBillingSide('qwen/qwen3.8-max')).toBe(ModelBillingSide.Custom);
  expect(getModelRefBillingSide('qwen3.8-max')).toBeNull();
});
