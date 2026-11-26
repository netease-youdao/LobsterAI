import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, test, vi } from 'vitest';

const HELPERS_URL = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/model-bridge-helpers.mjs'),
).href;

type ModelBridgeHelpers = {
  canonicalizeProviderId: (rawId: unknown) => string;
  normalizeProtocol: (rawApi: unknown) => string;
  normalizeProviderBaseUrl: (
    rawBaseUrl: unknown,
    modelApi?: string,
    providerApi?: string,
    hasExplicitModelBaseUrl?: boolean,
  ) => string;
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
  resolveEffectiveContextWindow: (
    model: { contextWindow: number; contextWindows?: Array<{ id: string; contextWindow: number }> },
    selectionId?: unknown,
    overrideTokens?: unknown,
  ) => number;
  selectProtocolImpl: (
    protocols: Record<string, () => unknown>,
    implCache: Map<string, unknown>,
    modelApi: unknown,
    defaultApi: string,
  ) => unknown;
  applyModelPayloadTransforms: (
    params: unknown,
    model?: { compat?: Record<string, unknown> },
    customParams?: Record<string, unknown>,
  ) => Record<string, unknown>;
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

  test('leaves native OpenAI, explicit overrides, and non-completions protocols untouched and avoids leaking OpenAI providerCompat into Anthropic models', async () => {
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
        { supportsDeveloperRole: false, supportsStore: false },
        undefined,
        'openai-completions',
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

  test('strips /chat/completions and /responses suffixes and normalizes inherited Anthropic /v1 URLs', async () => {
    const { normalizeProviderBaseUrl } = await loadHelpers();

    expect(
      normalizeProviderBaseUrl('https://openapi.youdao.com/llmgateway/api/v1/chat/completions/', 'openai-completions'),
    ).toBe('https://openapi.youdao.com/llmgateway/api/v1');
    expect(
      normalizeProviderBaseUrl('https://api.xiaomimimo.com/v1/chat/completions', 'openai-completions'),
    ).toBe('https://api.xiaomimimo.com/v1');
    expect(
      normalizeProviderBaseUrl('https://gateway.example.com/v1/responses/', 'openai-responses'),
    ).toBe('https://gateway.example.com/v1');
    expect(
      normalizeProviderBaseUrl('http://127.0.0.1:8080/v1', 'anthropic-messages', 'openai-completions', false),
    ).toBe('http://127.0.0.1:8080');
    expect(
      normalizeProviderBaseUrl('https://custom.example.com/v1', 'anthropic-messages', 'openai-completions', true),
    ).toBe('https://custom.example.com/v1');
  });

  test('canonicalizes all 5 legacy OpenClaw provider IDs', async () => {
    const { canonicalizeProviderId } = await loadHelpers();

    expect(canonicalizeProviderId('zai')).toBe('zhipu');
    expect(canonicalizeProviderId('google')).toBe('gemini');
    expect(canonicalizeProviderId('lobsterai-copilot')).toBe('github-copilot');
    expect(canonicalizeProviderId('minimax-portal')).toBe('minimax');
    expect(canonicalizeProviderId('openai-codex')).toBe('openai');
    expect(canonicalizeProviderId('lobsterai-server')).toBe('lobsterai-server');
  });

  test('selects and caches protocol implementations per model api', async () => {
    const { selectProtocolImpl } = await loadHelpers();

    const openaiImpl = { kind: 'openai' };
    const anthropicImpl = { kind: 'anthropic' };
    const openaiFactory = vi.fn(() => openaiImpl);
    const anthropicFactory = vi.fn(() => anthropicImpl);
    const cache = new Map<string, unknown>();
    const protocols = {
      'openai-completions': openaiFactory,
      'anthropic-messages': anthropicFactory,
    };

    expect(selectProtocolImpl(protocols, cache, undefined, 'openai-completions')).toBe(openaiImpl);
    expect(selectProtocolImpl(protocols, cache, 'anthropic', 'openai-completions')).toBe(anthropicImpl);
    expect(selectProtocolImpl(protocols, cache, 'anthropic-messages', 'openai-completions')).toBe(anthropicImpl);
    expect(openaiFactory).toHaveBeenCalledTimes(1);
    expect(anthropicFactory).toHaveBeenCalledTimes(1);
  });

  test('preserves explicit thinkingLevelMap nulls, ignores unknown keys, and derives maps from thinkingConfig', async () => {
    const { resolveModelThinkingLevelMap } = await loadHelpers();

    expect(resolveModelThinkingLevelMap({ thinkingLevelMap: { high: 'max' } }, false)).toBeUndefined();
    expect(resolveModelThinkingLevelMap({}, true)).toEqual({
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    });

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
            ignoredKey: 'nope',
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

  test('injects customParams and flattens text-only content arrays when requiresStringContent is enabled', async () => {
    const { applyModelPayloadTransforms, invokeModelApiStream } = await loadHelpers();

    const payload = {
      model: 'kimi-k3',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'World' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect image' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
          ],
        },
      ],
    };

    const result = applyModelPayloadTransforms(
      payload,
      { compat: { requiresStringContent: true } },
      { top_k: 40, repetition_penalty: 1.05 },
    );

    expect(result.top_k).toBe(40);
    expect(result.repetition_penalty).toBe(1.05);
    expect((result.messages as Array<{ content: unknown }>)[0].content).toBe('Hello\nWorld');
    // Multimodal messages remain array-formatted.
    expect(Array.isArray((result.messages as Array<{ content: unknown }>)[1].content)).toBe(true);

    // Also verify invokeModelApiStream applies customParams and requiresStringContent on stream payload.
    let capturedOptions: Record<string, unknown> | undefined;
    const apiImpl = {
      stream: vi.fn(),
      streamSimple: vi.fn((_m: unknown, _c: unknown, opts: Record<string, unknown>) => {
        capturedOptions = opts;
        return 'ok';
      }),
    };
    const streamModel = {
      id: 'deepseek-reasoner',
      provider: 'youdaozhiyun',
      api: 'openai-completions',
      compat: { requiresStringContent: true },
    };
    invokeModelApiStream({
      method: 'streamSimple',
      apiImpl,
      model: streamModel,
      context: {},
      options: {},
      modelMeta: { customParams: { top_k: 40 } },
    });
    const streamPayload: Record<string, unknown> = {
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    };
    const onPayload = capturedOptions?.onPayload as (p: Record<string, unknown>, m: unknown) => unknown;
    await onPayload(streamPayload, streamModel);
    expect(streamPayload.top_k).toBe(40);
    expect((streamPayload.messages as Array<{ content: unknown }>)[0].content).toBe('Hi');
  });

  test('resolves effective per-session context windows from explicit override, named preset, or user-context string', async () => {
    const { resolveEffectiveContextWindow } = await loadHelpers();

    const model = {
      contextWindow: 200_000,
      contextWindows: [
        { id: 'model-default', contextWindow: 200_000 },
        { id: 'yd-fast', contextWindow: 400_000 },
        { id: 'user-context:1000000', contextWindow: 1_000_000 },
      ],
    };

    expect(resolveEffectiveContextWindow(model, 'yd-fast', undefined)).toBe(400_000);
    expect(resolveEffectiveContextWindow(model, 'user-context:1000000', undefined)).toBe(1_000_000);
    expect(resolveEffectiveContextWindow(model, 'user-context:yd-fast:800000', undefined)).toBe(800_000);
    expect(resolveEffectiveContextWindow(model, 'yd-fast', 600_000)).toBe(600_000);
    expect(resolveEffectiveContextWindow(model, null, null)).toBe(200_000);
  });
});
