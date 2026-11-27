import { ProviderName } from '@shared/providers';
import { describe, expect, test } from 'vitest';

import { getDefaultProviders, type ProviderConfig, type ProvidersConfig } from './modelProviderUtils';
import {
  applyImmediateProviderMutation,
  discardProviderConnectionDraft,
  isProviderConnectionDirty,
} from './modelSettingsPersistence';

const makeBaseProviders = (): ProvidersConfig => {
  const defaults = getDefaultProviders();
  return {
    ...defaults,
    openai: {
      ...defaults.openai,
      enabled: true,
      apiKey: 'sk-saved',
      baseUrl: 'https://api.openai.com/v1',
      apiFormat: 'openai',
    },
    deepseek: {
      ...defaults.deepseek,
      enabled: false,
      apiKey: 'sk-ds',
      baseUrl: 'https://api.deepseek.com',
      apiFormat: 'openai',
    },
  };
};

describe('modelSettingsPersistence', () => {
  test('detects clean vs dirty provider connection fields with trim normalization', () => {
    const saved = makeBaseProviders();
    expect(isProviderConnectionDirty(saved.openai, { ...saved.openai }, ProviderName.OpenAI)).toBe(false);
    expect(
      isProviderConnectionDirty(
        saved.openai,
        { ...saved.openai, apiKey: '  sk-saved  ', baseUrl: ' https://api.openai.com/v1 ' },
        ProviderName.OpenAI,
      ),
    ).toBe(false);
    expect(
      isProviderConnectionDirty(
        saved.openai,
        { ...saved.openai, apiKey: 'sk-updated' },
        ProviderName.OpenAI,
      ),
    ).toBe(true);
  });

  test('treats newly added unsaved custom provider as dirty and discards by removing it', () => {
    const saved = makeBaseProviders();
    const customDraft: ProviderConfig = {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://relay.example.com/v1',
      apiFormat: 'openai',
      models: [],
    };
    const current: ProvidersConfig = {
      ...saved,
      custom_1: customDraft,
    };

    expect(isProviderConnectionDirty(saved.custom_1, current.custom_1, 'custom_1')).toBe(true);

    const reverted = discardProviderConnectionDraft(saved, current, 'custom_1');
    expect(reverted.custom_1).toBeUndefined();
    expect(reverted.openai).toEqual(saved.openai);
  });

  test('discardProviderConnectionDraft reverts connection edits while keeping saved models', () => {
    const saved = makeBaseProviders();
    const addedModel = { id: 'gpt-custom', name: 'GPT Custom', supportsImage: false };
    const savedWithAddedModel: ProvidersConfig = {
      ...saved,
      openai: {
        ...saved.openai,
        models: [...(saved.openai.models ?? []), addedModel],
      },
    };
    const current: ProvidersConfig = {
      ...savedWithAddedModel,
      openai: {
        ...savedWithAddedModel.openai,
        apiKey: 'sk-unsaved-draft',
        baseUrl: 'https://custom-proxy.example.com/v1',
      },
    };

    const reverted = discardProviderConnectionDraft(savedWithAddedModel, current, ProviderName.OpenAI);
    expect(reverted.openai.apiKey).toBe('sk-saved');
    expect(reverted.openai.baseUrl).toBe('https://api.openai.com/v1');
    expect(reverted.openai.models).toEqual(savedWithAddedModel.openai.models);
  });

  test('applyImmediateProviderMutation updates both current and saved without committing unrelated connection drafts', () => {
    const saved = makeBaseProviders();
    const current: ProvidersConfig = {
      ...saved,
      openai: {
        ...saved.openai,
        apiKey: 'sk-half-typed-draft',
      },
    };

    const newModel = { id: 'gpt-new', name: 'GPT New', supportsImage: true };
    const { nextSaved, nextCurrent } = applyImmediateProviderMutation(
      saved,
      current,
      ProviderName.OpenAI,
      (provider) => ({ ...provider, models: [...(provider.models ?? []), newModel] }),
    );

    expect(nextSaved).not.toBeNull();
    // Saved baseline gets the new model, but keeps the persisted API key.
    expect(nextSaved!.openai.apiKey).toBe('sk-saved');
    expect((nextSaved!.openai.models ?? []).some(m => m.id === 'gpt-new')).toBe(true);
    // Current displayed state keeps the user's half-typed draft plus the new model.
    expect(nextCurrent.openai.apiKey).toBe('sk-half-typed-draft');
    expect((nextCurrent.openai.models ?? []).some(m => m.id === 'gpt-new')).toBe(true);
  });

  test('applyImmediateProviderMutation keeps changes local for an unsaved custom provider', () => {
    const saved = makeBaseProviders();
    const current: ProvidersConfig = {
      ...saved,
      custom_1: {
        enabled: false,
        apiKey: 'sk-new',
        baseUrl: 'https://relay.example.com/v1',
        apiFormat: 'openai',
        models: [],
      },
    };

    const newModel = { id: 'relay-model', name: 'Relay Model', supportsImage: false };
    const { nextSaved, nextCurrent } = applyImmediateProviderMutation(
      saved,
      current,
      'custom_1',
      (provider) => ({ ...provider, models: [newModel] }),
    );

    expect(nextSaved).toBeNull();
    expect(nextCurrent.custom_1?.models).toEqual([newModel]);
  });
});
