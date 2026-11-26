// Pure engine-independent provider selection helper mapping LobsterAI's
// resolved API config onto a wire transport (`openai-completions`,
// `openai-responses`, `anthropic-messages`, `google-generative-ai`) and baseURL.

import {
  canonicalizeDshProviderId,
  OpenAIApiMode,
  OpenClawApi,
  ProviderName,
} from '../../shared/providers';

export const PROXY_TOKEN_PLACEHOLDER = '${LOBSTER_PROXY_TOKEN}';

const PROXY_BACKED_PROVIDER_PATHS: Readonly<Record<string, string>> = {
  [ProviderName.LobsteraiServer]: `/v1/${ProviderName.LobsteraiServer}`,
  [ProviderName.Copilot]: `/v1/${ProviderName.Copilot}`,
};

/**
 * Strip the `/chat/completions` endpoint suffix from a base URL so callers can
 * append `/chat/completions` without duplicating the path segment.
 */
export function stripChatCompletionsSuffix(rawBaseUrl: string): string {
  const normalized = rawBaseUrl.trim().replace(/\/+$/, '');
  if (!normalized) return normalized;
  return normalized.replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
}

/**
 * Strip the `/responses` endpoint suffix from a base URL so Responses-mode
 * callers can append `/responses` without duplicating the path segment.
 */
export function stripResponsesSuffix(rawBaseUrl: string): string {
  const normalized = rawBaseUrl.trim().replace(/\/+$/, '');
  if (!normalized) return normalized;
  return normalized.replace(/\/responses$/i, '').replace(/\/+$/, '');
}

/**
 * Strip trailing OpenAI endpoint suffixes (`/chat/completions`, `/responses`)
 * from a configured base URL so SDKs never double-append the endpoint path.
 */
export function stripOpenAIEndpointSuffix(rawBaseUrl: string): string {
  const normalized = rawBaseUrl.trim().replace(/\/+$/, '');
  if (!normalized) return normalized;
  return normalized.replace(/\/(chat\/completions|responses)$/i, '').replace(/\/+$/, '');
}

function normalizeProxyOrigin(proxyBaseUrl: string | null | undefined): string | null {
  const trimmed = (proxyBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    return null;
  }
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -'/v1'.length) : trimmed;
}

/**
 * Rewrite a proxy-backed provider (`lobsterai-server`, `github-copilot`) to its
 * provider-scoped route on the local model auth proxy (`<origin>/v1/<provider>`).
 */
export function resolveProxyBackedBaseUrl(
  providerName: string,
  proxyBaseUrl?: string | null,
): string | null {
  const canonical = canonicalizeDshProviderId(providerName);
  const scopedPath = PROXY_BACKED_PROVIDER_PATHS[canonical];
  if (!scopedPath) {
    return null;
  }
  const origin = normalizeProxyOrigin(proxyBaseUrl);
  return origin ? `${origin}${scopedPath}` : null;
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
  /** Local model auth proxy origin (e.g. `http://127.0.0.1:<port>`). */
  proxyBaseUrl?: string | null;
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

  const usesProxyPlaceholder =
    providerName === ProviderName.LobsteraiServer
    || providerName === ProviderName.Copilot;
  const isExternalOAuth =
    options.authType === 'oauth' && !usesProxyPlaceholder;

  const apiKey = isExternalOAuth
    ? undefined
    : usesProxyPlaceholder
      ? PROXY_TOKEN_PLACEHOLDER
      : options.apiKey;

  let baseUrl = stripChatCompletionsSuffix(options.baseURL || '');
  if (api === OpenClawApi.OpenAIResponses) {
    baseUrl = stripResponsesSuffix(baseUrl);
  }
  if (apiKey === PROXY_TOKEN_PLACEHOLDER) {
    const rewrittenProxyBaseUrl = resolveProxyBackedBaseUrl(providerName, options.proxyBaseUrl);
    if (rewrittenProxyBaseUrl) {
      baseUrl = rewrittenProxyBaseUrl;
    }
  }

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
