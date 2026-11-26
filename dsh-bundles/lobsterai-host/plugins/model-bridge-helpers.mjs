/**
 * Pure compatibility & payload-contract helpers for `lobster-model-bridge`.
 * Zero DSH peer imports so Vitest can test this module directly.
 */

const OPENAI_COMPLETIONS_API = 'openai-completions';
const OPENAI_RESPONSES_API = 'openai-responses';
const OPENAI_CODEX_RESPONSES_API = 'openai-codex-responses';
const AZURE_OPENAI_RESPONSES_API = 'azure-openai-responses';
const ANTHROPIC_MESSAGES_API = 'anthropic-messages';
const GOOGLE_GENERATIVE_AI_API = 'google-generative-ai';

const OPENAI_FAMILY_APIS = new Set([
  OPENAI_COMPLETIONS_API,
  OPENAI_RESPONSES_API,
  OPENAI_CODEX_RESPONSES_API,
  AZURE_OPENAI_RESPONSES_API,
]);

const OPENAI_RESPONSES_FAMILY_APIS = new Set([
  OPENAI_RESPONSES_API,
  OPENAI_CODEX_RESPONSES_API,
  AZURE_OPENAI_RESPONSES_API,
]);

const CATALOG_PROVIDER_CANDIDATES = Object.freeze({
  openai: ['openai'],
  anthropic: ['anthropic'],
  deepseek: ['deepseek'],
  gemini: ['google'],
  zhipu: ['zai', 'zai-coding-cn'],
  moonshot: ['moonshotai', 'moonshotai-cn', 'kimi-coding'],
  minimax: ['minimax', 'minimax-cn'],
  xai: ['xai'],
  openrouter: ['openrouter'],
  'github-copilot': ['github-copilot'],
  xiaomi: ['xiaomi'],
  mimo: ['xiaomi'],
});

const PROVIDER_ID_ALIASES = Object.freeze({
  zai: 'zhipu',
  google: 'gemini',
  'lobsterai-copilot': 'github-copilot',
  'minimax-portal': 'minimax',
  'openai-codex': 'openai',
});

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
const USER_CONTEXT_WINDOW_PREFIX = 'user-context:';

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Canonicalize legacy/OpenClaw provider IDs to their canonical DSH provider IDs.
 * @param {unknown} rawId
 * @returns {string}
 */
export function canonicalizeProviderId(rawId) {
  if (typeof rawId !== 'string') return '';
  const trimmed = rawId.trim();
  if (!trimmed) return '';
  return PROVIDER_ID_ALIASES[trimmed] ?? trimmed;
}

/**
 * Normalize a provider/model API format identifier into a pi-ai protocol key.
 * @param {unknown} rawApi
 * @returns {string}
 */
export function normalizeProtocol(rawApi) {
  const api = typeof rawApi === 'string' ? rawApi.trim().toLowerCase() : '';
  if (api === 'anthropic' || api === ANTHROPIC_MESSAGES_API) return ANTHROPIC_MESSAGES_API;
  if (api === OPENAI_RESPONSES_API || api === 'responses') return OPENAI_RESPONSES_API;
  if (api === 'google' || api === 'gemini' || api === GOOGLE_GENERATIVE_AI_API) {
    return GOOGLE_GENERATIVE_AI_API;
  }
  return OPENAI_COMPLETIONS_API;
}

/**
 * Strip trailing endpoint suffixes (`/chat/completions`, `/responses`) on
 * OpenAI-family URLs and strip inherited `/v1` when an Anthropic model inherits
 * a non-Anthropic provider's base URL (because `@anthropic-ai/sdk` appends `/v1/messages`).
 *
 * @param {unknown} rawBaseUrl
 * @param {string} [modelApi]
 * @param {string} [providerApi]
 * @param {boolean} [hasExplicitModelBaseUrl]
 * @returns {string}
 */
