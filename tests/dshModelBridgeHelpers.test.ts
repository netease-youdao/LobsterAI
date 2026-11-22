import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, test, vi } from 'vitest';

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
    providerApi?: string,
  ) => Record<string, unknown>;
  resolveModelThinkingLevelMap: (
    rawModel: Record<string, unknown>,
    reasoning: boolean,
  ) => Record<string, string | null> | undefined;
  resolveDefaultRequestMaxTokens: (
    rawDefaultMaxTokens: unknown,
    rawMaxTokens: unknown,
    contextWindow: number,
  ) => number | undefined;
  applyKimiK3PayloadContract: (payload: Record<string, unknown>) => void;
  resolveRequestOptionsThinkingLevel: (
    thinkingConfig: unknown,
    rawReasoningEffort: unknown,
    fallbackReasoning: unknown,
  ) => string | undefined;
  invokeModelApiStream: (params: Record<string, unknown>) => unknown;
  dispatchProviderStream: (params: Record<string, unknown>) => unknown;
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

  test('does not inherit OpenAI provider compat onto Anthropic models inside a mixed provider', async () => {
    const { resolveModelCompat } = await loadHelpers();

    expect(
      resolveModelCompat(
        'anthropic-messages',
        'http://127.0.0.1:49277/v1/lobsterai-server',
        { supportsDeveloperRole: false, supportsStore: false },
        undefined,
        'openai-completions',
      ),
    ).toEqual({});

    expect(
      resolveModelCompat(
        'openai-completions',
        'http://127.0.0.1:49277/v1/lobsterai-server',
        { supportsDeveloperRole: false, supportsStore: false },
        { maxTokensField: 'max_tokens', supportsUsageInStreaming: false },
        'openai-completions',
      ),
    ).toEqual({
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: 'max_tokens',
      supportsUsageInStreaming: false,
    });
  });

  test('preserves explicit thinkingLevelMap nulls and derives maps from thinkingConfig', async () => {
    const { resolveModelThinkingLevelMap } = await loadHelpers();

    expect(
      resolveModelThinkingLevelMap(
        {
          thinkingLevelMap: {
            off: null,
            minimal: 'max',
            low: 'max',
            medium: 'max',
            high: 'max',
            xhigh: 'max',
            max: 'max',
          },
        },
        true,
      ),
    ).toEqual({
      off: null,
      minimal: 'max',
      low: 'max',
      medium: 'max',
      high: 'max',
      xhigh: 'max',
      max: 'max',
    });

    expect(
      resolveModelThinkingLevelMap(
        {
          thinkingConfig: {
            options: [
              { level: 'off', openclawLevel: 'off' },
              { level: 'high', openclawLevel: 'high' },
              { level: 'max', openclawLevel: 'xhigh' },
            ],
            defaultLevel: 'high',
          },
        },
        true,
      ),
    ).toEqual({
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max',
    });

    expect(resolveModelThinkingLevelMap({}, false)).toBeUndefined();
  });

  test('caps huge catalog maxTokens to safe per-request defaults while honoring explicit caps', async () => {
    const { resolveDefaultRequestMaxTokens } = await loadHelpers();

    expect(resolveDefaultRequestMaxTokens(undefined, 1_048_576, 1_048_576)).toBe(131_072);
    expect(resolveDefaultRequestMaxTokens(131_072, 1_048_576, 1_048_576)).toBe(131_072);
    expect(resolveDefaultRequestMaxTokens(undefined, 32_768, 1_000_000)).toBe(32_768);
    expect(resolveDefaultRequestMaxTokens(undefined, undefined, 1_000_000)).toBeUndefined();
  });

  test('dispatches mixed-protocol models under one provider by model.api', async () => {
    const { dispatchProviderStream } = await loadHelpers();

    const openaiStreamSimple = vi.fn(() => 'openai-stream');
    const anthropicStreamSimple = vi.fn(() => 'anthropic-stream');
    const protocols = {
      'openai-completions': vi.fn(() => ({ stream: vi.fn(), streamSimple: openaiStreamSimple })),
      'anthropic-messages': vi.fn(() => ({ stream: vi.fn(), streamSimple: anthropicStreamSimple })),
    };
    const apiImplCache = new Map();

    const spec = { provider: 'lobsterai-server', api: 'openai-completions' };
    const r1 = dispatchProviderStream({
      method: 'streamSimple',
      spec,
      protocols,
      apiImplCache,
      model: { id: 'glm-5.3-flash-YoudaoInner', provider: 'lobsterai-server', api: 'openai-completions' },
      context: {},
      options: {},
    });
    const r2 = dispatchProviderStream({
      method: 'streamSimple',
      spec,
      protocols,
      apiImplCache,
      model: { id: 'claude-sonnet-5-5-hc-YoudaoInner', provider: 'lobsterai-server', api: 'anthropic-messages' },
      context: {},
      options: {},
    });

    expect(r1).toBe('openai-stream');
    expect(r2).toBe('anthropic-stream');
    expect(openaiStreamSimple).toHaveBeenCalledTimes(1);
    expect(anthropicStreamSimple).toHaveBeenCalledTimes(1);
    expect(protocols['openai-completions']).toHaveBeenCalledTimes(1);
    expect(protocols['anthropic-messages']).toHaveBeenCalledTimes(1);
  });

  test('injects lobsterai_options v1 preserving explicit off, max, and default fallback', async () => {
    const { invokeModelApiStream } = await loadHelpers();

    const thinkingConfig = {
      options: [
        { level: 'off', openclawLevel: 'off' },
        { level: 'high', openclawLevel: 'high' },
        { level: 'max', openclawLevel: 'xhigh' },
      ],
      defaultLevel: 'high',
    };

    const runWithEffort = async (rawEffort: string | undefined, piReasoning?: string) => {
      let capturedOptions: Record<string, unknown> | undefined;
      const apiImpl = {
        stream: vi.fn(),
        streamSimple: vi.fn((_m: unknown, _c: unknown, opts: Record<string, unknown>) => {
          capturedOptions = opts;
          return 'ok';
        }),
      };

      invokeModelApiStream({
        method: 'streamSimple',
        apiImpl,
        model: { id: 'glm-5.3-flash-YoudaoInner', provider: 'lobsterai-server', api: 'openai-completions' },
        context: {},
        options: piReasoning ? { reasoning: piReasoning } : {},
        modelMeta: { thinkingConfig, requestOptionsVersion: 1 },
        requestContext: rawEffort !== undefined ? { reasoningEffort: rawEffort } : {},
      });

      const payload: Record<string, unknown> = { model: 'glm-5.3-flash-YoudaoInner', messages: [] };
      const onPayload = capturedOptions?.onPayload as (p: Record<string, unknown>, m: unknown) => unknown;
      await onPayload(payload, {});
      return payload;
    };

    // Explicit 'off': PiAiAdapter strips options.reasoning to undefined, but requestContext preserves 'off'.
    expect((await runWithEffort('off', undefined)).lobsterai_options).toEqual({
      version: 1,
      thinking: { level: 'off' },
    });

    // Explicit 'max'.
    expect((await runWithEffort('max', 'max')).lobsterai_options).toEqual({
      version: 1,
      thinking: { level: 'max' },
    });

    // Unset or invalid level falls back to defaultLevel ('high').
    expect((await runWithEffort(undefined, undefined)).lobsterai_options).toEqual({
      version: 1,
      thinking: { level: 'high' },
    });
    expect((await runWithEffort('low', undefined)).lobsterai_options).toEqual({
      version: 1,
      thinking: { level: 'high' },
    });
  });

  test('enforces Kimi K3 payload contract and rejects non-openai-completions transport', async () => {
    const { invokeModelApiStream } = await loadHelpers();

    let capturedModel: Record<string, unknown> | undefined;
    let capturedOptions: Record<string, unknown> | undefined;
    const apiImpl = {
      stream: vi.fn(),
      streamSimple: vi.fn((m: Record<string, unknown>, _c: unknown, opts: Record<string, unknown>) => {
        capturedModel = m;
        capturedOptions = opts;
        return 'ok';
      }),
    };

    invokeModelApiStream({
      method: 'streamSimple',
      apiImpl,
      model: { id: 'kimi-k3-YoudaoInner', provider: 'lobsterai-server', api: 'openai-completions', reasoning: false },
      context: {},
      options: {},
      modelMeta: { runtimeProfile: 'moonshot-kimi-k3' },
    });

    expect(capturedModel?.reasoning).toBe(true);
    expect(capturedOptions?.reasoning).toBe('max');

    const payload: Record<string, unknown> = {
      model: 'kimi-k3-YoudaoInner',
      temperature: 0.7,
      top_p: 0.9,
      n: 1,
      presence_penalty: 0.2,
      frequency_penalty: 0.1,
      thinking: { type: 'enabled' },
      reasoningEffort: 'low',
      messages: [
        { role: 'user', content: 'read file' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      ],
    };
    const onPayload = capturedOptions?.onPayload as (p: Record<string, unknown>, m: unknown) => unknown;
    await onPayload(payload, capturedModel);

    expect(payload.reasoning_effort).toBe('max');
    expect(payload.temperature).toBeUndefined();
    expect(payload.top_p).toBeUndefined();
    expect(payload.n).toBeUndefined();
    expect(payload.presence_penalty).toBeUndefined();
    expect(payload.frequency_penalty).toBeUndefined();
    expect(payload.thinking).toBeUndefined();
    expect(payload.reasoningEffort).toBeUndefined();
    expect((payload.messages as Array<Record<string, unknown>>)[1].reasoning_content).toBe('');

    expect(() =>
      invokeModelApiStream({
        method: 'streamSimple',
        apiImpl,
        model: { id: 'kimi-k3-YoudaoInner', provider: 'lobsterai-server', api: 'anthropic-messages' },
        context: {},
        options: {},
        modelMeta: { runtimeProfile: 'moonshot-kimi-k3' },
      }),
    ).toThrow(/requires openai-completions/);
  });

  test('omits synthetic disabled thinking on Anthropic models without thinkingConfig', async () => {
    const { invokeModelApiStream } = await loadHelpers();

    let capturedOptions: Record<string, unknown> | undefined;
    const apiImpl = {
      stream: vi.fn(),
      streamSimple: vi.fn((_m: unknown, _c: unknown, opts: Record<string, unknown>) => {
        capturedOptions = opts;
        return 'ok';
      }),
    };

    invokeModelApiStream({
      method: 'streamSimple',
      apiImpl,
      model: { id: 'claude-sonnet-5-5-hc-YoudaoInner', provider: 'lobsterai-server', api: 'anthropic-messages' },
      context: {},
      options: {},
    });

    const disabledPayload: Record<string, unknown> = {
      model: 'claude-sonnet-5-5-hc-YoudaoInner',
      thinking: { type: 'disabled' },
      messages: [],
    };
    const onPayload = capturedOptions?.onPayload as (p: Record<string, unknown>, m: unknown) => unknown;
    await onPayload(disabledPayload, {});
    expect(disabledPayload.thinking).toBeUndefined();

    const enabledPayload: Record<string, unknown> = {
      model: 'claude-sonnet-5-5-hc-YoudaoInner',
      thinking: { type: 'adaptive', display: 'summarized' },
      messages: [],
    };
    await onPayload(enabledPayload, {});
    expect(enabledPayload.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });
});
