import { test, expect, describe } from 'vitest';
import {
  ProviderName,
  ProviderRegistry,
  ApiFormat,
} from './constants';

describe('ProviderName constants', () => {
  test('contains expected provider keys', () => {
    expect(ProviderName.OpenAI).toBe('openai');
    expect(ProviderName.DeepSeek).toBe('deepseek');
    expect(ProviderName.Custom).toBe('custom');
    expect(ProviderName.LobsteraiServer).toBe('lobsterai-server');
  });
});

describe('ProviderRegistry', () => {
  test('providerIds returns 15 providers (no custom)', () => {
    const ids = ProviderRegistry.providerIds;
    expect(ids.length).toBe(15);
    expect(ids).not.toContain(ProviderName.Custom);
    expect(ids).not.toContain(ProviderName.LobsteraiServer);
  });

  test('get returns definition for known provider', () => {
    const def = ProviderRegistry.get(ProviderName.OpenAI);
    expect(def).toBeDefined();
    expect(def!.id).toBe(ProviderName.OpenAI);
    expect(def!.defaultApiFormat).toBe(ApiFormat.OpenAI);
    expect(def!.region).toBe('global');
  });

  test('get returns undefined for unknown provider', () => {
    expect(ProviderRegistry.get('nonexistent')).toBeUndefined();
    expect(ProviderRegistry.get(ProviderName.Custom)).toBeUndefined();
  });

  test('supportsCodingPlan is true for moonshot, qwen, zhipu, volcengine', () => {
    expect(ProviderRegistry.supportsCodingPlan(ProviderName.Moonshot)).toBe(true);
    expect(ProviderRegistry.supportsCodingPlan(ProviderName.Qwen)).toBe(true);
    expect(ProviderRegistry.supportsCodingPlan(ProviderName.Zhipu)).toBe(true);
    expect(ProviderRegistry.supportsCodingPlan(ProviderName.Volcengine)).toBe(true);
  });

  test('supportsCodingPlan is false for others', () => {
    expect(ProviderRegistry.supportsCodingPlan(ProviderName.OpenAI)).toBe(false);
    expect(ProviderRegistry.supportsCodingPlan(ProviderName.DeepSeek)).toBe(false);
    expect(ProviderRegistry.supportsCodingPlan('unknown')).toBe(false);
  });

  test('idsByRegion china returns 10 providers', () => {
    const china = ProviderRegistry.idsByRegion('china');
    expect(china.length).toBe(10);
    expect(china).toContain(ProviderName.DeepSeek);
    expect(china).toContain(ProviderName.Ollama);
    expect(china).not.toContain(ProviderName.OpenAI);
  });

  test('idsByRegion global returns 5 providers', () => {
    const global = ProviderRegistry.idsByRegion('global');
    expect(global.length).toBe(5);
    expect(global).toContain(ProviderName.OpenAI);
    expect(global).toContain(ProviderName.Gemini);
    expect(global).toContain(ProviderName.Anthropic);
    expect(global).toContain(ProviderName.OpenRouter);
    expect(global).toContain(ProviderName.Copilot);
  });

  test('idsForEnLocale starts with EN_PRIORITY providers in order', () => {
    const en = ProviderRegistry.idsForEnLocale();
    expect(en[0]).toBe(ProviderName.OpenAI);
    expect(en[1]).toBe(ProviderName.Anthropic);
    expect(en[2]).toBe(ProviderName.Gemini);
  });

  test('idsForEnLocale puts ollama at end', () => {
    const en = ProviderRegistry.idsForEnLocale();
    expect(en[en.length - 1]).toBe(ProviderName.Ollama);
    expect(en).not.toContain(ProviderName.Custom);
  });

  test('idsForEnLocale has no duplicates', () => {
    const en = ProviderRegistry.idsForEnLocale();
    expect(new Set(en).size).toBe(en.length);
  });

  test('every definition has non-empty defaultBaseUrl', () => {
    for (const id of ProviderRegistry.providerIds) {
      const def = ProviderRegistry.get(id)!;
      expect(def.defaultBaseUrl.length).toBeGreaterThan(0);
    }
  });

  test('every definition has valid ApiFormat', () => {
    const validFormats = new Set([ApiFormat.OpenAI, ApiFormat.Anthropic, ApiFormat.Gemini]);
    for (const id of ProviderRegistry.providerIds) {
      const def = ProviderRegistry.get(id)!;
      expect(validFormats.has(def.defaultApiFormat)).toBe(true);
    }
  });

  describe('getCodingPlanUrl', () => {
    test('returns anthropic endpoint for coding-plan-supported providers', () => {
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Moonshot, 'anthropic')).toBe('https://api.kimi.com/coding');
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Qwen, 'anthropic')).toBe('https://coding.dashscope.aliyuncs.com/apps/anthropic');
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Zhipu, 'anthropic')).toBe('https://open.bigmodel.cn/api/anthropic');
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Volcengine, 'anthropic')).toBe('https://ark.cn-beijing.volces.com/api/coding');
    });

    test('returns openai endpoint for coding-plan-supported providers', () => {
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Moonshot, 'openai')).toBe('https://api.kimi.com/coding/v1');
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Qwen, 'openai')).toBe('https://coding.dashscope.aliyuncs.com/v1');
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Zhipu, 'openai')).toBe('https://open.bigmodel.cn/api/coding/paas/v4');
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Volcengine, 'openai')).toBe('https://ark.cn-beijing.volces.com/api/coding/v3');
    });

    test('returns undefined for providers that do not support codingPlan', () => {
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.OpenAI, 'openai')).toBeUndefined();
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.DeepSeek, 'anthropic')).toBeUndefined();
      expect(ProviderRegistry.getCodingPlanUrl('unknown', 'anthropic')).toBeUndefined();
    });
  });

  describe('getSwitchableBaseUrl', () => {
    test('returns anthropic url for providers with switchableBaseUrls', () => {
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.DeepSeek, 'anthropic')).toBe('https://api.deepseek.com/anthropic');
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Moonshot, 'anthropic')).toBe('https://api.moonshot.cn/anthropic');
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Zhipu, 'anthropic')).toBe('https://open.bigmodel.cn/api/anthropic');
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Minimax, 'anthropic')).toBe('https://api.minimaxi.com/anthropic');
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Qwen, 'anthropic')).toBe('https://dashscope.aliyuncs.com/apps/anthropic');
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Ollama, 'anthropic')).toBe('http://localhost:11434');
    });

    test('returns openai url for providers with switchableBaseUrls', () => {
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.DeepSeek, 'openai')).toBe('https://api.deepseek.com');
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Moonshot, 'openai')).toBe('https://api.moonshot.cn/v1');
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Zhipu, 'openai')).toBe('https://open.bigmodel.cn/api/paas/v4');
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Minimax, 'openai')).toBe('https://api.minimaxi.com/v1');
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Qwen, 'openai')).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Ollama, 'openai')).toBe('http://localhost:11434/v1');
    });

    test('returns undefined for providers without switchableBaseUrls', () => {
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.OpenAI, 'openai')).toBeUndefined();
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Anthropic, 'anthropic')).toBeUndefined();
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Gemini, 'openai')).toBeUndefined();
      expect(ProviderRegistry.getSwitchableBaseUrl('unknown', 'anthropic')).toBeUndefined();
    });
  });
});