export function normalizeProviderBaseUrl(
  rawBaseUrl,
  modelApi = OPENAI_COMPLETIONS_API,
  providerApi,
  hasExplicitModelBaseUrl = false,
) {
  if (typeof rawBaseUrl !== 'string') return '';
  let normalized = rawBaseUrl.trim().replace(/\/+$/, '');
  if (!normalized) return '';

  const resolvedApi = normalizeProtocol(modelApi);
  if (resolvedApi === OPENAI_COMPLETIONS_API || resolvedApi === OPENAI_RESPONSES_API) {
    normalized = normalized.replace(/\/(chat\/completions|responses)$/i, '').replace(/\/+$/, '');
  } else if (
    resolvedApi === ANTHROPIC_MESSAGES_API
    && !hasExplicitModelBaseUrl
    && providerApi
    && normalizeProtocol(providerApi) !== ANTHROPIC_MESSAGES_API
  ) {
    normalized = normalized.replace(/\/v1$/i, '').replace(/\/+$/, '');
  }

  return normalized;
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
 * Extract `compat` flags from a matched built-in `pi-ai` catalog entry only
 * when the catalog entry speaks the exact same wire protocol as `modelApi`.
 * Prevents cross-protocol compat leakage (e.g. OpenAI Completions flags onto
 * Anthropic Messages, or Responses flags onto Completions).
 *
 * @param {string} modelApi
 * @param {unknown} catalogModel
 * @returns {Record<string, unknown> | undefined}
 */
export function resolveCatalogModelCompat(modelApi, catalogModel) {
  if (!isRecord(catalogModel) || !isRecord(catalogModel.compat)) {
    return undefined;
  }
  if (
    typeof catalogModel.api !== 'string'
    || normalizeProtocol(catalogModel.api) !== normalizeProtocol(modelApi)
  ) {
    return undefined;
  }
  return catalogModel.compat;
}

/**
 * Merge built-in catalog, provider-level, and model-level pi-ai `compat` flags
 * and apply safe defaults for non-native `openai-completions` endpoints.
 *
 * Priority (lowest to highest):
 * 1. `catalogCompat` (from matching built-in `pi-ai` catalog entry)
 * 2. `providerCompat` (inherited only when the model speaks the same wire
 *    protocol as the provider, so an `anthropic-messages` model inside a mixed
 *    `lobsterai-server` provider never inherits OpenAI-completions flags)
 * 3. `modelCompat` (explicit per-model / runtime-profile overrides)
 *
 * @param {string} modelApi
 * @param {string} modelBaseUrl
 * @param {unknown} providerCompat
 * @param {unknown} modelCompat
 * @param {string} [providerApi]
 * @param {unknown} [catalogCompat]
 * @returns {Record<string, unknown>}
 */
export function resolveModelCompat(
  modelApi,
  modelBaseUrl,
  providerCompat,
  modelCompat,
  providerApi,
  catalogCompat,
) {
  const inheritProviderCompat = !providerApi
    || normalizeProtocol(providerApi) === normalizeProtocol(modelApi);
  const compat = {
    ...(isRecord(catalogCompat) ? catalogCompat : {}),
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
 * Resolve ordered candidate `@earendil-works/pi-ai` built-in catalog provider IDs
 * for a canonical LobsterAI provider route.
 *
 * `lobsterai-server` and `custom_*` routes do not inherit built-in catalog entries
 * unless an explicit `catalogProviderHint` is supplied.
 *
 * @param {string} providerId
 * @param {unknown} [catalogProviderHint]
 * @returns {string[]}
 */
export function resolveCatalogProviderCandidates(providerId, catalogProviderHint) {
  const candidates = [];
  const pushUnique = (id) => {
    if (typeof id !== 'string') return;
    const trimmed = id.trim();
    if (trimmed && !candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };

  pushUnique(catalogProviderHint);

  const normalized = typeof providerId === 'string' ? providerId.trim() : '';
  if (!normalized || normalized === 'lobsterai-server' || normalized.startsWith('custom_')) {
    return candidates;
  }

  const mapped = CATALOG_PROVIDER_CANDIDATES[normalized];
  if (mapped) {
    for (const candidate of mapped) {
      pushUnique(candidate);
    }
  } else {
    pushUnique(normalized);
  }
  return candidates;
}

/**
 * Determine whether a built-in catalog model's `thinkingLevelMap` is compatible
 * with the wire protocol configured for the model.
 *
 * @param {string} modelApi
 * @param {unknown} catalogApi
 * @returns {boolean}
 */
export function isCatalogThinkingMapCompatible(modelApi, catalogApi) {
  if (typeof catalogApi !== 'string' || catalogApi.trim().length === 0) {
    return true;
  }
  const normalizedCatalogApi = catalogApi.trim().toLowerCase();
  if (modelApi === normalizedCatalogApi) {
    return true;
  }
  return OPENAI_FAMILY_APIS.has(modelApi) && OPENAI_FAMILY_APIS.has(normalizedCatalogApi);
}

/**
 * Look up a matching chat model entry from `@earendil-works/pi-ai`'s built-in
 * catalog across ordered candidate provider IDs.
 *
 * @param {((provider: string, modelId: string) => unknown) | undefined} getBuiltinModel
 * @param {readonly string[]} providerCandidates
 * @param {string} modelId
 * @param {string} modelApi
 * @returns {Record<string, unknown> | undefined}
 */
export function lookupBuiltinCatalogModel(getBuiltinModel, providerCandidates, modelId, modelApi) {
  if (typeof getBuiltinModel !== 'function' || !Array.isArray(providerCandidates) || !modelId) {
    return undefined;
  }
  for (const candidateProvider of providerCandidates) {
    let entry;
    try {
      entry = getBuiltinModel(candidateProvider, modelId);
    } catch {
      entry = undefined;
    }
    if (!isRecord(entry)) continue;
    if (entry.type !== undefined && entry.type !== 'chat') continue;
    if (!isCatalogThinkingMapCompatible(modelApi, entry.api)) continue;
    return entry;
  }
  return undefined;
}

/**
 * Sanitize a raw `thinkingLevelMap` object, retaining only recognized thinking
 * level keys with either `null` (unsupported) or non-empty wire strings.
 *
 * @param {unknown} rawMap
 * @returns {Record<string, string | null> | undefined}
 */
function sanitizeThinkingLevelMap(rawMap) {
  if (!isRecord(rawMap)) return undefined;
  const sanitized = {};
  for (const [key, value] of Object.entries(rawMap)) {
    if (!THINKING_LEVEL_SET.has(key)) continue;
    if (value === null || (typeof value === 'string' && value.trim().length > 0)) {
      sanitized[key] = value === null ? null : value.trim();
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

/**
 * Derive a pi-ai `thinkingLevelMap` from a server `thinkingConfig` when present.
 *
 * @param {unknown} thinkingConfig
 * @returns {Record<string, string | null> | undefined}
 */
function deriveThinkingLevelMapFromConfig(thinkingConfig) {
  if (!isRecord(thinkingConfig) || !Array.isArray(thinkingConfig.options)) {
    return undefined;
  }
  const allowed = new Set();
  for (const option of thinkingConfig.options) {
    if (isRecord(option) && typeof option.level === 'string' && THINKING_LEVEL_SET.has(option.level)) {
      allowed.add(option.level);
    }
  }
  if (allowed.size === 0) return undefined;
  const map = {};
  if (!allowed.has('off')) {
    map.off = null;
  }
  for (const level of NON_OFF_THINKING_LEVELS) {
    map[level] = allowed.has(level) ? level : null;
  }
  return map;
}

/**
 * Returns true only when the model has an authoritative thinking-level mapping
 * (explicit `thinkingLevelMap`, `thinkingConfig`, or a matching built-in pi-ai
 * catalog entry declaring `thinkingLevelMap`).
 *
 * Mirrors DSH's `dsh-llm-pi-ai` rule: unknown hand-declared models without a
 * verified allowlist must not expose guessed `reasoning.efforts` to DSH callers
 * (such as `session-title-service`), preventing unsupported `off` / `minimal`
 * effort rejections.
 *
 * @param {Record<string, unknown>} rawModel
 * @param {boolean} reasoning
 * @param {Record<string, unknown>} [catalogModel]
 * @returns {boolean}
 */
export function hasVerifiedModelThinkingLevels(rawModel, reasoning, catalogModel) {
  if (!reasoning) return false;
  if (sanitizeThinkingLevelMap(rawModel?.thinkingLevelMap)) return true;
  if (deriveThinkingLevelMapFromConfig(rawModel?.thinkingConfig)) return true;
  if (catalogModel?.reasoning === true && sanitizeThinkingLevelMap(catalogModel.thinkingLevelMap)) {
    return true;
  }
  return false;
}

/**
 * Omit DSH `modelInfo.reasoning` when a model lacks verified thinking-level
 * metadata so auxiliary DSH services (e.g. `session-title-service`) omit
 * `reasoningEffort` and defer to the upstream model's native default.
 *
 * @template T
 * @param {T} modelInfo
 * @param {boolean} hasVerifiedThinkingLevels
 * @returns {T}
 */
export function sanitizeExposedModelInfo(modelInfo, hasVerifiedThinkingLevels) {
  if (hasVerifiedThinkingLevels || !isRecord(modelInfo) || !('reasoning' in modelInfo)) {
    return modelInfo;
  }
  const { reasoning: _omitted, ...rest } = modelInfo;
  return /** @type {T} */ (rest);
}

/**
 * Normalize a model's `thinkingLevelMap` for DSH / pi-ai. Preserves explicit
 * `null` entries because pi-ai uses `null` to mark unsupported effort levels.
 *
 * Priority:
 * 1. Explicit `rawModel.thinkingLevelMap`
 * 2. Derived from `rawModel.thinkingConfig`
 * 3. Matching built-in pi-ai `catalogModel.thinkingLevelMap`
 * 4. Fail-safe fallback with `off: null` so pi-ai never synthesizes `effort: "none"`
 *    or `thinking: { type: "disabled" }` for models whose off-support is unknown.
 *
 * @param {Record<string, unknown>} rawModel
 * @param {boolean} reasoning
 * @param {Record<string, unknown>} [catalogModel]
 * @returns {Record<string, string | null> | undefined}
 */
export function resolveModelThinkingLevelMap(rawModel, reasoning, catalogModel) {
  if (!reasoning) return undefined;

  const explicitMap = sanitizeThinkingLevelMap(rawModel?.thinkingLevelMap);
  if (explicitMap) {
    return explicitMap;
  }

  const configMap = deriveThinkingLevelMapFromConfig(rawModel?.thinkingConfig);
  if (configMap) {
    return configMap;
  }

  if (catalogModel?.reasoning === true) {
    const catalogMap = sanitizeThinkingLevelMap(catalogModel.thinkingLevelMap);
    if (catalogMap) {
      return catalogMap;
    }
  }

  return {
    off: null,
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
 * Parse a token budget out of a LobsterAI context window selection string
 * (e.g. `user-context:1000000` or `user-context:yd-fast:400000`).
 *
 * @param {unknown} selectionId
 * @returns {number | undefined}
 */
export function parseContextWindowSelectionTokens(selectionId) {
  if (typeof selectionId !== 'string') return undefined;
  const trimmed = selectionId.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith(USER_CONTEXT_WINDOW_PREFIX)) {
    const suffix = trimmed.slice(trimmed.lastIndexOf(':') + 1);
    const parsed = Number(suffix);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

/**
 * Resolve the effective context window for a model given optional per-session
 * context window selection ID or explicit numeric override.
 *
 * @param {{ contextWindow: number, contextWindows?: Array<{ id: string, contextWindow: number }> }} model
 * @param {unknown} selectionId
 * @param {unknown} overrideTokens
 * @returns {number}
 */
export function resolveEffectiveContextWindow(model, selectionId, overrideTokens) {
  if (typeof overrideTokens === 'number' && Number.isInteger(overrideTokens) && overrideTokens > 0) {
    return overrideTokens;
  }
  if (typeof selectionId === 'string' && selectionId.trim().length > 0) {
    const trimmed = selectionId.trim();
    if (Array.isArray(model?.contextWindows)) {
      const matched = model.contextWindows.find(
        (entry) => entry && entry.id === trimmed && Number.isInteger(entry.contextWindow) && entry.contextWindow > 0,
      );
      if (matched) return matched.contextWindow;
    }
    const parsed = parseContextWindowSelectionTokens(trimmed);
    if (parsed !== undefined) return parsed;
  }
  return model.contextWindow;
}

/**
 * Select and cache the pi-ai protocol implementation for a model's `api`
 * (falling back to the provider's `defaultApi`).
 *
 * @param {Record<string, () => unknown>} protocols
 * @param {Map<string, unknown>} implCache
 * @param {unknown} modelApi
 * @param {string} defaultApi
 * @returns {unknown}
 */
export function selectProtocolImpl(protocols, implCache, modelApi, defaultApi) {
  const targetApi = normalizeProtocol(modelApi || defaultApi);
  let impl = implCache.get(targetApi);
  if (!impl) {
    const factory = protocols[targetApi];
    if (typeof factory !== 'function') {
      throw new Error(`lobster-model-bridge: unsupported protocol "${targetApi}"`);
    }
    impl = factory();
    implCache.set(targetApi, impl);
  }
  return impl;
}

/**
 * Apply model-level payload transforms inside pi-ai's `onPayload` hook:
 * 1. Flatten text-only array message contents to plain strings when
 *    `model.compat.requiresStringContent === true` (e.g. Kimi K3).
 * 2. Merge per-model `customParams` (`extra_body`) into the request payload.
 *
 * @param {unknown} params
 * @param {{ compat?: Record<string, unknown> } | undefined} model
 * @param {Record<string, unknown> | undefined} customParams
 * @returns {unknown}
 */
export function applyModelPayloadTransforms(params, model, customParams) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return params;
  }

  let next = /** @type {Record<string, unknown>} */ (params);

  if (model?.compat?.requiresStringContent === true && Array.isArray(next.messages)) {
    let messagesChanged = false;
    const nextMessages = next.messages.map((msg) => {
      if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) return msg;
      const isTextOnly = msg.content.every(
        (part) => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string',
      );
      if (!isTextOnly) return msg;
      messagesChanged = true;
      const text = msg.content.map((part) => part.text).join('\n');
      return { ...msg, content: text };
    });
    if (messagesChanged) {
      next = { ...next, messages: nextMessages };
    }
  }

  if (customParams && typeof customParams === 'object' && !Array.isArray(customParams)) {
    const entries = Object.entries(customParams);
    if (entries.length > 0) {
      next = { ...next, ...customParams };
    }
  }

  return next;
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
 * Remove synthetic disabled-thinking payload fields that pi-ai injects when a
 * reasoning-capable model is invoked without an explicit `reasoningEffort`.
 *
 * Always-reasoning models (such as `gpt-6-astra`, `gpt-6.2-astra`, Claude 5.5,
 * and Gemini 2.5 Pro) reject synthetic `reasoning.effort = "none"`,
 * `thinking = { type: "disabled" }`, or disabled Gemini `thinkingConfig`; and
 * models that do accept `"none"` (such as `gpt-6-luna`) would otherwise have
 * thinking silently turned off whenever the caller left reasoning at default.
 *
 * @param {Record<string, unknown>} payload
 * @param {unknown} modelApi
 */
export function omitSyntheticDisabledThinking(payload, modelApi) {
  if (!isRecord(payload)) return;
  const api = typeof modelApi === 'string' ? modelApi.trim().toLowerCase() : '';

  if (api === ANTHROPIC_MESSAGES_API) {
    if (isRecord(payload.thinking) && payload.thinking.type === 'disabled') {
      delete payload.thinking;
    }
    return;
  }

  if (OPENAI_RESPONSES_FAMILY_APIS.has(api)) {
    if (isRecord(payload.reasoning) && payload.reasoning.effort === 'none') {
      delete payload.reasoning;
    }
    return;
  }

  if (api === OPENAI_COMPLETIONS_API) {
    if (payload.reasoning_effort === 'none') {
      delete payload.reasoning_effort;
    }
    if (isRecord(payload.reasoning) && payload.reasoning.effort === 'none') {
      delete payload.reasoning;
    }
    return;
  }

  if (api === GOOGLE_GENERATIVE_AI_API) {
    if (
      isRecord(payload.config)
      && isRecord(payload.config.thinkingConfig)
      && payload.config.thinkingConfig.includeThoughts !== true
    ) {
      delete payload.config.thinkingConfig;
    }
  }
}

/**
 * Invoke a pi-ai protocol implementation (`stream` or `streamSimple`) with
 * LobsterAI's per-model payload contracts (Kimi K3, `lobsterai_options` v1,
 * `requiresStringContent` / `customParams`, and cross-protocol omission of
 * pi-ai's synthetic disabled-thinking fields when the caller did not
 * explicitly request `off`).
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
 *     customParams?: Record<string, unknown>;
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

  const rawRequestedEffort = typeof requestContext?.reasoningEffort === 'string'
    ? requestContext.reasoningEffort.trim().toLowerCase()
    : '';
  const explicitlyRequestedOff = rawRequestedEffort === 'off';
  const hasExplicitReasoningOption = Boolean(options?.reasoning || options?.reasoningEffort);
  // When a model does not declare server `thinkingConfig` and the caller did not
  // explicitly request `off` (nor a concrete reasoning level), strip pi-ai's
  // synthetic disabled-thinking payload (`reasoning: { effort: "none" }`,
  // `thinking: { type: "disabled" }`, etc.) so the upstream applies its native
  // default instead of rejecting with 400 or silently disabling thinking.
  const shouldOmitSyntheticDisabledThinking =
    !hasRequestOptionsV1
    && !isRecord(modelMeta?.thinkingConfig)
    && !explicitlyRequestedOff
    && !hasExplicitReasoningOption
    && (
      model?.api === ANTHROPIC_MESSAGES_API
      || OPENAI_RESPONSES_FAMILY_APIS.has(String(model?.api ?? ''))
      || model?.api === OPENAI_COMPLETIONS_API
      || model?.api === GOOGLE_GENERATIVE_AI_API
    );

  const customParams = isRecord(modelMeta?.customParams) && Object.keys(modelMeta.customParams).length > 0
    ? modelMeta.customParams
    : undefined;
  const needsPayloadTransform = Boolean(
    customParams || model?.compat?.requiresStringContent === true,
  );

  if (
    !isKimiK3
    && !resolvedThinkingLevel
    && !shouldOmitSyntheticDisabledThinking
    && !needsPayloadTransform
  ) {
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
  const applyPostHooks = (candidate, payloadModel) => {
    if (!isRecord(candidate)) return;
    // Strip pi-ai's synthetic disabled thinking BEFORE merging `customParams`
    // so explicit user `customParams` (e.g. `{ reasoning: { effort: "high" } }`
    // or `{ reasoning: { effort: "none" } }`) always win.
    if (shouldOmitSyntheticDisabledThinking) {
      omitSyntheticDisabledThinking(candidate, (payloadModel ?? effectiveModel)?.api);
    }
    if (needsPayloadTransform) {
      const transformed = applyModelPayloadTransforms(
        candidate,
        payloadModel ?? effectiveModel,
        customParams,
      );
      if (transformed !== candidate && isRecord(transformed)) {
        Object.assign(candidate, transformed);
      }
    }
    if (isKimiK3) {
      applyKimiK3PayloadContract(candidate);
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
        applyPostHooks(target, payloadModel);
        return resolved !== undefined ? target : undefined;
      });
    }
    const target = next !== undefined ? next : payload;
    applyPostHooks(target, payloadModel);
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
  const rawTargetApi = typeof model?.api === 'string' && model.api.trim().length > 0
    ? model.api.trim()
    : spec.api;
  const targetApi = protocols[rawTargetApi] ? rawTargetApi : normalizeProtocol(rawTargetApi);
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
