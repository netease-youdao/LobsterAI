import { expect, test } from 'vitest';

import { OpenClawProviderId, ProviderAuthType, ProviderName } from '../../../shared/providers';
import {
  buildOpenAIConnectionTestRequestBody,
  getOpenClawProviderIdForConfig,
  hasEquivalentProviderModelId,
  hasProviderAuthConfigured,
  MAX_OUTPUT_TOKENS_MAX,
  MAX_OUTPUT_TOKENS_MIN,
  parseMaxOutputTokensInput,
  type ProviderConfig,
  providerRequiresApiKey,
  shouldShowApiFormatSelector,
} from './modelProviderUtils';

const providerConfig = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  enabled: true,
  apiKey: '',
  baseUrl: 'https://api.example.com',
  models: [],
  ...overrides,
});

test('GitHub Copilot does not require a persisted API key', () => {
  expect(providerRequiresApiKey(ProviderName.Copilot)).toBe(false);
});

test('GitHub Copilot OAuth auth is tracked by authType instead of apiKey', () => {
  expect(hasProviderAuthConfigured(
    ProviderName.Copilot,
    providerConfig({ authType: ProviderAuthType.OAuth }),
  )).toBe(true);

  expect(hasProviderAuthConfigured(
    ProviderName.Copilot,
    providerConfig({ apiKey: 'legacy-short-token' }),
  )).toBe(false);
});

test('MiniMax OAuth resolves to the OpenClaw portal provider', () => {
  expect(getOpenClawProviderIdForConfig(
    ProviderName.Minimax,
    providerConfig({ authType: ProviderAuthType.OAuth }),
  )).toBe(OpenClawProviderId.MinimaxPortal);

  expect(getOpenClawProviderIdForConfig(
    ProviderName.Minimax,
    providerConfig({ authType: ProviderAuthType.ApiKey }),
  )).toBe(OpenClawProviderId.Minimax);
});

test('OpenAI OAuth models use the canonical OpenClaw OpenAI provider id', () => {
  expect(getOpenClawProviderIdForConfig(
    ProviderName.OpenAI,
    providerConfig({ authType: ProviderAuthType.OAuth }),
  )).toBe(OpenClawProviderId.OpenAI);
});

test('provider model identity comparison ignores K3 punctuation and casing', () => {
  expect(hasEquivalentProviderModelId(
    [{ id: 'kimi-k3' }],
    ' Kimi_K3 ',
  )).toBe(true);
});

test('provider model identity comparison excludes the model currently being edited', () => {
  expect(hasEquivalentProviderModelId(
    [{ id: 'Kimi_K3' }],
    'kimi.k3',
    'Kimi_K3',
  )).toBe(false);

  expect(hasEquivalentProviderModelId(
    [{ id: 'Kimi_K3' }, { id: 'kimi.k3' }],
    'kimi-k3',
    'Kimi_K3',
  )).toBe(true);
});

test('provider model identity comparison preserves distinct non-K3 punctuation', () => {
  expect(hasEquivalentProviderModelId(
    [{ id: 'foo/bar' }, { id: 'model.v1' }],
    'foo-bar',
  )).toBe(false);
  expect(hasEquivalentProviderModelId(
    [{ id: 'foo/bar' }, { id: 'model.v1' }],
    'model-v1',
  )).toBe(false);
});

test('legacy Moonshot Anthropic configs stay visible and use their real transport', () => {
  expect(shouldShowApiFormatSelector(ProviderName.Moonshot, 'anthropic')).toBe(true);
  expect(shouldShowApiFormatSelector(ProviderName.Moonshot, 'openai')).toBe(false);
});

test('official Moonshot K3 connection test uses the K3 request contract', () => {
  expect(buildOpenAIConnectionTestRequestBody({
    provider: ProviderName.Moonshot,
    model: { id: 'kimi-k3' },
    useResponsesApi: false,
  })).toEqual({
    model: 'kimi-k3',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 64,
    reasoning_effort: 'max',
  });
});

test('exact custom K3 model ID uses the K3 request contract', () => {
  expect(buildOpenAIConnectionTestRequestBody({
    provider: 'custom_0',
    model: { id: 'kimi-k3' },
    useResponsesApi: false,
  })).toMatchObject({
    model: 'kimi-k3',
    max_tokens: 64,
    reasoning_effort: 'max',
  });
});

test('ordinary OpenAI-compatible connection tests retain their existing token field', () => {
  expect(buildOpenAIConnectionTestRequestBody({
    provider: 'custom_0',
    model: { id: 'ordinary-model' },
    useResponsesApi: false,
  })).toEqual({
    model: 'ordinary-model',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 64,
  });
});

test('an empty max output tokens field means automatic inference', () => {
  expect(parseMaxOutputTokensInput('')).toBeUndefined();
  expect(parseMaxOutputTokensInput('   ')).toBeUndefined();
});

test('max output tokens accepts whole numbers with digit separators', () => {
  expect(parseMaxOutputTokensInput('65536')).toBe(65_536);
  expect(parseMaxOutputTokensInput(' 65,536 ')).toBe(65_536);
  expect(parseMaxOutputTokensInput('131_072')).toBe(131_072);
  expect(parseMaxOutputTokensInput(String(MAX_OUTPUT_TOKENS_MIN))).toBe(MAX_OUTPUT_TOKENS_MIN);
  expect(parseMaxOutputTokensInput(String(MAX_OUTPUT_TOKENS_MAX))).toBe(MAX_OUTPUT_TOKENS_MAX);
});

test('max output tokens rejects ambiguous or out-of-range input', () => {
  for (const input of ['64k', '1.5', '-1', 'auto', String(MAX_OUTPUT_TOKENS_MIN - 1), String(MAX_OUTPUT_TOKENS_MAX + 1)]) {
    expect(parseMaxOutputTokensInput(input), input).toBeNull();
  }
});
