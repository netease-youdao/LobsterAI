import { OpenClawApi, ProviderName } from '../../shared/providers';
import { resolveRawApiConfig } from './claudeSettings';
import { buildAnthropicMessagesUrl } from './coworkModelApi';
import { buildProviderSelection } from './openclawConfigSync';
import {
  readAnthropicStreamEvent,
  readGeminiStreamEvent,
  readOpenAIChatStreamEvent,
  readOpenAIResponsesStreamEvent,
  type SseEvent,
  type StreamChunk,
} from './sse';

/**
 * Sessionless, tool-free, streamed text calls against the user's current model.
 *
 * The OpenClaw gateway has no raw single-call API (its HTTP endpoints run a
 * full agent turn), so these calls go straight to the upstream. Transport and
 * endpoint come from the same buildProviderSelection() that renders
 * openclaw.json, so they always match what the agent runtime uses.
 */

const PROXY_TOKEN_PLACEHOLDER = '${LOBSTER_PROXY_TOKEN}';

export const OneShotTargetError = {
  NoModel: 'no-model',
  UnsupportedModel: 'unsupported-model',
} as const;
export type OneShotTargetError = typeof OneShotTargetError[keyof typeof OneShotTargetError];

const SUPPORTED_APIS: ReadonlySet<string> = new Set([
  OpenClawApi.AnthropicMessages,
  OpenClawApi.OpenAICompletions,
  OpenClawApi.OpenAIResponses,
  OpenClawApi.GoogleGenerativeAI,
]);

export type OneShotTarget = {
  api: OpenClawApi;
  baseUrl: string;
  apiKey: string;
  model: string;
  providerName: string;
};

export type OneShotTargetResolution =
  | { target: OneShotTarget }
  | { error: OneShotTargetError; detail?: string };

export type OneShotRequest = {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens: number;
};

type SelectionLike = Pick<ReturnType<typeof buildProviderSelection>, 'sessionModelId' | 'providerConfig'>;

/**
 * Turn a provider selection into a request target. Placeholders resolve the
 * same way OpenClaw resolves them: the loopback proxy token for providers
 * routed through a local proxy (LobsterAI server, Copilot), the provider's own
 * key otherwise.
 */
export function toOneShotTarget(options: {
  selection: SelectionLike;
  providerName: string;
  apiKey: string;
  proxyToken: string | null;
}): OneShotTargetResolution {
  const { providerConfig } = options.selection;
  const api = providerConfig.models[0]?.api ?? providerConfig.api;
  if (!SUPPORTED_APIS.has(api)) {
    return { error: OneShotTargetError.UnsupportedModel, detail: api };
  }
  // OAuth providers whose credential lives in OpenClaw's auth-profile store
  // (e.g. xAI OAuth) render no apiKey at all.
  if (providerConfig.apiKey === undefined) {
    return { error: OneShotTargetError.UnsupportedModel, detail: 'oauth' };
  }
  const apiKey = providerConfig.apiKey === PROXY_TOKEN_PLACEHOLDER
    ? options.proxyToken ?? ''
    : options.apiKey;
  return {
    target: {
      api: api as OpenClawApi,
      baseUrl: providerConfig.baseUrl.replace(/\/+$/, ''),
      apiKey,
      model: options.selection.sessionModelId,
      providerName: options.providerName,
    },
  };
}

/** Resolve the current default model into a one-shot target. */
export function resolveOneShotTarget(deps: { getProxyToken: () => string | null }): OneShotTargetResolution {
  const raw = resolveRawApiConfig();
  const config = raw.config;
  const metadata = raw.providerMetadata;
  if (!config?.model.trim()) {
    return { error: OneShotTargetError.NoModel, detail: raw.error };
  }
  const providerName = metadata?.providerName ?? '';
  const selection = buildProviderSelection({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    modelId: config.model.trim(),
    apiType: config.apiType,
    openaiApiMode: metadata?.openaiApiMode,
    geminiNative: metadata?.geminiNative,
    providerName,
    authType: metadata?.authType,
    codingPlanEnabled: metadata?.codingPlanEnabled,
    supportsImage: metadata?.supportsImage,
    modelName: metadata?.modelName,
  });
  return toOneShotTarget({
    selection,
    providerName,
    apiKey: config.apiKey,
    proxyToken: deps.getProxyToken(),
  });
}

const MAX_COMPLETION_TOKENS_MODEL_PREFIXES = ['gpt-5', 'o1', 'o3', 'o4'];

/** OpenAI's reasoning models reject max_tokens on Chat Completions. */
const usesMaxCompletionTokens = (target: OneShotTarget): boolean => {
  if (target.providerName !== ProviderName.OpenAI) return false;
  const model = target.model.toLowerCase();
  const resolved = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  return MAX_COMPLETION_TOKENS_MODEL_PREFIXES.some(prefix => resolved.startsWith(prefix));
};

export function buildOneShotHttpRequest(target: OneShotTarget, request: OneShotRequest): {
  url: string;
  init: RequestInit;
} {
  const json = (headers: Record<string, string>, body: Record<string, unknown>): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  switch (target.api) {
    case OpenClawApi.GoogleGenerativeAI:
      return {
        url: `${target.baseUrl}/models/${encodeURIComponent(target.model)}:streamGenerateContent?alt=sse`,
        init: json({ 'x-goog-api-key': target.apiKey }, {
          systemInstruction: { parts: [{ text: request.system }] },
          contents: request.messages.map(message => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }],
          })),
          generationConfig: { maxOutputTokens: request.maxTokens },
        }),
      };
    case OpenClawApi.OpenAICompletions:
      return {
        url: `${target.baseUrl}/chat/completions`,
        init: json({ Authorization: `Bearer ${target.apiKey}` }, {
          model: target.model,
          messages: [{ role: 'system', content: request.system }, ...request.messages],
          [usesMaxCompletionTokens(target) ? 'max_completion_tokens' : 'max_tokens']: request.maxTokens,
          stream: true,
        }),
      };
    case OpenClawApi.OpenAIResponses:
      // System text rides in `input`: OpenClaw only sends `instructions` and
      // `store` to endpoints verified to honor them.
      return {
        url: `${target.baseUrl}/responses`,
        init: json({ Authorization: `Bearer ${target.apiKey}` }, {
          model: target.model,
          input: [{ role: 'system', content: request.system }, ...request.messages],
          max_output_tokens: request.maxTokens,
          stream: true,
        }),
      };
    default:
      return {
        url: buildAnthropicMessagesUrl(target.baseUrl),
        init: json({ 'x-api-key': target.apiKey, 'anthropic-version': '2023-06-01' }, {
          model: target.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: request.messages,
          stream: true,
        }),
      };
  }
}

export function readOneShotStreamEvent(api: OpenClawApi, event: SseEvent): StreamChunk {
  switch (api) {
    case OpenClawApi.GoogleGenerativeAI:
      return readGeminiStreamEvent(event);
    case OpenClawApi.OpenAICompletions:
      return readOpenAIChatStreamEvent(event);
    case OpenClawApi.OpenAIResponses:
      return readOpenAIResponsesStreamEvent(event);
    default:
      return readAnthropicStreamEvent(event);
  }
}
