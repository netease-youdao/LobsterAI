import { type ModelPresetId, parseModelPresetModelId } from '../../shared/modelPresets/constants';
import { ApiFormat, OpenClawApi, ProviderName } from '../../shared/providers';
import { resolveRawApiConfig } from './claudeSettings';
import { buildAnthropicMessagesUrl } from './coworkModelApi';
import type { ResolvedPresetModel } from './modelPresets';
import {
  buildProviderSelection,
  PROXY_TOKEN_PLACEHOLDER,
  ProxyRouteSegment,
  resolveProxyBackedBaseUrl,
  stripChatCompletionsSuffix,
  stripResponsesSuffix,
} from './providerSelection';
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

const LOOPBACK_PROXY_PATH_PATTERN = /^\/v1(?:\/(?:lobsterai-server|lobster|lobsterai|youdao|github-copilot|copilot|openai-codex|xai-oauth))?$/;
const CODEX_PROXY_PATH_PATTERN = new RegExp(`^/v1/${ProxyRouteSegment.OpenAICodex}$`, 'i');

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function isLoopbackProxyBaseUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return isLoopbackHost(parsed.hostname) && LOOPBACK_PROXY_PATH_PATTERN.test(pathname);
  } catch {
    return false;
  }
}

function isOpenAICodexProxyBaseUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return isLoopbackHost(parsed.hostname) && CODEX_PROXY_PATH_PATTERN.test(pathname);
  } catch {
    return false;
  }
}

export const OneShotTargetError = {
  NoModel: 'no-model',
  UnsupportedModel: 'unsupported-model',
} as const;
export type OneShotTargetError = typeof OneShotTargetError[keyof typeof OneShotTargetError];

const SUPPORTED_APIS: ReadonlySet<string> = new Set([
  OpenClawApi.AnthropicMessages,
  OpenClawApi.OpenAICompletions,
  OpenClawApi.OpenAIResponses,
  OpenClawApi.OpenAICodexResponses,
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

export type OneShotPresetResolver = (presetId: ModelPresetId, signal: AbortSignal) => Promise<ResolvedPresetModel>;

/** Presets are virtual catalog entries; resolve before choosing the wire protocol. */
export async function resolveOneShotPreset(
  target: OneShotTarget,
  resolvePreset: OneShotPresetResolver | undefined,
  signal: AbortSignal,
): Promise<OneShotTarget> {
  const presetId = target.providerName === ProviderName.LobsteraiServer ? parseModelPresetModelId(target.model) : null;
  if (!presetId) return target;
  signal.throwIfAborted();
  if (!resolvePreset) throw new Error(OneShotTargetError.UnsupportedModel);
  const model = await resolvePreset(presetId, signal);
  signal.throwIfAborted();
  if (!model.modelId?.trim() || parseModelPresetModelId(model.modelId) || model.accessible === false
    || (model.apiFormat !== ApiFormat.OpenAI && model.apiFormat !== ApiFormat.Anthropic)) {
    throw new Error(OneShotTargetError.UnsupportedModel);
  }
  return { ...target, model: model.modelId.trim(),
    api: model.apiFormat === ApiFormat.Anthropic ? OpenClawApi.AnthropicMessages : OpenClawApi.OpenAICompletions };
}

export type OneShotRequest = {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens: number;
  /** Minimize hidden reasoning latency for interactive quick-generation calls (e.g. Codex `reasoning.effort: 'low'`). */
  lowLatency?: boolean;
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
  proxyBaseUrl?: string | null;
  authType?: 'apikey' | 'oauth';
}): OneShotTargetResolution {
  const { providerConfig } = options.selection;
  const api = providerConfig.models[0]?.api ?? providerConfig.api;
  if (!SUPPORTED_APIS.has(api)) {
    return { error: OneShotTargetError.UnsupportedModel, detail: api };
  }
  // External OAuth providers without a direct key or local proxy route render no apiKey.
  if (providerConfig.apiKey === undefined) {
    return { error: OneShotTargetError.UnsupportedModel, detail: 'oauth' };
  }
  let baseUrl = providerConfig.baseUrl.replace(/\/+$/, '');
  let apiKey: string;
  if (providerConfig.apiKey === PROXY_TOKEN_PLACEHOLDER) {
    if (!isLoopbackProxyBaseUrl(baseUrl)) {
      const rewritten = resolveProxyBackedBaseUrl(options.providerName, options.proxyBaseUrl, options.authType);
      if (rewritten) {
        baseUrl = rewritten;
      }
    }
    // Never send the local loopback proxy secret directly to an upstream server.
    if (!isLoopbackProxyBaseUrl(baseUrl)) {
      return { error: OneShotTargetError.UnsupportedModel, detail: 'proxy-unavailable' };
    }
    apiKey = options.proxyToken ?? '';
  } else {
    apiKey = options.apiKey;
  }
  const resolvedApi =
    providerConfig.apiKey === PROXY_TOKEN_PLACEHOLDER && isOpenAICodexProxyBaseUrl(baseUrl)
      ? OpenClawApi.OpenAICodexResponses
      : (api as OpenClawApi);
  return {
    target: {
      api: resolvedApi,
      baseUrl,
      apiKey,
      model: options.selection.sessionModelId,
      providerName: options.providerName,
    },
  };
}

/** Resolve the current default model into a one-shot target. */
export function resolveOneShotTarget(deps: {
  getProxyToken: () => string | null;
  getProxyBaseUrl?: () => string | null;
}): OneShotTargetResolution {
  const raw = resolveRawApiConfig();
  const config = raw.config;
  const metadata = raw.providerMetadata;
  if (!config?.model.trim()) {
    return { error: OneShotTargetError.NoModel, detail: raw.error };
  }
  const providerName = metadata?.providerName ?? '';
  const proxyBaseUrl = deps.getProxyBaseUrl?.() ?? null;
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
    proxyBaseUrl,
  });
  return toOneShotTarget({
    selection,
    providerName,
    apiKey: config.apiKey,
    proxyToken: deps.getProxyToken(),
    proxyBaseUrl,
    authType: metadata?.authType,
  });
}

