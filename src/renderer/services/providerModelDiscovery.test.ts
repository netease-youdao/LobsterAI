import { describe, expect, test } from 'vitest';

import {
  ApiFormat,
  ModelDiscoveryErrorCode,
  ModelDiscoveryModality,
  OpenAIApiMode,
  ProviderAuthType,
  ProviderDiscoveryProtocol,
  ProviderName,
} from '../../shared/providers';
import type { Model, ProviderConfig } from '../components/settings/modelProviderUtils';
import {
  adoptDiscoveredModel,
  buildProviderDiscoveryRequest,
  computeDefaultSelectedModelIds,
  formatModelDiscoveryError,
  isLoopbackBaseUrl,
  mergeDiscoveredModels,
  type ProviderDiscoveryAuthState,
  resolveProviderDiscoveryAvailability,
} from './providerModelDiscovery';

const defaultAuthState: ProviderDiscoveryAuthState = {
  minimaxIsOAuthMode: false,
  openaiIsOAuthMode: false,
  xaiIsOAuthMode: false,
  copilotSignedIn: false,
};

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    enabled: false,
    apiKey: '',
    baseUrl: '',
    apiFormat: ApiFormat.OpenAI,
    models: [],
    ...overrides,
  };
}

describe('isLoopbackBaseUrl', () => {
  test('recognizes localhost, 127.0.0.1, and ::1 only', () => {
    expect(isLoopbackBaseUrl('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackBaseUrl('http://127.0.0.1:8080/v1')).toBe(true);
    expect(isLoopbackBaseUrl('http://[::1]:1234/v1')).toBe(true);
    expect(isLoopbackBaseUrl('https://api.openai.com/v1')).toBe(false);
    expect(isLoopbackBaseUrl('not-a-url')).toBe(false);
  });
});

describe('resolveProviderDiscoveryAvailability', () => {
  test('blocks OpenAI and xAI OAuth modes cleanly', () => {
    expect(resolveProviderDiscoveryAvailability(
      ProviderName.OpenAI,
      makeConfig({ authType: ProviderAuthType.OAuth }),
      { ...defaultAuthState, openaiIsOAuthMode: true },
    )).toEqual({ available: false, reasonKey: 'fetchModelsUnsupportedInOAuth' });

    expect(resolveProviderDiscoveryAvailability(
      ProviderName.Xai,
      makeConfig({ authType: ProviderAuthType.OAuth }),
      { ...defaultAuthState, xaiIsOAuthMode: true },
    )).toEqual({ available: false, reasonKey: 'fetchModelsUnsupportedInOAuth' });
  });

  test('checks auth state for Copilot and MiniMax OAuth', () => {
    expect(resolveProviderDiscoveryAvailability(
      ProviderName.Copilot,
      makeConfig(),
      { ...defaultAuthState, copilotSignedIn: false },
    )).toEqual({ available: false, reasonKey: 'fetchModelsRequiresLogin' });

    expect(resolveProviderDiscoveryAvailability(
      ProviderName.Copilot,
      makeConfig({ authType: ProviderAuthType.OAuth }),
      { ...defaultAuthState, copilotSignedIn: true },
    )).toEqual({ available: true });

    expect(resolveProviderDiscoveryAvailability(
      ProviderName.Minimax,
      makeConfig({ authType: ProviderAuthType.OAuth }),
      { ...defaultAuthState, minimaxIsOAuthMode: true },
    )).toEqual({ available: false, reasonKey: 'fetchModelsRequiresLogin' });

    expect(resolveProviderDiscoveryAvailability(
      ProviderName.Minimax,
      makeConfig({ authType: ProviderAuthType.OAuth, oauthAccessToken: 'tok-mm', oauthBaseUrl: 'https://api.minimaxi.com/anthropic' }),
      { ...defaultAuthState, minimaxIsOAuthMode: true },
    )).toEqual({ available: true });
  });

  test('allows keyless discovery for Ollama, LM Studio, and loopback custom endpoints', () => {
    expect(resolveProviderDiscoveryAvailability(
      ProviderName.Ollama,
      makeConfig({ baseUrl: 'http://localhost:11434/v1' }),
      defaultAuthState,
    )).toEqual({ available: true });

    expect(resolveProviderDiscoveryAvailability(
      'custom_0',
      makeConfig({ baseUrl: 'http://127.0.0.1:8000/v1', apiKey: '' }),
      defaultAuthState,
    )).toEqual({ available: true });

    expect(resolveProviderDiscoveryAvailability(
      'custom_0',
      makeConfig({ baseUrl: 'https://relay.example.com/v1', apiKey: '' }),
      defaultAuthState,
    )).toEqual({ available: false, reasonKey: 'fetchModelsRequiresApiKey' });

    expect(resolveProviderDiscoveryAvailability(
      'custom_0',
      makeConfig({ baseUrl: '', apiKey: 'sk-123' }),
      defaultAuthState,
    )).toEqual({ available: false, reasonKey: 'fetchModelsRequiresBaseUrl' });
  });
});

describe('buildProviderDiscoveryRequest', () => {
  test('resolves coding plan URL and protocol override for built-in providers', () => {
    const { request, effectiveApiFormat } = buildProviderDiscoveryRequest({
      provider: ProviderName.Qwen,
      config: makeConfig({
        apiKey: 'sk-qwen',
        baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
        apiFormat: ApiFormat.Anthropic,
        codingPlanEnabled: true,
      }),
      authState: defaultAuthState,
    });

    expect(effectiveApiFormat).toBe('openai');
    expect(request).toEqual({
      provider: ProviderName.Qwen,
      baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
      apiProtocol: ProviderDiscoveryProtocol.OpenAICompletions,
      apiKey: 'sk-qwen',
    });
  });

  test('maps custom provider Gemini and OpenAI Responses formats accurately', () => {
    const gemini = buildProviderDiscoveryRequest({
      provider: 'custom_0',
      config: makeConfig({
        apiKey: 'AIza-key',
        baseUrl: 'https://relay.example.com/gemini',
        apiFormat: ApiFormat.Gemini,
      }),
      authState: defaultAuthState,
    });
    expect(gemini.request.apiProtocol).toBe(ProviderDiscoveryProtocol.GoogleGenerativeAI);

    const responses = buildProviderDiscoveryRequest({
      provider: 'custom_0',
      config: makeConfig({
        apiKey: 'sk-resp',
        baseUrl: 'https://relay.example.com/v1',
        apiFormat: ApiFormat.OpenAI,
        openaiApiMode: OpenAIApiMode.Responses,
      }),
      authState: defaultAuthState,
    });
    expect(responses.request.apiProtocol).toBe(ProviderDiscoveryProtocol.OpenAIResponses);
  });

  test('attaches Copilot headers and refreshed token for GitHub Copilot', () => {
    const { request } = buildProviderDiscoveryRequest({
      provider: ProviderName.Copilot,
      config: makeConfig({ authType: ProviderAuthType.OAuth }),
      authState: { ...defaultAuthState, copilotSignedIn: true },
      copilotCredential: { token: 'tid=123', baseUrl: 'https://api.individual.githubcopilot.com' },
    });

    expect(request.apiKey).toBe('tid=123');
    expect(request.headers?.['Copilot-Integration-Id']).toBe('vscode-chat');
  });
});

describe('computeDefaultSelectedModelIds', () => {
  test('auto-selects all when list is empty and candidate count is small (<= 10)', () => {
    const selected = computeDefaultSelectedModelIds([], [
      { id: 'deepseek-flash' },
      { id: 'deepseek-v4-pro' },
    ]);
    expect([...selected]).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  });

  test('starts unchecked when list is empty and candidate count exceeds 10', () => {
    const candidates = Array.from({ length: 12 }, (_, idx) => ({ id: `model-${idx}` }));
    const selected = computeDefaultSelectedModelIds([], candidates);
    expect(selected.size).toBe(0);
  });

  test('pre-selects only already-configured ids when provider already has models', () => {
    const selected = computeDefaultSelectedModelIds(
      [{ id: 'model-b' }, { id: 'manual-only' }],
      [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }],
    );
    expect([...selected]).toEqual(['model-b']);
  });
});

describe('mergeDiscoveredModels & adoptDiscoveredModel', () => {
  test('preserves manual models and tuned fields, removes unchecked listed models, and enriches newly added ones', () => {
    const existing: Model[] = [
      {
        id: 'manual-model',
        name: 'Manual Model',
        supportsImage: false,
      },
      {
        id: 'gpt-4o',
        name: 'My Custom GPT-4o Name',
        supportsImage: true,
        contextWindow: 64_000,
        customParams: { temperature: 0.2 },
      },
      {
        id: 'old-model',
        name: 'Old Model',
        supportsImage: false,
      },
    ];

    const candidates = [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128_000 },
      { id: 'old-model', name: 'Old Model' },
      {
        id: 'new-vision-model',
        name: 'New Vision',
        contextWindow: 256_000,
        maxTokens: 16_384,
        inputModalities: [ModelDiscoveryModality.Text, ModelDiscoveryModality.Image],
      },
    ];

    const merged = mergeDiscoveredModels({
      provider: 'custom_0',
      effectiveApiFormat: 'openai',
      currentModels: existing,
      candidates,
      selectedIds: new Set(['gpt-4o', 'new-vision-model']),
    });

    expect(merged).toEqual([
      existing[0], // manual-model preserved untouched
      existing[1], // gpt-4o preserved with user's custom name, contextWindow, and customParams
      {
        id: 'new-vision-model',
        name: 'New Vision',
        supportsImage: true,
        contextWindow: 256_000,
        maxTokens: 16_384,
      },
    ]);
  });

  test('enriches known built-in registry metadata and reasoning capability when adopting discovered models', () => {
    const adopted = adoptDiscoveredModel(
      ProviderName.Anthropic,
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      'anthropic',
    );
    expect(adopted).toMatchObject({
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      supportsImage: true,
      supportsThinking: true,
      contextWindow: 1_048_576,
    });

    const deepseekFlash = adoptDiscoveredModel(
      ProviderName.DeepSeek,
      {
        id: 'deepseek-flash',
        name: 'DeepSeek-V4.1-Flash',
        contextWindow: 1_048_576,
        maxTokens: 393_216,
        inputModalities: [ModelDiscoveryModality.Text, ModelDiscoveryModality.Image],
      },
      'openai',
    );
    expect(deepseekFlash).toMatchObject({
      id: 'deepseek-flash',
      name: 'DeepSeek-V4.1-Flash',
      supportsImage: true,
      supportsThinking: true,
      contextWindow: 1_048_576,
      maxTokens: 393_216,
    });

    const kimiK3WithGatewayCap = adoptDiscoveredModel(
      ProviderName.Moonshot,
      { id: 'kimi-k3', name: 'Kimi K3', maxTokens: 262_144 },
      'openai',
    );
    expect(kimiK3WithGatewayCap).toMatchObject({
      id: 'kimi-k3',
      name: 'Kimi K3',
      supportsImage: true,
      supportsVideo: true,
      supportsThinking: true,
      contextWindow: 1_048_576,
      maxTokens: 262_144,
    });
  });
});

describe('formatModelDiscoveryError', () => {
  test('maps error codes to localized templates', () => {
    const t = (key: string) => {
      const dict: Record<string, string> = {
        fetchModelsAuthError: 'Auth failed ({status})',
        fetchModelsHttpError: 'HTTP error ({status})',
        fetchModelsInvalidFormat: 'Bad format',
      };
      return dict[key] ?? key;
    };

    expect(formatModelDiscoveryError(
      {
        ok: false,
        code: ModelDiscoveryErrorCode.AuthError,
        status: 401,
        message: '401',
        detail: 'Your api key is invalid',
      },
      t,
    )).toBe('Auth failed (401) (Your api key is invalid)');

    expect(formatModelDiscoveryError(
      { ok: false, code: ModelDiscoveryErrorCode.HttpError, status: 502, message: '502' },
      t,
    )).toBe('HTTP error (502)');

    expect(formatModelDiscoveryError(
      { ok: false, code: ModelDiscoveryErrorCode.InvalidFormat, message: 'bad' },
      t,
    )).toBe('Bad format');
  });
});
