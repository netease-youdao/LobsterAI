import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, test } from 'vitest';

const HELPERS_URL = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/model-bridge-helpers.mjs'),
).href;

type ModelBridgeHelpers = {
  isNativeOpenAIEndpoint: (baseUrl: unknown) => boolean;
  resolveModelCompat: (
    modelApi: string,
    modelBaseUrl: string,
    providerCompat?: unknown,
    modelCompat?: unknown,
  ) => Record<string, unknown>;
};

let cached: ModelBridgeHelpers | null = null;
async function loadHelpers(): Promise<ModelBridgeHelpers> {
  if (!cached) {
    cached = (await import(HELPERS_URL)) as ModelBridgeHelpers;
  }
  return cached;
}

describe('model-bridge-helpers', () => {
  test('identifies native OpenAI endpoints by exact hostname only', async () => {
    const { isNativeOpenAIEndpoint } = await loadHelpers();

    expect(isNativeOpenAIEndpoint('https://api.openai.com/v1')).toBe(true);
    expect(isNativeOpenAIEndpoint('https://API.OPENAI.COM/v1/')).toBe(true);
    expect(isNativeOpenAIEndpoint('http://127.0.0.1:49277/v1/lobsterai-server')).toBe(false);
    expect(isNativeOpenAIEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe(false);
    expect(isNativeOpenAIEndpoint('https://api.openai.com.evil.com/v1')).toBe(false);
    expect(isNativeOpenAIEndpoint('')).toBe(false);
    expect(isNativeOpenAIEndpoint('not-a-url')).toBe(false);
  });

  test('defaults supportsDeveloperRole and supportsStore to false on non-native openai-completions endpoints', async () => {
    const { resolveModelCompat } = await loadHelpers();

    expect(
      resolveModelCompat(
        'openai-completions',
        'http://127.0.0.1:49277/v1/lobsterai-server',
        undefined,
        undefined,
      ),
    ).toEqual({
      supportsDeveloperRole: false,
      supportsStore: false,
    });

    expect(
      resolveModelCompat(
        'openai-completions',
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        { requiresReasoningContentOnAssistantMessages: true },
        undefined,
      ),
    ).toEqual({
      requiresReasoningContentOnAssistantMessages: true,
      supportsDeveloperRole: false,
      supportsStore: false,
    });
  });

  test('leaves native OpenAI, explicit overrides, and non-completions protocols untouched', async () => {
    const { resolveModelCompat } = await loadHelpers();

    expect(
      resolveModelCompat('openai-completions', 'https://api.openai.com/v1', undefined, undefined),
    ).toEqual({});

    expect(
      resolveModelCompat(
        'openai-completions',
        'https://proxy.example.com/v1',
        { supportsDeveloperRole: false },
        { supportsDeveloperRole: true, supportsStore: true },
      ),
    ).toEqual({
      supportsDeveloperRole: true,
      supportsStore: true,
    });

    expect(
      resolveModelCompat(
        'anthropic-messages',
        'https://dashscope.aliyuncs.com/apps/anthropic',
        undefined,
        undefined,
      ),
    ).toEqual({});

    expect(
      resolveModelCompat(
        'openai-responses',
        'https://proxy.example.com/v1',
        undefined,
        undefined,
      ),
    ).toEqual({});
  });
});
