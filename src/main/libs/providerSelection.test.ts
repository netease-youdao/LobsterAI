import { describe, expect, test } from 'vitest';

import { OpenAIApiMode, OpenClawApi, ProviderName } from '../../shared/providers';
import { buildProviderSelection, stripOpenAIEndpointSuffix } from './providerSelection';

describe('stripOpenAIEndpointSuffix', () => {
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
});
