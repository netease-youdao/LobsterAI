import { describe, expect, test, vi } from 'vitest';

import {
  ModelDiscoveryErrorCode,
  ModelDiscoveryModality,
  ProviderDiscoveryProtocol,
  ProviderName,
} from '../../shared/providers';
import {
  buildModelDiscoveryUrls,
  discoverProviderModels,
  MAX_MODEL_DISCOVERY_RESPONSE_BYTES,
  normalizeDiscoveryApiKey,
  parseGeminiListing,
  parseOpenAIOrAnthropicListing,
} from './providerModelDiscovery';

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

describe('buildModelDiscoveryUrls', () => {
  test('builds OpenAI URLs, strips chat/completions or responses suffixes, and adds /v1 fallback when unversioned', () => {
    expect(buildModelDiscoveryUrls(
      'https://api.openai.com/v1',
      ProviderDiscoveryProtocol.OpenAICompletions,
    )).toEqual(['https://api.openai.com/v1/models']);

    expect(buildModelDiscoveryUrls(
      'https://api.deepseek.com',
      ProviderDiscoveryProtocol.OpenAICompletions,
    )).toEqual([
      'https://api.deepseek.com/models',
      'https://api.deepseek.com/v1/models',
    ]);

    expect(buildModelDiscoveryUrls(
      'https://api.xiaomimimo.com/v1/chat/completions',
      ProviderDiscoveryProtocol.OpenAICompletions,
    )).toEqual(['https://api.xiaomimimo.com/v1/models']);

    expect(buildModelDiscoveryUrls(
      'https://gateway.example.com/openai/v1/responses',
      ProviderDiscoveryProtocol.OpenAIResponses,
    )).toEqual(['https://gateway.example.com/openai/v1/models']);

    expect(buildModelDiscoveryUrls(
      'https://open.bigmodel.cn/api/paas/v4',
      ProviderDiscoveryProtocol.OpenAICompletions,
    )).toEqual(['https://open.bigmodel.cn/api/paas/v4/models']);
  });

  test('builds Anthropic URLs without duplicating /v1 or /messages', () => {
    expect(buildModelDiscoveryUrls(
      'https://api.anthropic.com',
      ProviderDiscoveryProtocol.AnthropicMessages,
    )).toEqual(['https://api.anthropic.com/v1/models?limit=1000']);

    expect(buildModelDiscoveryUrls(
      'https://api.anthropic.com/v1',
      ProviderDiscoveryProtocol.AnthropicMessages,
    )).toEqual(['https://api.anthropic.com/v1/models?limit=1000']);

    expect(buildModelDiscoveryUrls(
      'https://dashscope.aliyuncs.com/apps/anthropic/v1/messages',
      ProviderDiscoveryProtocol.AnthropicMessages,
    )).toEqual(['https://dashscope.aliyuncs.com/apps/anthropic/v1/models?limit=1000']);
  });

  test('builds Gemini URLs using normalized versioned root', () => {
    expect(buildModelDiscoveryUrls(
      'https://generativelanguage.googleapis.com',
      ProviderDiscoveryProtocol.GoogleGenerativeAI,
    )).toEqual(['https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000']);

    expect(buildModelDiscoveryUrls(
      'https://relay.example.com/gemini/v1beta/openai',
      ProviderDiscoveryProtocol.GoogleGenerativeAI,
    )).toEqual(['https://relay.example.com/gemini/v1beta/models?pageSize=1000']);
  });

  test('appends Ollama /api/tags fallback for ollama provider', () => {
    expect(buildModelDiscoveryUrls(
      'http://localhost:11434/v1',
      ProviderDiscoveryProtocol.OpenAICompletions,
      ProviderName.Ollama,
    )).toEqual([
      'http://localhost:11434/v1/models',
      'http://localhost:11434/api/tags',
    ]);
  });
});

describe('normalizeDiscoveryApiKey', () => {
  test('trims valid keys and treats empty strings as unauthenticated', () => {
    expect(normalizeDiscoveryApiKey('  sk-test-123  ')).toBe('sk-test-123');
    expect(normalizeDiscoveryApiKey('   ')).toBeUndefined();
    expect(normalizeDiscoveryApiKey(undefined)).toBeUndefined();
  });

  test('rejects keys with non-ASCII or whitespace characters', () => {
    expect(() => normalizeDiscoveryApiKey('sk-非法字符')).toThrow();
    expect(() => normalizeDiscoveryApiKey('sk-with space')).toThrow();
  });
});

