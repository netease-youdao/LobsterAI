import { beforeEach, describe, expect, test, vi } from 'vitest';

import { OpenClawApi, ProviderName } from '../../shared/providers';

const mocks = vi.hoisted(() => ({
  resolveRawApiConfig: vi.fn(),
  buildProviderSelection: vi.fn(),
}));
vi.mock('./claudeSettings', () => ({ resolveRawApiConfig: mocks.resolveRawApiConfig }));
vi.mock('./openclawConfigSync', () => ({ buildProviderSelection: mocks.buildProviderSelection }));

import {
  buildOneShotHttpRequest,
  type OneShotTarget,
  OneShotTargetError,
  readOneShotStreamEvent,
  resolveOneShotTarget,
  toOneShotTarget,
} from './oneShotModelClient';

const selection = (api: string, apiKey: string | undefined, baseUrl = 'https://api.example.com/v1') => ({
  sessionModelId: 'test-model',
  providerConfig: {
    baseUrl,
    api,
    ...(apiKey !== undefined ? { apiKey } : {}),
    auth: 'api-key',
    models: [{ id: 'test-model', name: 'Test', api, input: ['text'] }],
  },
}) as never;

const request = {
  system: 'Be brief.',
  messages: [{ role: 'user' as const, content: 'Hello' }],
  maxTokens: 2048,
};

const target = (api: OpenClawApi, overrides: Partial<OneShotTarget> = {}): OneShotTarget => ({
  api,
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  providerName: 'custom_0',
  ...overrides,
});

const bodyOf = (init: RequestInit) => JSON.parse(init.body as string);

describe('toOneShotTarget', () => {
  test('uses the provider key for regular providers', () => {
    expect(toOneShotTarget({
      selection: selection(OpenClawApi.OpenAICompletions, '${LOBSTER_APIKEY_CUSTOM_0}', 'https://api.example.com/v1/'),
      providerName: 'custom_0',
      apiKey: 'sk-real',
      proxyToken: 'proxy-token',
    })).toEqual({
      target: {
        api: OpenClawApi.OpenAICompletions,
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-real',
        model: 'test-model',
        providerName: 'custom_0',
      },
    });
  });

  test('uses the loopback proxy token for proxied providers', () => {
    const resolution = toOneShotTarget({
      selection: selection(OpenClawApi.OpenAICompletions, '${LOBSTER_PROXY_TOKEN}', 'http://127.0.0.1:4100/v1/copilot'),
      providerName: ProviderName.Copilot,
      apiKey: 'stale-key',
      proxyToken: 'proxy-token',
    });
    expect(resolution).toMatchObject({ target: { apiKey: 'proxy-token', baseUrl: 'http://127.0.0.1:4100/v1/copilot' } });
  });

  test('rejects transports and OAuth routes it cannot call', () => {
    expect(toOneShotTarget({
      selection: selection(OpenClawApi.OpenAIChatGPTResponses, undefined),
      providerName: ProviderName.OpenAI,
      apiKey: '',
      proxyToken: null,
    })).toMatchObject({ error: OneShotTargetError.UnsupportedModel });
    expect(toOneShotTarget({
      selection: selection(OpenClawApi.OpenAIResponses, undefined),
      providerName: ProviderName.Xai,
      apiKey: '',
      proxyToken: null,
    })).toMatchObject({ error: OneShotTargetError.UnsupportedModel });
  });
});

describe('resolveOneShotTarget', () => {
  beforeEach(() => {
    mocks.resolveRawApiConfig.mockReset();
    mocks.buildProviderSelection.mockReset();
  });

  test('builds the selection from the raw default model', () => {
    mocks.resolveRawApiConfig.mockReturnValue({
      config: { apiKey: 'sk-real', baseURL: 'https://gw.example.com/v1', model: ' gpt-5.5 ', apiType: 'openai' },
      providerMetadata: { providerName: 'custom_0', codingPlanEnabled: false, openaiApiMode: 'responses' },
    });
    mocks.buildProviderSelection.mockReturnValue(selection(OpenClawApi.OpenAIResponses, '${LOBSTER_APIKEY_CUSTOM_0}'));

    const resolution = resolveOneShotTarget({ getProxyToken: () => 'proxy-token' });

    expect(mocks.buildProviderSelection).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'gpt-5.5',
      apiType: 'openai',
      openaiApiMode: 'responses',
      providerName: 'custom_0',
    }));
    expect(resolution).toMatchObject({ target: { api: OpenClawApi.OpenAIResponses, apiKey: 'sk-real' } });
  });

  test('reports a missing model', () => {
    mocks.resolveRawApiConfig.mockReturnValue({ config: null, error: 'Application config not found.' });
    expect(resolveOneShotTarget({ getProxyToken: () => null })).toEqual({
      error: OneShotTargetError.NoModel,
      detail: 'Application config not found.',
    });
    expect(mocks.buildProviderSelection).not.toHaveBeenCalled();
  });
});

