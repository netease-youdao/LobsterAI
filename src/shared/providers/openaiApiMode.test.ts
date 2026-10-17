import { describe, expect, test } from 'vitest';

import { ApiFormat, OpenAIApiMode, ProviderAuthType, ProviderName } from './constants';
import {
  isOpenAIApiModeAvailable,
  normalizeOpenAIApiMode,
  resolveProviderOpenAIApiMode,
  supportsOpenAIApiModeSelection,
} from './openaiApiMode';

describe('OpenAI API mode', () => {
  test('is selectable only for custom providers', () => {
    for (const provider of ['custom_0', 'custom_12']) {
      expect(supportsOpenAIApiModeSelection(provider)).toBe(true);
    }
    for (const provider of [
      ProviderName.Custom,
      ProviderName.OpenRouter,
      ProviderName.Volcengine,
      ProviderName.Minimax,
      ProviderName.LmStudio,
      ProviderName.OpenAI,
      ProviderName.DeepSeek,
      ProviderName.Xiaomi,
      ProviderName.Qwen,
      ProviderName.Moonshot,
      ProviderName.Zhipu,
      ProviderName.Qianfan,
      ProviderName.StepFun,
      ProviderName.Ollama,
      ProviderName.Copilot,
    ]) {
      expect(supportsOpenAIApiModeSelection(provider)).toBe(false);
    }
  });

  test('is unavailable on coding plan and OAuth routes', () => {
    expect(isOpenAIApiModeAvailable('custom_0', {})).toBe(true);
    expect(isOpenAIApiModeAvailable('custom_0', { codingPlanEnabled: true })).toBe(false);
    expect(isOpenAIApiModeAvailable('custom_0', { authType: ProviderAuthType.OAuth })).toBe(false);
    expect(isOpenAIApiModeAvailable('custom_0', { authType: ProviderAuthType.ApiKey })).toBe(true);
    expect(isOpenAIApiModeAvailable(ProviderName.Volcengine, {})).toBe(false);
  });

  test('normalizes unknown values to Chat Completions', () => {
    expect(normalizeOpenAIApiMode(OpenAIApiMode.Responses)).toBe(OpenAIApiMode.Responses);
    expect(normalizeOpenAIApiMode(undefined)).toBe(OpenAIApiMode.ChatCompletions);
    expect(normalizeOpenAIApiMode('websocket')).toBe(OpenAIApiMode.ChatCompletions);
  });

  test('resolves only for OpenAI-compatible providers where the choice applies', () => {
    const responses = { apiFormat: ApiFormat.OpenAI, openaiApiMode: OpenAIApiMode.Responses };
    expect(resolveProviderOpenAIApiMode('custom_0', responses)).toBe(OpenAIApiMode.Responses);
    expect(resolveProviderOpenAIApiMode(ProviderName.OpenRouter, responses)).toBeUndefined();
    expect(resolveProviderOpenAIApiMode('custom_0', { apiFormat: ApiFormat.OpenAI }))
      .toBe(OpenAIApiMode.ChatCompletions);
    expect(resolveProviderOpenAIApiMode('custom_0', { ...responses, apiFormat: ApiFormat.Anthropic }))
      .toBeUndefined();
    expect(resolveProviderOpenAIApiMode(ProviderName.DeepSeek, responses)).toBeUndefined();
    expect(resolveProviderOpenAIApiMode('custom_0', { ...responses, codingPlanEnabled: true }))
      .toBeUndefined();
    expect(resolveProviderOpenAIApiMode('custom_0', undefined)).toBeUndefined();
  });
});
