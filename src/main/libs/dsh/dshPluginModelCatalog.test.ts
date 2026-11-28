import { describe, expect, test } from 'vitest';

import {
  ModelThinkingLevel,
  OpenClawThinkingLevel,
} from '../../../shared/providers/modelThinking';
import {
  buildModelThinkingConfigFromDshEfforts,
  extractDshPluginModels,
  findDshPluginModel,
  parseRawProviderModelRef,
} from './dshPluginModelCatalog';

describe('dshPluginModelCatalog', () => {
  test('extracts third-party plugin models while excluding LobsterAI synced and built-in providers', () => {
    const snapshot = extractDshPluginModels(
      {
        groups: [
          {
            id: 'lobsterai-server',
            name: 'LobsterAI',
            models: [{ id: 'yd-fast', name: 'Fast' }],
          },
          {
            id: 'deepseek-account',
            name: 'DeepSeek Account',
            models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
          },
          {
            id: 'openai',
            name: 'OpenAI (Custom)',
            models: [{ id: 'gpt-5', name: 'GPT-5' }],
          },
          {
            id: 'our-free-model',
            name: 'Our Free Model',
            models: [
              {
                id: 'deepseek-v4.1-flash',
                name: 'DeepSeek V4.1 Flash',
                description: 'Free frontier model',
                badge: 'Free',
                reasoning: {
                  defaultEffort: 'high',
                  efforts: [
                    { id: 'off', name: 'Off' },
                    { id: 'medium', name: 'Medium' },
                    { id: 'high', name: 'High' },
                  ],
                },
              },
              {
                id: 'deepseek-v4.1-flash',
                name: 'Duplicate should be ignored',
              },
              {
                id: 'kimi-k3',
                name: 'Kimi K3',
              },
            ],
          },
          {
            id: 'empty-plugin-provider',
            name: 'Empty Plugin',
            models: [],
          },
        ],
        failures: [
          { id: 'openai', name: 'OpenAI', message: 'should be filtered' },
          { id: 'broken-plugin', name: 'Broken Plugin', message: 'upstream timeout' },
        ],
      },
      new Set(['OpenAI']),
      { fetchedAt: 12345 },
    );

    expect(snapshot.fetchedAt).toBe(12345);
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.groups[0]).toMatchObject({
      providerId: 'our-free-model',
      providerName: 'Our Free Model',
    });
    expect(snapshot.models).toHaveLength(2);
    expect(snapshot.models[0]).toEqual({
      id: 'deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      providerId: 'our-free-model',
      providerName: 'Our Free Model',
      description: 'Free frontier model',
      badge: 'Free',
      defaultReasoningEffort: 'high',
      reasoningEfforts: [
        { id: 'off', name: 'Off' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
    });
    expect(snapshot.models[1]).toEqual({
      id: 'kimi-k3',
      name: 'Kimi K3',
      providerId: 'our-free-model',
      providerName: 'Our Free Model',
    });
    expect(snapshot.failures).toEqual([
      {
        providerId: 'broken-plugin',
        providerName: 'Broken Plugin',
        message: 'upstream timeout',
      },
    ]);

    expect(findDshPluginModel(snapshot, 'our-free-model', 'kimi-k3')).toEqual(snapshot.models[1]);
    expect(findDshPluginModel(snapshot, 'our-free-model', 'missing')).toBeUndefined();
  });

  test('parseRawProviderModelRef keeps provider IDs verbatim and rejects malformed inputs', () => {
    expect(parseRawProviderModelRef('our-free-model/deepseek-v4.1-flash')).toEqual({
      providerId: 'our-free-model',
      modelId: 'deepseek-v4.1-flash',
    });
    expect(parseRawProviderModelRef('  custom-plugin/org/model-v1  ')).toEqual({
      providerId: 'custom-plugin',
      modelId: 'org/model-v1',
    });
    expect(parseRawProviderModelRef('bare-model-id')).toBeNull();
    expect(parseRawProviderModelRef('/leading-slash')).toBeNull();
    expect(parseRawProviderModelRef('trailing-slash/')).toBeNull();
    expect(parseRawProviderModelRef('')).toBeNull();
  });

  test('buildModelThinkingConfigFromDshEfforts maps standard efforts and ignores invalid/off-only sets', () => {
    const config = buildModelThinkingConfigFromDshEfforts(
      [
        { id: 'low' },
        { id: 'high' },
        { id: 'max' },
        { id: 'unknown-effort' },
      ],
      'max',
    );
    expect(config).toEqual({
      defaultLevel: ModelThinkingLevel.Max,
      options: [
        { level: ModelThinkingLevel.Low, openclawLevel: OpenClawThinkingLevel.Low },
        { level: ModelThinkingLevel.High, openclawLevel: OpenClawThinkingLevel.High },
        { level: ModelThinkingLevel.Max, openclawLevel: OpenClawThinkingLevel.XHigh },
      ],
    });

    expect(buildModelThinkingConfigFromDshEfforts([{ id: 'off' }], 'off')).toBeUndefined();
    expect(buildModelThinkingConfigFromDshEfforts([{ id: 'custom-only' }])).toBeUndefined();
    expect(buildModelThinkingConfigFromDshEfforts([])).toBeUndefined();
  });
});