describe('listing parsers', () => {
  test('parses standard OpenAI/Anthropic data array with enriched capacity and modality fields', () => {
    const models = parseOpenAIOrAnthropicListing({
      data: [
        {
          id: 'deepseek-v4-pro',
          display_name: 'DeepSeek V4 Pro',
          context_window: 1_000_000,
          max_output_tokens: 65_536,
          architecture: { input_modalities: ['text', 'image'] },
          supported_parameters: ['temperature', 'reasoning'],
        },
        {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: {
            limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_384 },
            supports: { vision: true },
          },
        },
        { id: '' },
      ],
    });

    expect(models).toEqual([
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        contextWindow: 1_000_000,
        maxTokens: 65_536,
        inputModalities: [ModelDiscoveryModality.Text, ModelDiscoveryModality.Image],
        reasoning: true,
      },
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        contextWindow: 128_000,
        maxTokens: 16_384,
        inputModalities: [ModelDiscoveryModality.Text, ModelDiscoveryModality.Image],
      },
    ]);
  });

  test('parses enriched gateway models dictionary using property key as canonical id', () => {
    const models = parseOpenAIOrAnthropicListing({
      models: {
        'alias/claude-4': {
          id: 'upstream-id-ignored-when-key-present',
          displayName: 'Claude 4 Alias',
          limit: { context: 200_000, output: 16_384 },
        },
        metadataVersion: '1.0',
      },
    });

    expect(models).toEqual([
      {
        id: 'alias/claude-4',
        name: 'Claude 4 Alias',
        contextWindow: 200_000,
        maxTokens: 16_384,
      },
    ]);
  });

  test('parses Ollama /api/tags array under models', () => {
    const models = parseOpenAIOrAnthropicListing({
      models: [
        { name: 'qwen3:8b', model: 'qwen3:8b' },
        { name: 'llama3.3:latest', model: 'llama3.3:latest' },
      ],
    });
    expect(models).toEqual([
      { id: 'qwen3:8b', name: 'qwen3:8b' },
      { id: 'llama3.3:latest', name: 'llama3.3:latest' },
    ]);
  });

  test('parses Gemini listing, filtering non-generateContent models and stripping models/ prefix', () => {
    const models = parseGeminiListing({
      models: [
        {
          name: 'models/gemini-2.5-pro',
          displayName: 'Gemini 2.5 Pro',
          inputTokenLimit: 1_048_576,
          outputTokenLimit: 65_536,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
        },
        {
          name: 'models/text-embedding-004',
          displayName: 'Embedding',
          supportedGenerationMethods: ['embedContent'],
        },
      ],
    });

    expect(models).toEqual([
      {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        contextWindow: 1_048_576,
        maxTokens: 65_536,
      },
    ]);
  });
});

