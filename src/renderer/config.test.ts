import { ApiFormat, ProviderName } from '@shared/providers';
import { expect, test } from 'vitest';

import {
  defaultConfig,
  getCustomProviderDefaultName,
  getProviderDisplayName,
  isCustomProvider,
  ShortcutAction,
} from './config';

test('isCustomProvider: custom_0 is custom', () => {
  expect(isCustomProvider('custom_0')).toBe(true);
});

test('isCustomProvider: custom_1 is custom', () => {
  expect(isCustomProvider('custom_1')).toBe(true);
});

test('isCustomProvider: custom_99 is custom', () => {
  expect(isCustomProvider('custom_99')).toBe(true);
});

test('isCustomProvider: openai is not custom', () => {
  expect(isCustomProvider('openai')).toBe(false);
});

test('isCustomProvider: deepseek is not custom', () => {
  expect(isCustomProvider('deepseek')).toBe(false);
});

test('isCustomProvider: empty string is not custom', () => {
  expect(isCustomProvider('')).toBe(false);
});

test('isCustomProvider: "custom" without underscore is not custom', () => {
  expect(isCustomProvider('custom')).toBe(false);
});

test('getCustomProviderDefaultName: custom_0 -> Custom0', () => {
  expect(getCustomProviderDefaultName('custom_0')).toBe('Custom0');
});

test('getCustomProviderDefaultName: custom_1 -> Custom1', () => {
  expect(getCustomProviderDefaultName('custom_1')).toBe('Custom1');
});

test('getCustomProviderDefaultName: custom_42 -> Custom42', () => {
  expect(getCustomProviderDefaultName('custom_42')).toBe('Custom42');
});

test('getProviderDisplayName: built-in provider capitalizes first letter', () => {
  expect(getProviderDisplayName('openai')).toBe('OpenAI');
});

test('getProviderDisplayName: built-in provider with no config', () => {
  expect(getProviderDisplayName('deepseek')).toBe('DeepSeek');
});

test('getProviderDisplayName: custom provider without config uses default name', () => {
  expect(getProviderDisplayName('custom_0')).toBe('Custom0');
});

test('getProviderDisplayName: custom provider with empty displayName uses default', () => {
  expect(getProviderDisplayName('custom_0', { displayName: '' })).toBe('Custom0');
});

test('getProviderDisplayName: custom provider with displayName uses it', () => {
  expect(getProviderDisplayName('custom_0', { displayName: 'My GPT' })).toBe('My GPT');
});

test('getProviderDisplayName: custom provider with undefined displayName uses default', () => {
  expect(getProviderDisplayName('custom_2', { displayName: undefined })).toBe('Custom2');
});

test('defaultConfig uses OpenAI-compatible DeepSeek defaults', () => {
  expect(defaultConfig.api.baseUrl).toBe('https://api.deepseek.com');
  expect(defaultConfig.providers?.[ProviderName.DeepSeek]?.apiFormat).toBe(ApiFormat.OpenAI);
  expect(defaultConfig.providers?.[ProviderName.Xiaomi]?.apiFormat).toBe(ApiFormat.OpenAI);
});

test('defaultConfig enables usage analytics by default', () => {
  expect(defaultConfig.usageAnalyticsEnabled).toBe(true);
});

test('defaultConfig gives DeepSeek V4 models 1M context', () => {
  expect(defaultConfig.providers?.[ProviderName.DeepSeek]?.models?.slice(0, 2)).toEqual([
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, supportsThinking: true, contextWindow: 1_000_000 },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsImage: false, supportsThinking: true, contextWindow: 1_000_000 },
  ]);
});

test('defaultConfig limits Xiaomi models to V2.5 with 1M context', () => {
  expect(defaultConfig.providers?.[ProviderName.Xiaomi]?.models).toEqual([
    { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', supportsImage: false, supportsThinking: true, contextWindow: 1_000_000 },
    { id: 'mimo-v2.5', name: 'MiMo V2.5', supportsImage: true, supportsThinking: true, contextWindow: 1_000_000 },
  ]);
});

test('defaultConfig puts MiniMax M3 first with 1M context', () => {
  expect(defaultConfig.providers?.[ProviderName.Minimax]?.models?.[0]).toMatchObject({
    id: 'MiniMax-M3',
    name: 'MiniMax M3',
    contextWindow: 1_000_000,
  });
});

test('defaultConfig leaves agent shortcuts unset', () => {
  expect(defaultConfig.shortcuts?.[ShortcutAction.PreviousAgent]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.NextAgent]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.ShowCurrentAgentTasks]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.OpenAgentTask1]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.OpenAgentTask2]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.OpenAgentTask3]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.OpenAgentTask4]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.OpenAgentTask5]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.OpenAgentTask6]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.OpenAgentTask7]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.OpenAgentTask8]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.OpenAgentTask9]).toBe('');
});
