import { describe, expect, test } from 'vitest';

import { buildOllamaOpenClawAppConfig } from './ollamaOpenClawBinding';

describe('buildOllamaOpenClawAppConfig', () => {
  test('enables Ollama provider and selects model as default', () => {
    const next = buildOllamaOpenClawAppConfig({}, 'qwen3:8b');

    expect(next.model).toEqual({
      defaultModel: 'qwen3:8b',
      defaultModelProvider: 'ollama',
    });
    expect(next.providers?.ollama).toMatchObject({
      enabled: true,
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      apiFormat: 'openai',
    });
    expect(next.providers?.ollama.models).toEqual([
      { id: 'qwen3:8b', name: 'qwen3:8b', supportsImage: false },
    ]);
  });

  test('preserves existing Ollama models while adding selected model once', () => {
    const next = buildOllamaOpenClawAppConfig({
      model: { defaultModel: 'old', defaultModelProvider: 'openai' },
      providers: {
        ollama: {
          enabled: false,
          apiKey: '',
          baseUrl: 'http://localhost:11434/v1',
          apiFormat: 'openai',
          models: [
            { id: 'qwen3:8b', name: 'Qwen 3 8B', supportsImage: false },
          ],
        },
      },
    }, 'qwen3:8b');

    expect(next.providers?.ollama.models).toEqual([
      { id: 'qwen3:8b', name: 'Qwen 3 8B', supportsImage: false },
    ]);
    expect(next.providers?.ollama.enabled).toBe(true);
    expect(next.model?.defaultModel).toBe('qwen3:8b');
  });

  test('rejects blank model names', () => {
    expect(() => buildOllamaOpenClawAppConfig({}, '   ')).toThrow('Model name is required');
  });
});
