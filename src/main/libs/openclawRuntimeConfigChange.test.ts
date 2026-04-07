import { describe, expect, test } from 'vitest';
import { hasOpenClawRuntimeAppConfigChanges } from './openclawRuntimeConfigChange';

const baseConfig = {
  language: 'zh',
  theme: 'dark',
  model: {
    defaultModel: 'doubao-seed-1-6-thinking',
    defaultModelProvider: 'volcengine',
  },
  providers: {
    volcengine: {
      enabled: true,
      apiKey: 'sk-volc',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiFormat: 'openai',
      codingPlanEnabled: true,
      models: [
        { id: 'doubao-seed-1-6-thinking', name: 'Doubao Thinking' },
      ],
    },
  },
};

describe('hasOpenClawRuntimeAppConfigChanges', () => {
  test('returns false for unrelated UI-only changes', () => {
    const nextConfig = {
      ...baseConfig,
      language: 'en',
      theme: 'light',
    };

    expect(hasOpenClawRuntimeAppConfigChanges(baseConfig, nextConfig)).toBe(false);
  });

  test('returns true when default model changes', () => {
    const nextConfig = {
      ...baseConfig,
      model: {
        ...baseConfig.model,
        defaultModel: 'gemini-2.5-flash',
      },
    };

    expect(hasOpenClawRuntimeAppConfigChanges(baseConfig, nextConfig)).toBe(true);
  });

  test('returns true when default model provider changes', () => {
    const nextConfig = {
      ...baseConfig,
      model: {
        ...baseConfig.model,
        defaultModelProvider: 'gemini',
      },
    };

    expect(hasOpenClawRuntimeAppConfigChanges(baseConfig, nextConfig)).toBe(true);
  });

  test('returns true when provider runtime fields change', () => {
    const nextConfig = {
      ...baseConfig,
      providers: {
        ...baseConfig.providers,
        volcengine: {
          ...baseConfig.providers.volcengine,
          apiKey: 'sk-new',
        },
      },
    };

    expect(hasOpenClawRuntimeAppConfigChanges(baseConfig, nextConfig)).toBe(true);
  });

  test('returns true when provider model list changes', () => {
    const nextConfig = {
      ...baseConfig,
      providers: {
        ...baseConfig.providers,
        volcengine: {
          ...baseConfig.providers.volcengine,
          models: [
            ...baseConfig.providers.volcengine.models,
            { id: 'doubao-vision', name: 'Doubao Vision' },
          ],
        },
      },
    };

    expect(hasOpenClawRuntimeAppConfigChanges(baseConfig, nextConfig)).toBe(true);
  });
});
