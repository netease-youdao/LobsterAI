/**
 * Pure compatibility & payload-contract helpers for `lobster-model-bridge`.
 * Zero DSH peer imports so Vitest can test this module directly.
 */

const OPENAI_COMPLETIONS_API = 'openai-completions';
const ANTHROPIC_MESSAGES_API = 'anthropic-messages';
const MOONSHOT_KIMI_K3_PROFILE = 'moonshot-kimi-k3';
const KIMI_K3_REASONING_EFFORT = 'max';
const KIMI_K3_FIXED_SAMPLING_FIELDS = [
  'temperature',
  'top_p',
  'n',
  'presence_penalty',
  'frequency_penalty',
];
const LOBSTERAI_REQUEST_OPTIONS_FIELD = 'lobsterai_options';
const LOBSTERAI_REQUEST_OPTIONS_VERSION = 1;
const MAX_SAFE_DEFAULT_MAX_TOKENS = 131_072;
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const THINKING_LEVEL_SET = new Set(THINKING_LEVELS);
const NON_OFF_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Returns true only when `baseUrl` targets OpenAI's official API host.
 * @param {unknown} baseUrl
 * @returns {boolean}
 */
export function isNativeOpenAIEndpoint(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

/**
 * Merge provider-level and model-level pi-ai `compat` flags and apply safe
 * defaults for non-native `openai-completions` endpoints.
 *
 * Provider-level compat is inherited only when the model speaks the same wire
 * protocol as the provider (so an `anthropic-messages` model inside a mixed
 * `lobsterai-server` provider never inherits OpenAI-completions flags).
 *
 * @param {string} modelApi
 * @param {string} modelBaseUrl
 * @param {unknown} providerCompat
 * @param {unknown} modelCompat
 * @param {string} [providerApi]
 * @returns {Record<string, unknown>}
 */
export function resolveModelCompat(
  modelApi,
  modelBaseUrl,
  providerCompat,
  modelCompat,
  providerApi,
) {
  const inheritProviderCompat = providerApi === undefined || providerApi === modelApi;
  const compat = {
    ...(inheritProviderCompat && isRecord(providerCompat) ? providerCompat : {}),
    ...(isRecord(modelCompat) ? modelCompat : {}),
  };

  if (modelApi === OPENAI_COMPLETIONS_API && !isNativeOpenAIEndpoint(modelBaseUrl)) {
    if (compat.supportsDeveloperRole === undefined) {
      compat.supportsDeveloperRole = false;
    }
    if (compat.supportsStore === undefined) {
      compat.supportsStore = false;
    }
  }

  return compat;
}

/**
 * Normalize a model's `thinkingLevelMap` for DSH / pi-ai. Preserves explicit
 * `null` entries because pi-ai uses `null` to mark unsupported effort levels.
 *
 * @param {Record<string, unknown>} rawModel
 * @param {boolean} reasoning
 * @returns {Record<string, string | null> | undefined}
 */
export function resolveModelThinkingLevelMap(rawModel, reasoning) {
  if (!reasoning) return undefined;

  if (isRecord(rawModel?.thinkingLevelMap)) {
    const sanitized = {};
    for (const [key, value] of Object.entries(rawModel.thinkingLevelMap)) {
      if (!THINKING_LEVEL_SET.has(key)) continue;
      if (value === null || (typeof value === 'string' && value.trim().length > 0)) {
        sanitized[key] = value === null ? null : value.trim();
      }
    }
    if (Object.keys(sanitized).length > 0) {
      return sanitized;
    }
  }

  if (isRecord(rawModel?.thinkingConfig) && Array.isArray(rawModel.thinkingConfig.options)) {
    const allowed = new Set();
    for (const option of rawModel.thinkingConfig.options) {
      if (isRecord(option) && typeof option.level === 'string' && THINKING_LEVEL_SET.has(option.level)) {
        allowed.add(option.level);
      }
    }
    if (allowed.size > 0) {
      const map = {};
      if (!allowed.has('off')) {
        map.off = null;
      }
      for (const level of NON_OFF_THINKING_LEVELS) {
        map[level] = allowed.has(level) ? level : null;
      }
      return map;
    }
  }

  return {
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
  };
}

/**
 * Determine the safe per-request `defaultMaxTokens` handed to DSH's `PiAiAdapter`.
 *
 * Models such as Kimi K3 advertise `maxTokens === contextWindow` (1,048,576) as
 * their catalog ceiling. Sending the full ceiling as a default output budget
 * risks context-overflow rejections whenever input estimation undercounts.
 *
 * @param {unknown} rawDefaultMaxTokens
 * @param {unknown} rawMaxTokens
 * @param {number} contextWindow
 * @returns {number | undefined}
 */
export function resolveDefaultRequestMaxTokens(rawDefaultMaxTokens, rawMaxTokens, contextWindow) {
  const hasMaxTokens = Number.isInteger(rawMaxTokens) && rawMaxTokens > 0;
  if (Number.isInteger(rawDefaultMaxTokens) && rawDefaultMaxTokens > 0) {
    return hasMaxTokens ? Math.min(rawDefaultMaxTokens, rawMaxTokens) : rawDefaultMaxTokens;
  }
  if (!hasMaxTokens) return undefined;
  if (rawMaxTokens <= MAX_SAFE_DEFAULT_MAX_TOKENS) {
    return rawMaxTokens;
  }
  const safeWindowHalf = Number.isInteger(contextWindow) && contextWindow > 0
    ? Math.max(1, Math.floor(contextWindow / 2))
    : MAX_SAFE_DEFAULT_MAX_TOKENS;
  return Math.min(MAX_SAFE_DEFAULT_MAX_TOKENS, safeWindowHalf);
}

/**
 * Kimi K3 rejects replayed assistant tool-call messages that carry no
 * `reasoning_content`, even when the original reasoning was never stored.
 * @param {Record<string, unknown>} payload
 */
export function ensureKimiK3ToolCallReasoningContent(payload) {
  if (!Array.isArray(payload.messages)) return;
  for (const message of payload.messages) {
    if (
      !isRecord(message)
      || message.role !== 'assistant'
      || !Array.isArray(message.tool_calls)
      || message.tool_calls.length === 0
      || 'reasoning_content' in message
    ) {
      continue;
    }
    message.reasoning_content = '';
  }
}

/**
 * Enforce Kimi K3's OpenAI-compatible payload contract (always-thinking
 * `reasoning_effort: "max"`, no fixed sampling overrides, no legacy K2 fields,
 * and assistant tool-call `reasoning_content` backfill).
 * @param {Record<string, unknown>} payload
 */
export function applyKimiK3PayloadContract(payload) {
  delete payload.thinking;
  delete payload.reasoningEffort;
  for (const field of KIMI_K3_FIXED_SAMPLING_FIELDS) {
    delete payload[field];
  }
  payload.reasoning_effort = KIMI_K3_REASONING_EFFORT;
  ensureKimiK3ToolCallReasoningContent(payload);
}

/**
 * Resolve the product thinking level to send inside `lobsterai_options.thinking.level`.
 *
 * Uses `rawReasoningEffort` first (captured before `PiAiAdapter` turns `'off'`
 * into `undefined`), falling back to `fallbackReasoning` and then `defaultLevel`.
 *
 * @param {unknown} thinkingConfig
 * @param {unknown} rawReasoningEffort
 * @param {unknown} fallbackReasoning
 * @returns {string | undefined}
 */
export function resolveRequestOptionsThinkingLevel(
  thinkingConfig,
  rawReasoningEffort,
  fallbackReasoning,
) {
  if (!isRecord(thinkingConfig) || !Array.isArray(thinkingConfig.options)) {
    return undefined;
  }
  const defaultLevel = typeof thinkingConfig.defaultLevel === 'string'
    ? thinkingConfig.defaultLevel.trim()
    : '';
  if (!THINKING_LEVEL_SET.has(defaultLevel)) {
    return undefined;
  }

  const candidate = typeof rawReasoningEffort === 'string' && rawReasoningEffort.trim().length > 0
    ? rawReasoningEffort.trim().toLowerCase()
    : (typeof fallbackReasoning === 'string' && fallbackReasoning.trim().length > 0
        ? fallbackReasoning.trim().toLowerCase()
        : '');

  if (candidate) {
    const exactMatch = thinkingConfig.options.find(
      (opt) => isRecord(opt) && opt.level === candidate,
    );
    if (exactMatch && typeof exactMatch.level === 'string') {
      return exactMatch.level;
    }
    const aliasMatch = thinkingConfig.options.find(
      (opt) => isRecord(opt) && opt.openclawLevel === candidate,
    );
    if (aliasMatch && typeof aliasMatch.level === 'string') {
      return aliasMatch.level;
    }
  }

  return defaultLevel;
}

/**
 * Attach LobsterAI's versioned internal request options envelope for
 * `lobsterai-server` to translate and strip before upstream forwarding.
 * @param {Record<string, unknown>} payload
 * @param {string} thinkingLevel
 */
export function applyLobsterAIRequestOptions(payload, thinkingLevel) {
  payload[LOBSTERAI_REQUEST_OPTIONS_FIELD] = {
    version: LOBSTERAI_REQUEST_OPTIONS_VERSION,
    thinking: {
      level: thinkingLevel,
    },
  };
}

/**
 * Invoke a pi-ai protocol implementation (`stream` or `streamSimple`) with
 * LobsterAI's per-model payload contracts (Kimi K3, `lobsterai_options` v1,
 * and safe default Anthropic thinking omission when no thinkingConfig exists).
 *
 * @param {{
 *   method: 'stream' | 'streamSimple';
 *   apiImpl: { stream: Function; streamSimple: Function };
 *   model: Record<string, unknown>;
 *   context: unknown;
 *   options?: Record<string, unknown>;
 *   modelMeta?: {
 *     runtimeProfile?: string;
 *     thinkingConfig?: Record<string, unknown>;
 *     requestOptionsVersion?: number;
 *   };
 *   requestContext?: {
 *     reasoningEffort?: string;
 *   };
 * }} params
 */
export function invokeModelApiStream({
  method,
  apiImpl,
  model,
  context,
  options,
  modelMeta,
  requestContext,
}) {
  const isKimiK3 = modelMeta?.runtimeProfile === MOONSHOT_KIMI_K3_PROFILE;
  if (isKimiK3 && model?.api !== OPENAI_COMPLETIONS_API) {
    throw new Error(
      `Kimi K3 compatibility requires ${OPENAI_COMPLETIONS_API} for ${String(model?.provider ?? 'unknown')}/${String(model?.id ?? 'unknown')}; received ${String(model?.api ?? 'unknown')}`,
    );
  }

  const hasRequestOptionsV1 = modelMeta?.requestOptionsVersion === LOBSTERAI_REQUEST_OPTIONS_VERSION
    && isRecord(modelMeta?.thinkingConfig);
  const resolvedThinkingLevel = hasRequestOptionsV1
    ? resolveRequestOptionsThinkingLevel(
        modelMeta.thinkingConfig,
        requestContext?.reasoningEffort,
        options?.reasoning ?? options?.reasoningEffort,
      )
    : undefined;

  // Models such as Claude Sonnet/Opus 5.5 reject `thinking: { type: "disabled" }`.
  // When a model does not declare configurable thinking controls, omit pi-ai's
  // synthetic `{ type: "disabled" }` so Anthropic / server applies its native default.
  const shouldOmitSyntheticDisabledAnthropicThinking =
    model?.api === ANTHROPIC_MESSAGES_API
    && !hasRequestOptionsV1
    && !isRecord(modelMeta?.thinkingConfig);

  if (!isKimiK3 && !resolvedThinkingLevel && !shouldOmitSyntheticDisabledAnthropicThinking) {
    return apiImpl[method](model, context, options);
  }

  const effectiveModel = isKimiK3 ? { ...model, reasoning: true } : model;
  const effectiveOptions = { ...(options ?? {}) };
  if (isKimiK3) {
    if (method === 'streamSimple') {
      effectiveOptions.reasoning = KIMI_K3_REASONING_EFFORT;
    } else {
      effectiveOptions.reasoningEffort = KIMI_K3_REASONING_EFFORT;
    }
  }

  const originalOnPayload = typeof options?.onPayload === 'function' ? options.onPayload : undefined;
  const applyPostHooks = (candidate) => {
    if (!isRecord(candidate)) return;
    if (isKimiK3) {
      applyKimiK3PayloadContract(candidate);
    }
    if (
      shouldOmitSyntheticDisabledAnthropicThinking
      && isRecord(candidate.thinking)
      && candidate.thinking.type === 'disabled'
    ) {
      delete candidate.thinking;
    }
    if (resolvedThinkingLevel) {
      applyLobsterAIRequestOptions(candidate, resolvedThinkingLevel);
    }
  };

  effectiveOptions.onPayload = (payload, payloadModel) => {
    if (isKimiK3 && isRecord(payload)) {
      applyKimiK3PayloadContract(payload);
    }
    const next = originalOnPayload?.(payload, payloadModel);
    if (next && typeof next.then === 'function') {
      return Promise.resolve(next).then((resolved) => {
        const target = resolved !== undefined ? resolved : payload;
        applyPostHooks(target);
        return resolved !== undefined ? target : undefined;
      });
    }
    const target = next !== undefined ? next : payload;
    applyPostHooks(target);
    return next !== undefined ? target : undefined;
  };

  return apiImpl[method](effectiveModel, context, effectiveOptions);
}

/**
 * Dispatch a provider stream call using the concrete protocol declared on
 * `model.api` (falling back to the provider's default `spec.api`), allowing
 * mixed-protocol providers such as `lobsterai-server` to serve both OpenAI
 * Chat Completions and Anthropic Messages models side-by-side.
 *
 * @param {{
 *   method: 'stream' | 'streamSimple';
 *   spec: { provider: string; api: string };
 *   protocols: Record<string, () => { stream: Function; streamSimple: Function }>;
 *   apiImplCache: Map<string, { stream: Function; streamSimple: Function }>;
 *   model: Record<string, unknown>;
 *   context: unknown;
 *   options?: Record<string, unknown>;
 *   modelRuntimeMeta?: Map<string, Record<string, unknown>>;
 *   requestContext?: { reasoningEffort?: string };
 * }} params
 */
export function dispatchProviderStream({
  method,
  spec,
  protocols,
  apiImplCache,
  model,
  context,
  options,
  modelRuntimeMeta,
  requestContext,
}) {
  const targetApi = typeof model?.api === 'string' && model.api.trim().length > 0
    ? model.api.trim()
    : spec.api;
  let apiImpl = apiImplCache.get(targetApi);
  if (!apiImpl) {
    const factory = protocols[targetApi];
    if (!factory) {
      throw new Error(
        `lobster-model-bridge: unsupported protocol "${targetApi}" for model "${spec.provider}/${String(model?.id ?? 'unknown')}"`,
      );
    }
    apiImpl = factory();
    apiImplCache.set(targetApi, apiImpl);
  }
  const modelMeta = typeof model?.id === 'string' ? modelRuntimeMeta?.get(model.id) : undefined;
  return invokeModelApiStream({
    method,
    apiImpl,
    model,
    context,
    options,
    modelMeta,
    requestContext,
  });
}