describe('buildOneShotHttpRequest', () => {
  test('anthropic messages', () => {
    const { url, init } = buildOneShotHttpRequest(target(OpenClawApi.AnthropicMessages, { baseUrl: 'https://api.example.com' }), request);
    expect(url).toBe('https://api.example.com/v1/messages');
    expect(init.headers).toMatchObject({ 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' });
    expect(bodyOf(init)).toEqual({
      model: 'test-model',
      max_tokens: 2048,
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });
  });

  test('openai chat completions', () => {
    const { url, init } = buildOneShotHttpRequest(target(OpenClawApi.OpenAICompletions), request);
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-test' });
    expect(bodyOf(init)).toEqual({
      model: 'test-model',
      messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello' }],
      max_tokens: 2048,
      stream: true,
    });
  });

  test('uses max_completion_tokens for OpenAI reasoning models only', () => {
    const openAI = buildOneShotHttpRequest(target(OpenClawApi.OpenAICompletions, { providerName: ProviderName.OpenAI, model: 'gpt-5.5' }), request);
    expect(bodyOf(openAI.init)).toMatchObject({ max_completion_tokens: 2048 });
    expect(bodyOf(openAI.init)).not.toHaveProperty('max_tokens');
    const other = buildOneShotHttpRequest(target(OpenClawApi.OpenAICompletions, { model: 'gpt-5.5' }), request);
    expect(bodyOf(other.init)).toMatchObject({ max_tokens: 2048 });
  });

  test('openai responses', () => {
    const { url, init } = buildOneShotHttpRequest(target(OpenClawApi.OpenAIResponses), request);
    expect(url).toBe('https://api.example.com/v1/responses');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-test' });
    expect(bodyOf(init)).toEqual({
      model: 'test-model',
      input: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello' }],
      max_output_tokens: 2048,
      stream: true,
    });
  });

  test('gemini generateContent', () => {
    const { url, init } = buildOneShotHttpRequest(
      target(OpenClawApi.GoogleGenerativeAI, { baseUrl: 'https://relay.example.com/v1beta', model: 'gemini-3-pro' }),
      { ...request, messages: [...request.messages, { role: 'assistant', content: 'Hi' }] },
    );
    expect(url).toBe('https://relay.example.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse');
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'sk-test' });
    expect(bodyOf(init)).toEqual({
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'Hello' }] },
        { role: 'model', parts: [{ text: 'Hi' }] },
      ],
      generationConfig: { maxOutputTokens: 2048 },
    });
  });
});

describe('readOneShotStreamEvent', () => {
  test('dispatches to the reader for each transport', () => {
    expect(readOneShotStreamEvent(OpenClawApi.AnthropicMessages, {
      data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}',
    })).toEqual({ text: 'a' });
    expect(readOneShotStreamEvent(OpenClawApi.OpenAICompletions, { data: '{"choices":[{"delta":{"content":"b"}}]}' }))
      .toEqual({ text: 'b' });
    expect(readOneShotStreamEvent(OpenClawApi.OpenAIResponses, { data: '{"type":"response.output_text.delta","delta":"c"}' }))
      .toEqual({ text: 'c' });
    expect(readOneShotStreamEvent(OpenClawApi.GoogleGenerativeAI, {
      data: '{"candidates":[{"content":{"parts":[{"text":"d"}]}}]}',
    })).toEqual({ text: 'd' });
  });
});
