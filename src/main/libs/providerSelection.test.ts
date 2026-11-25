import { describe, expect, test } from 'vitest';

import { OpenAIApiMode, OpenClawApi, ProviderName } from '../../shared/providers';
import {
  buildProviderSelection,
  PROXY_TOKEN_PLACEHOLDER,
  resolveProxyBackedBaseUrl,
  stripChatCompletionsSuffix,
  stripOpenAIEndpointSuffix,
  stripResponsesSuffix,
} from './providerSelection';

describe('stripOpenAIEndpointSuffix / stripChatCompletionsSuffix / stripResponsesSuffix', () => {
  test('strips /chat/completions and /responses suffixes cleanly', () => {
    expect(stripOpenAIEndpointSuffix('https://openapi.youdao.com/llmgateway/api/v1/chat/completions'))
      .toBe('https://openapi.youdao.com/llmgateway/api/v1');
    expect(stripOpenAIEndpointSuffix('https://api.xiaomimimo.com/v1/chat/completions/'))
      .toBe('https://api.xiaomimimo.com/v1');
    expect(stripOpenAIEndpointSuffix('https://qianfan.baidubce.com/v2/coding/chat/completions'))
      .toBe('https://qianfan.baidubce.com/v2/coding');
    expect(stripOpenAIEndpointSuffix('https://api.openai.com/v1/responses'))
      .toBe('https://api.openai.com/v1');
    expect(stripOpenAIEndpointSuffix('https://api.openai.com/v1/'))
      .toBe('https://api.openai.com/v1');
  });

  test('strips /chat/completions and trailing slashes without altering clean base URLs', () => {
    expect(stripChatCompletionsSuffix('https://openapi.youdao.com/llmgateway/api/v1/chat/completions'))
      .toBe('https://openapi.youdao.com/llmgateway/api/v1');
    expect(stripChatCompletionsSuffix('https://api.xiaomimimo.com/v1/chat/completions/'))
      .toBe('https://api.xiaomimimo.com/v1');
    expect(stripChatCompletionsSuffix('https://qianfan.baidubce.com/v2/coding/chat/completions'))
      .toBe('https://qianfan.baidubce.com/v2/coding');
    expect(stripChatCompletionsSuffix('https://api.example.com/v1/'))
      .toBe('https://api.example.com/v1');
  });

  test('strips /responses and trailing slashes without altering clean base URLs', () => {
    expect(stripResponsesSuffix('https://gw.example.com/v1/responses'))
      .toBe('https://gw.example.com/v1');
    expect(stripResponsesSuffix('https://gw.example.com/v1/responses/'))
      .toBe('https://gw.example.com/v1');
    expect(stripResponsesSuffix('https://gw.example.com/v1/'))
      .toBe('https://gw.example.com/v1');
  });
});

describe('resolveProxyBackedBaseUrl', () => {
  test('rewrites lobsterai-server and github-copilot onto provider-scoped loopback proxy routes', () => {
    expect(resolveProxyBackedBaseUrl(ProviderName.LobsteraiServer, 'http://127.0.0.1:45555'))
      .toBe('http://127.0.0.1:45555/v1/lobsterai-server');
    expect(resolveProxyBackedBaseUrl(ProviderName.LobsteraiServer, 'http://127.0.0.1:45555/'))
      .toBe('http://127.0.0.1:45555/v1/lobsterai-server');
    expect(resolveProxyBackedBaseUrl(ProviderName.LobsteraiServer, 'http://127.0.0.1:45555/v1'))
      .toBe('http://127.0.0.1:45555/v1/lobsterai-server');
    expect(resolveProxyBackedBaseUrl(ProviderName.Copilot, 'http://127.0.0.1:45555'))
      .toBe('http://127.0.0.1:45555/v1/github-copilot');
    expect(resolveProxyBackedBaseUrl('lobsterai-copilot', 'http://127.0.0.1:45555'))
      .toBe('http://127.0.0.1:45555/v1/github-copilot');
  });

  test('rewrites OpenAI Codex OAuth and xAI OAuth onto provider-scoped loopback proxy routes', () => {
    expect(resolveProxyBackedBaseUrl(ProviderName.OpenAI, 'http://127.0.0.1:45555', 'oauth'))
      .toBe('http://127.0.0.1:45555/v1/openai-codex');
    expect(resolveProxyBackedBaseUrl('openai-codex', 'http://127.0.0.1:45555'))
      .toBe('http://127.0.0.1:45555/v1/openai-codex');
    expect(resolveProxyBackedBaseUrl(ProviderName.Xai, 'http://127.0.0.1:45555', 'oauth'))
      .toBe('http://127.0.0.1:45555/v1/xai-oauth');
    expect(resolveProxyBackedBaseUrl('xai-oauth', 'http://127.0.0.1:45555'))
      .toBe('http://127.0.0.1:45555/v1/xai-oauth');
  });

  test('returns null for non-proxy providers or missing proxy origin', () => {
    expect(resolveProxyBackedBaseUrl(ProviderName.OpenAI, 'http://127.0.0.1:45555')).toBeNull();
    expect(resolveProxyBackedBaseUrl(ProviderName.Xai, 'http://127.0.0.1:45555')).toBeNull();
    expect(resolveProxyBackedBaseUrl(ProviderName.LobsteraiServer, null)).toBeNull();
    expect(resolveProxyBackedBaseUrl(ProviderName.Copilot, '')).toBeNull();
  });
});

