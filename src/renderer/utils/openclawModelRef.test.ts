import { OpenClawProviderId, ProviderName } from '@shared/providers/constants';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { getModelRefBillingSide, ModelBillingSide, resolveOpenClawModelRef } from './openclawModelRef';

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
});

test('getModelRefBillingSide reads the provider prefix', () => {
  expect(getModelRefBillingSide('lobsterai-server/qwen3.8-flash')).toBe(ModelBillingSide.Plan);
  expect(getModelRefBillingSide('qwen/qwen3.8-max')).toBe(ModelBillingSide.Custom);
  expect(getModelRefBillingSide('qwen3.8-max')).toBeNull();
});