describe('discoverProviderModels', () => {
  test('sends Bearer auth for OpenAI and deduplicates returned model ids', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: [
        { id: 'deepseek-flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        { id: 'deepseek-flash' },
      ],
    }));

    const result = await discoverProviderModels(
      {
        baseUrl: 'https://api.deepseek.com',
        apiProtocol: ProviderDiscoveryProtocol.OpenAICompletions,
        apiKey: 'sk-deepseek-key',
      },
      { fetch: fetchMock },
    );

    expect(result).toEqual({
      ok: true,
      models: [
        { id: 'deepseek-flash', name: 'deepseek-flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/models');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-deepseek-key');
    expect(init?.credentials).toBe('omit');
  });

  test('falls back to /v1/models when unversioned OpenAI baseUrl returns 404', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/models')) {
        return jsonResponse({ data: [{ id: 'qwen-max' }] });
      }
      return new Response('not found', { status: 404 });
    });

    const result = await discoverProviderModels(
      {
        baseUrl: 'https://api.siliconflow.cn',
        apiProtocol: ProviderDiscoveryProtocol.OpenAICompletions,
        apiKey: 'sk-sf',
      },
      { fetch: fetchMock },
    );

    expect(result).toEqual({
      ok: true,
      models: [{ id: 'qwen-max', name: 'qwen-max' }],
    });
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual([
      'https://api.siliconflow.cn/models',
      'https://api.siliconflow.cn/v1/models',
    ]);
  });

  test('sends Anthropic headers for anthropic-messages protocol', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: [{ id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' }],
    }));

    const result = await discoverProviderModels(
      {
        baseUrl: 'https://api.anthropic.com',
        apiProtocol: ProviderDiscoveryProtocol.AnthropicMessages,
        apiKey: 'sk-ant-123',
      },
      { fetch: fetchMock },
    );

    expect(result).toEqual({
      ok: true,
      models: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-123');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  test('sends x-goog-api-key for Gemini protocol', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      models: [
        {
          name: 'models/gemini-3-flash-preview',
          displayName: 'Gemini 3 Flash',
          inputTokenLimit: 1_000_000,
          outputTokenLimit: 65_536,
          supportedGenerationMethods: ['generateContent'],
        },
      ],
    }));

    const result = await discoverProviderModels(
      {
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiProtocol: ProviderDiscoveryProtocol.GoogleGenerativeAI,
        apiKey: 'AIza-test',
      },
      { fetch: fetchMock },
    );

    expect(result).toEqual({
      ok: true,
      models: [
        {
          id: 'gemini-3-flash-preview',
          name: 'Gemini 3 Flash',
          contextWindow: 1_000_000,
          maxTokens: 65_536,
        },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-test');
  });

  test('passes non-reserved extra headers (e.g. Copilot) while protecting auth headers', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: [{ id: 'gpt-4.1' }],
    }));

    await discoverProviderModels(
      {
        provider: ProviderName.Copilot,
        baseUrl: 'https://api.individual.githubcopilot.com',
        apiProtocol: ProviderDiscoveryProtocol.OpenAICompletions,
        apiKey: 'copilot-token',
        headers: {
          'Copilot-Integration-Id': 'vscode-chat',
          Authorization: 'Bearer spoofed',
        },
      },
      { fetch: fetchMock },
    );

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['Copilot-Integration-Id']).toBe('vscode-chat');
    expect(headers.Authorization).toBe('Bearer copilot-token');
  });

  test('reports auth, invalid-key, oversized, invalid-json, and invalid-format errors cleanly', async () => {
    const authRes = await discoverProviderModels(
      {
        baseUrl: 'https://api.openai.com/v1',
        apiProtocol: ProviderDiscoveryProtocol.OpenAICompletions,
        apiKey: 'sk-bad',
      },
      {
        fetch: async () => new Response(
          JSON.stringify({ error: { message: 'Authentication Fails, Your api key: ****bad is invalid' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      },
    );
    expect(authRes).toMatchObject({
      ok: false,
      code: ModelDiscoveryErrorCode.AuthError,
      status: 401,
      detail: 'Authentication Fails, Your api key: ****bad is invalid',
    });

    const keyRes = await discoverProviderModels(
      {
        baseUrl: 'https://api.openai.com/v1',
        apiProtocol: ProviderDiscoveryProtocol.OpenAICompletions,
        apiKey: 'sk-中文',
      },
      { fetch: vi.fn() },
    );
    expect(keyRes).toMatchObject({ ok: false, code: ModelDiscoveryErrorCode.InvalidApiKey });

    const oversizedRes = await discoverProviderModels(
      {
        baseUrl: 'https://api.openai.com/v1',
        apiProtocol: ProviderDiscoveryProtocol.OpenAICompletions,
      },
      {
        fetch: async () => new Response('x', {
          status: 200,
          headers: { 'content-length': String(MAX_MODEL_DISCOVERY_RESPONSE_BYTES + 1) },
        }),
      },
    );
    expect(oversizedRes).toMatchObject({ ok: false, code: ModelDiscoveryErrorCode.ResponseTooLarge });

    const nonJsonRes = await discoverProviderModels(
      {
        baseUrl: 'https://api.openai.com/v1',
        apiProtocol: ProviderDiscoveryProtocol.OpenAICompletions,
      },
      { fetch: async () => new Response('<html>404</html>', { status: 200 }) },
    );
    expect(nonJsonRes).toMatchObject({ ok: false, code: ModelDiscoveryErrorCode.InvalidJson });

    const badFormatRes = await discoverProviderModels(
      {
        baseUrl: 'https://api.openai.com/v1',
        apiProtocol: ProviderDiscoveryProtocol.OpenAICompletions,
      },
      { fetch: async () => jsonResponse({ items: [] }) },
    );
    expect(badFormatRes).toMatchObject({ ok: false, code: ModelDiscoveryErrorCode.InvalidFormat });
  });
});