const MAX_COMPLETION_TOKENS_MODEL_PREFIXES = ['gpt-5', 'gpt-6', 'o1', 'o3', 'o4'];

/** OpenAI's reasoning models reject max_tokens on Chat Completions. */
const usesMaxCompletionTokens = (target: OneShotTarget): boolean => {
  if (target.providerName !== ProviderName.OpenAI) return false;
  const model = target.model.toLowerCase();
  const resolved = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  return MAX_COMPLETION_TOKENS_MODEL_PREFIXES.some(prefix => resolved.startsWith(prefix));
};

function toCodexInputItem(message: OneShotRequest['messages'][number]): Record<string, unknown> {
  if (message.role === 'assistant') {
    return {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: message.content, annotations: [] }],
    };
  }
  return {
    role: 'user',
    content: [{ type: 'input_text', text: message.content }],
  };
}

export function buildOneShotHttpRequest(target: OneShotTarget, request: OneShotRequest): {
  url: string;
  init: RequestInit;
} {
  const json = (headers: Record<string, string>, body: Record<string, unknown>): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  const buildCodexResponses = () => ({
    // ChatGPT Codex Responses (`chatgpt.com/backend-api/codex/responses`) requires
    // top-level `instructions`, `store: false`, `stream: true`, structured input items,
    // and rejects `max_output_tokens`.
    url: `${stripResponsesSuffix(target.baseUrl)}/responses`,
    init: json({
      Authorization: `Bearer ${target.apiKey}`,
      Accept: 'text/event-stream',
      'OpenAI-Beta': 'responses=experimental',
      originator: 'pi',
    }, {
      model: target.model,
      store: false,
      stream: true,
      instructions: request.system.trim() || 'You are a helpful assistant.',
      input: request.messages.map(toCodexInputItem),
      ...(request.lowLatency ? { reasoning: { effort: 'low' }, text: { verbosity: 'low' } } : {}),
    }),
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
        url: `${stripChatCompletionsSuffix(target.baseUrl)}/chat/completions`,
        init: json({ Authorization: `Bearer ${target.apiKey}` }, {
          model: target.model,
          messages: [{ role: 'system', content: request.system }, ...request.messages],
          [usesMaxCompletionTokens(target) ? 'max_completion_tokens' : 'max_tokens']: request.maxTokens,
          stream: true,
        }),
      };
    case OpenClawApi.OpenAICodexResponses:
      return buildCodexResponses();
    case OpenClawApi.OpenAIResponses:
      if (isOpenAICodexProxyBaseUrl(target.baseUrl)) {
        return buildCodexResponses();
      }
      // System text rides in `input`: OpenClaw only sends `instructions` and
      // `store` to endpoints verified to honor them.
      return {
        url: `${stripResponsesSuffix(target.baseUrl)}/responses`,
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
    case OpenClawApi.OpenAICodexResponses:
      return readOpenAIResponsesStreamEvent(event);
    default:
      return readAnthropicStreamEvent(event);
  }
}
