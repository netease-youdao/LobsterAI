import { describe, expect, test } from 'vitest';

import { ApiFormat, OpenAIApiMode, ProviderAuthType, ProviderName } from './constants';
import {
  getDefaultOpenAIApiMode,
  isOpenAIApiModeAvailable,
  normalizeOpenAIApiMode,
  resolveProviderOpenAIApiMode,
  supportsOpenAIApiModeSelection,
} from './openaiApiMode';

describe('OpenAI API mode', () => {
  test('is selectable for custom providers and built-in OpenAI only', () => {
    for (const provider of ['custom_0', 'custom_12', ProviderName.OpenAI]) {
      expect(supportsOpenAIApiModeSelection(provider)).toBe(true);
    }
    for (const provider of [
      ProviderName.Custom,
      ProviderName.OpenRouter,
      ProviderName.Volcengine,
      ProviderName.Minimax,
      ProviderName.LmStudio,
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
    expect(isOpenAIApiModeAvailable(ProviderName.OpenAI, { authType: ProviderAuthType.ApiKey })).toBe(true);
    expect(isOpenAIApiModeAvailable(ProviderName.OpenAI, { authType: ProviderAuthType.OAuth })).toBe(false);
    expect(isOpenAIApiModeAvailable(ProviderName.Volcengine, {})).toBe(false);
  });

  test('defaults built-in OpenAI to Responses and custom providers to Chat Completions', () => {
    expect(getDefaultOpenAIApiMode(ProviderName.OpenAI)).toBe(OpenAIApiMode.Responses);
    expect(getDefaultOpenAIApiMode('custom_0')).toBe(OpenAIApiMode.ChatCompletions);
    expect(normalizeOpenAIApiMode(OpenAIApiMode.Responses)).toBe(OpenAIApiMode.Responses);
    expect(normalizeOpenAIApiMode(OpenAIApiMode.ChatCompletions, OpenAIApiMode.Responses))
      .toBe(OpenAIApiMode.ChatCompletions);
    expect(normalizeOpenAIApiMode(undefined)).toBe(OpenAIApiMode.ChatCompletions);
    expect(normalizeOpenAIApiMode(undefined, OpenAIApiMode.Responses)).toBe(OpenAIApiMode.Responses);
    expect(normalizeOpenAIApiMode('websocket')).toBe(OpenAIApiMode.ChatCompletions);
  });

  test('resolves only for OpenAI-compatible providers where the choice applies', () => {
    const responses = { apiFormat: ApiFormat.OpenAI, openaiApiMode: OpenAIApiMode.Responses };
    const chatCompletions = { apiFormat: ApiFormat.OpenAI, openaiApiMode: OpenAIApiMode.ChatCompletions };
    expect(resolveProviderOpenAIApiMode('custom_0', responses)).toBe(OpenAIApiMode.Responses);
    expect(resolveProviderOpenAIApiMode(ProviderName.OpenAI, { apiFormat: ApiFormat.OpenAI }))
      .toBe(OpenAIApiMode.Responses);
    expect(resolveProviderOpenAIApiMode(ProviderName.OpenAI, chatCompletions))
      .toBe(OpenAIApiMode.ChatCompletions);
    expect(resolveProviderOpenAIApiMode(ProviderName.OpenAI, { ...chatCompletions, authType: ProviderAuthType.OAuth }))
      .toBeUndefined();
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