describe('buildProviderSelection', () => {
  test('canonicalizes OpenClaw provider aliases and strips OpenAI endpoint suffixes', () => {
    const zhipu = buildProviderSelection({
      apiKey: 'sk-zhipu',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      modelId: 'glm-5.3',
      apiType: 'openai',
      providerName: 'zai',
    });
    expect(zhipu.providerId).toBe(ProviderName.Zhipu);
    expect(zhipu.primaryModel).toBe('zhipu/glm-5.3');
    expect(zhipu.providerConfig.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(zhipu.providerConfig.api).toBe(OpenClawApi.OpenAICompletions);

    const codex = buildProviderSelection({
      apiKey: '',
      baseURL: 'https://api.openai.com/v1/responses',
      modelId: 'gpt-5.4',
      apiType: 'openai',
      openaiApiMode: OpenAIApiMode.ChatCompletions,
      providerName: 'openai-codex',
      authType: 'oauth',
    });
    expect(codex.providerId).toBe(ProviderName.OpenAI);
    expect(codex.providerConfig.api).toBe(OpenClawApi.OpenAIResponses);
    expect(codex.providerConfig.baseUrl).toBe('https://api.openai.com/v1');
  });

  test('rewrites lobsterai-server baseUrl to the local loopback proxy when proxyBaseUrl is provided', () => {
    const result = buildProviderSelection({
      apiKey: 'real-user-jwt',
      baseURL: 'https://lobsterai-server.youdao.com/api/proxy/v1',
      modelId: 'deepseek-v3.2',
      apiType: 'openai',
      providerName: ProviderName.LobsteraiServer,
      proxyBaseUrl: 'http://127.0.0.1:45555',
    });

    expect(result.providerConfig).toMatchObject({
      baseUrl: 'http://127.0.0.1:45555/v1/lobsterai-server',
      api: OpenClawApi.OpenAICompletions,
      apiKey: PROXY_TOKEN_PLACEHOLDER,
      auth: 'api-key',
    });
  });

  test('rewrites github-copilot baseUrl to the local loopback proxy when proxyBaseUrl is provided', () => {
    const result = buildProviderSelection({
      apiKey: 'sk-lobsterai-local',
      baseURL: 'https://api.individual.githubcopilot.com',
      modelId: 'gpt-4o',
      apiType: 'openai',
      providerName: ProviderName.Copilot,
      proxyBaseUrl: 'http://127.0.0.1:45555',
    });

    expect(result.providerConfig).toMatchObject({
      baseUrl: 'http://127.0.0.1:45555/v1/github-copilot',
      api: OpenClawApi.OpenAICompletions,
      apiKey: PROXY_TOKEN_PLACEHOLDER,
      auth: 'api-key',
    });
  });

  test.each([
    [ProviderName.Youdaozhiyun, 'https://openapi.youdao.com/llmgateway/api/v1/chat/completions', 'https://openapi.youdao.com/llmgateway/api/v1'],
    [ProviderName.Xiaomi, 'https://api.xiaomimimo.com/v1/chat/completions', 'https://api.xiaomimimo.com/v1'],
    [ProviderName.Qianfan, 'https://qianfan.baidubce.com/v2/coding/chat/completions', 'https://qianfan.baidubce.com/v2/coding'],
    ['custom_0', 'https://custom.example.com/v1/chat/completions/', 'https://custom.example.com/v1'],
  ])('strips /chat/completions suffix for %s', (providerName, baseURL, expectedBaseUrl) => {
    const result = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL,
      modelId: 'model-a',
      apiType: 'openai',
      providerName,
      proxyBaseUrl: 'http://127.0.0.1:45555',
    });

    expect(result.providerConfig).toMatchObject({
      baseUrl: expectedBaseUrl,
      api: OpenClawApi.OpenAICompletions,
      apiKey: 'sk-test',
    });
  });

  test('strips /responses suffix for Responses-mode providers', () => {
    const result = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://gw.example.com/v1/responses/',
      modelId: 'gpt-5.5',
      apiType: 'openai',
      openaiApiMode: OpenAIApiMode.Responses,
      providerName: 'custom_0',
    });

    expect(result.providerConfig).toMatchObject({
      baseUrl: 'https://gw.example.com/v1',
      api: OpenClawApi.OpenAIResponses,
      apiKey: 'sk-test',
    });
  });

  test('rewrites OpenAI OAuth and xAI OAuth to the local loopback proxy when proxyBaseUrl is provided', () => {
    const codex = buildProviderSelection({
      apiKey: '',
      baseURL: 'https://api.openai.com/v1',
      modelId: 'gpt-6-astra',
      apiType: 'openai',
      providerName: ProviderName.OpenAI,
      authType: 'oauth',
      proxyBaseUrl: 'http://127.0.0.1:45555',
    });
    expect(codex.providerConfig).toMatchObject({
      baseUrl: 'http://127.0.0.1:45555/v1/openai-codex',
      api: OpenClawApi.OpenAIResponses,
      apiKey: PROXY_TOKEN_PLACEHOLDER,
      auth: 'api-key',
    });

    const xai = buildProviderSelection({
      apiKey: '',
      baseURL: 'https://api.x.ai/v1',
      modelId: 'grok-4.5',
      apiType: 'openai',
      openaiApiMode: OpenAIApiMode.Responses,
      providerName: ProviderName.Xai,
      authType: 'oauth',
      proxyBaseUrl: 'http://127.0.0.1:45555',
    });
    expect(xai.providerConfig).toMatchObject({
      baseUrl: 'http://127.0.0.1:45555/v1/xai-oauth',
      api: OpenClawApi.OpenAIResponses,
      apiKey: PROXY_TOKEN_PLACEHOLDER,
      auth: 'api-key',
    });
  });

  test('preserves direct OAuth credentials such as MiniMax OAuth and leaves unproxied keyless OAuth without an apiKey', () => {
    const minimax = buildProviderSelection({
      apiKey: 'mm-oauth-access-token',
      baseURL: 'https://api.minimaxi.com/anthropic',
      modelId: 'MiniMax-M3',
      apiType: 'anthropic',
      providerName: ProviderName.Minimax,
      authType: 'oauth',
      proxyBaseUrl: 'http://127.0.0.1:45555',
    });
    expect(minimax.providerConfig).toMatchObject({
      baseUrl: 'https://api.minimaxi.com/anthropic',
      api: OpenClawApi.AnthropicMessages,
      apiKey: 'mm-oauth-access-token',
      auth: 'api-key',
    });

    const unproxied = buildProviderSelection({
      apiKey: '',
      baseURL: 'https://custom-oauth.example.com/v1',
      modelId: 'model-a',
      apiType: 'openai',
      providerName: 'custom_oauth',
      authType: 'oauth',
      proxyBaseUrl: 'http://127.0.0.1:45555',
    });
    expect(unproxied.providerConfig.apiKey).toBeUndefined();
    expect(unproxied.providerConfig.auth).toBe('oauth');
    expect(unproxied.providerConfig.baseUrl).toBe('https://custom-oauth.example.com/v1');
  });
});
