// Pure engine-independent provider selection helper mapping LobsterAI's
// resolved API config onto a wire transport (`openai-completions`,
// `openai-responses`, `anthropic-messages`, `google-generative-ai`) and baseURL.

import {
  canonicalizeDshProviderId,
  OpenAIApiMode,
  OpenClawApi,
  ProviderName,
} from '../../shared/providers';

/**
 * Strip trailing OpenAI endpoint suffixes (`/chat/completions`, `/responses`)
 * from a configured base URL so SDKs never double-append the endpoint path.
 */
export function stripOpenAIEndpointSuffix(rawBaseUrl: string): string {
  const normalized = rawBaseUrl.trim().replace(/\/+$/, '');
  if (!normalized) return normalized;
  return normalized.replace(/\/(chat\/completions|responses)$/i, '').replace(/\/+$/, '');
}

export interface ProviderSelectionInput {
  apiKey: string;
  baseURL: string;
  modelId: string;
  apiType: 'anthropic' | 'openai' | undefined;
  openaiApiMode?: OpenAIApiMode;
  geminiNative?: boolean;
  providerName?: string;
  authType?: 'apikey' | 'oauth';
  codingPlanEnabled?: boolean;
  supportsImage?: boolean;
  supportsVideo?: boolean;
  supportsThinking?: boolean;
  modelName?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProviderSelectionResult {
  providerId: string;
  primaryModel: string;
  sessionModelId: string;
  providerConfig: {
    baseUrl: string;
    api: string;
    apiKey?: string;
    auth: string;
    models: Array<{ id: string; name: string; api: string; input: string[] }>;
  };
}

export function buildProviderSelection(
  options: ProviderSelectionInput,
): ProviderSelectionResult {
  const providerName = canonicalizeDshProviderId(options.providerName ?? '');
  let api: string = OpenClawApi.OpenAICompletions;
  if (options.geminiNative === true || providerName === ProviderName.Gemini) {
    api = OpenClawApi.GoogleGenerativeAI;
  } else if (options.apiType === 'anthropic' || providerName === ProviderName.Anthropic) {
    api = OpenClawApi.AnthropicMessages;
  } else if (
    options.openaiApiMode === OpenAIApiMode.Responses
    || (providerName === ProviderName.OpenAI && options.authType === 'oauth')
  ) {
    api = OpenClawApi.OpenAIResponses;
  }

  const rawBaseUrl = (options.baseURL || '').trim().replace(/\/+$/, '');
  const baseUrl =
    api === OpenClawApi.OpenAICompletions || api === OpenClawApi.OpenAIResponses
      ? stripOpenAIEndpointSuffix(rawBaseUrl)
      : rawBaseUrl;
  const usesProxyPlaceholder =
    providerName === ProviderName.LobsteraiServer
    || providerName === ProviderName.Copilot;
  const isExternalOAuth =
    options.authType === 'oauth' && !usesProxyPlaceholder;

  const apiKey = isExternalOAuth
    ? undefined
    : usesProxyPlaceholder
      ? '${LOBSTER_PROXY_TOKEN}'
      : options.apiKey;

  const sessionModelId = options.modelId.trim();
  const providerId = providerName || 'custom';
  return {
    providerId,
    primaryModel: `${providerId}/${sessionModelId}`,
    sessionModelId,
    providerConfig: {
      baseUrl,
      api,
      ...(apiKey !== undefined ? { apiKey } : {}),
      auth: isExternalOAuth ? 'oauth' : 'api-key',
      models: [
        {
          id: sessionModelId,
          name: options.modelName?.trim() || sessionModelId,
          api,
          input: options.supportsImage ? ['text', 'image'] : ['text'],
        },
      ],
    },
  };
}
