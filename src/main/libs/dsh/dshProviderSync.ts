// Pure translators converting LobsterAI's SQLite provider & MCP server
// configuration into the live in-memory payloads consumed by
// `@lobsterai/dsh-bundle` (`syncProviders` and `syncMcpServers`).
//
// Zero Electron imports — directly testable under Vitest.

import crypto from 'crypto';

import { DshMcpTransport } from '../../../shared/dshEngine/hostConstants';
import { type McpToolFilter, normalizeMcpToolFilter } from '../../../shared/mcp/toolFilter';
import {
  canonicalizeDshProviderId,
  findKimiK3ReservedCustomParamKeys,
  getModelRuntimeProfileDefinition,
  isCustomProviderKey,
  KIMI_K3_RUNTIME_PROFILE,
  LOBSTERAI_REQUEST_OPTIONS_VERSION,
  type LobsterAIRequestCapability,
  ModelRuntimeProfile,
  ModelRuntimeProfileSource,
  type ModelThinkingConfig,
  ModelThinkingLevel,
  OpenClawApi,
  OpenClawProviderId,
  OpenClawThinkingLevel,
  parseModelThinkingConfig,
  parseModelThinkingLevel,
  ProviderName,
  resolveModelRuntimeProfile,
  resolveOpenClawThinkingLevel,
  supportsLobsterAIRequestOptionsV1,
} from '../../../shared/providers';
import type { McpOAuthManager } from '../../mcp/mcpOAuthManager';
import { stripOpenAIEndpointSuffix } from '../providerSelection';
import type {
  DshHostMcpServerSpec,
  DshHostProviderModelSpec,
  DshHostProviderSpec,
} from './dshHostManager';

// Output cap for LobsterAI plan models whose server metadata carries no maxTokens.
// Plan models are reasoning-capable, so thinking counts against this budget.
const LOBSTERAI_SERVER_DEFAULT_MODEL_MAX_TOKENS = 32_768;
// Safe single-turn default output cap for Kimi K3 (matches K3 official API default
// while keeping `maxTokens: 1_048_576` as the model's catalog capacity).
const KIMI_K3_DEFAULT_REQUEST_MAX_TOKENS = 131_072;
const NON_OFF_THINKING_LEVELS = [
  ModelThinkingLevel.Minimal,
  ModelThinkingLevel.Low,
  ModelThinkingLevel.Medium,
  ModelThinkingLevel.High,
  ModelThinkingLevel.XHigh,
  ModelThinkingLevel.Max,
] as const;

export interface LobsterProviderModelConfig {
  id: string;
  name?: string;
  provider?: string;
  apiFormat?: 'anthropic' | 'openai' | 'openai-responses' | 'gemini' | 'google' | string;
  baseUrl?: string;
  baseURL?: string;
  supportsImage?: boolean;
  supportsThinking?: boolean;
  contextWindow?: number;
  contextWindows?: Array<{ id: string; label?: string; contextWindow: number }>;
  contextWindowDefault?: string;
  maxTokens?: number;
  reasoning?: boolean;
  runtimeProfile?: ModelRuntimeProfile;
  thinkingConfig?: ModelThinkingConfig;
  thinkingLevelMap?: Record<string, string | null>;
  requestCapabilities?: readonly LobsterAIRequestCapability[];
  customParams?: Record<string, unknown>;
  compat?: Record<string, unknown>;
}

export interface LobsterProviderConfig {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  apiFormat?: 'anthropic' | 'openai' | 'openai-responses' | 'gemini' | 'google' | string;
  headers?: Record<string, string>;
  models?: LobsterProviderModelConfig[];
  authType?: 'api_key' | 'oauth' | 'lobster_plan' | string;
}

export interface BuildDshProvidersOptions {
  providers: Record<string, LobsterProviderConfig>;
  /** Local unified model auth proxy origin (serves LobsterAI Plan, Copilot, Codex OAuth, xAI OAuth). */
  modelAuthProxyUrl?: string | null;
  /** Optional bearer secret for local modelAuthProxy calls. */
  modelAuthProxySecret?: string | null;
  /** Virtual model alias mapping (e.g. `yd-fast` -> `{ provider, model }`). */
  virtualAliases?: Record<string, { provider: string; model: string }>;
}

const LOBSTER_PLAN_PROXY_PROVIDERS = new Set<string>([
  'lobster',
  'lobsterai',
  ProviderName.LobsteraiServer,
  'youdao',
]);

const CONFIGURABLE_THINKING_KEYS: readonly ModelThinkingLevel[] = [
  ModelThinkingLevel.Minimal,
  ModelThinkingLevel.Low,
  ModelThinkingLevel.Medium,
  ModelThinkingLevel.High,
  ModelThinkingLevel.XHigh,
  ModelThinkingLevel.Max,
];

const isPositiveModelLimit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Clamp `maxTokens` so it never exceeds `contextWindow` (avoiding upstream 400
 * rejections for `max_tokens > context_window`).
 */
export function clampModelMaxTokens(
  rawMaxTokens: number | undefined,
  contextWindow: number | undefined,
): number | undefined {
  if (!isPositiveModelLimit(rawMaxTokens)) {
    return undefined;
  }
  if (!isPositiveModelLimit(contextWindow)) {
    return rawMaxTokens;
  }
  return Math.min(rawMaxTokens, contextWindow);
}

/**
 * Build a pi-ai `thinkingLevelMap` combining runtime profile rules (e.g. Kimi K3)
 * and server `ModelThinkingConfig` definitions.
 */
export function buildModelThinkingLevelMap(options: {
  thinkingConfig?: ModelThinkingConfig;
  runtimeProfile?: ModelRuntimeProfile;
  explicitMap?: Record<string, string | null>;
}): Record<string, string | null> | undefined {
  const profileMap = options.runtimeProfile
    ? getModelRuntimeProfileDefinition(options.runtimeProfile).thinkingLevelMap
    : undefined;

  let result: Record<string, string | null> | undefined;

  if (profileMap) {
    result = { ...profileMap };
  }

  if (options.thinkingConfig) {
    const map: Record<string, string | null> = {};
    const hasOffOption = options.thinkingConfig.options.some(
      (opt) => opt.level === ModelThinkingLevel.Off,
    );
    if (!hasOffOption) {
      map[ModelThinkingLevel.Off] = null;
    }
    const byProduct = new Map(
      options.thinkingConfig.options.map((opt) => [opt.level, opt.openclawLevel]),
    );
    const byWire = new Map(
      options.thinkingConfig.options.map((opt) => [opt.openclawLevel, opt.openclawLevel]),
    );

    for (const key of CONFIGURABLE_THINKING_KEYS) {
      const targetWire = byProduct.get(key) ?? byWire.get(key as OpenClawThinkingLevel);
      if (targetWire) {
        const profileWire = profileMap?.[targetWire];
        map[key] = typeof profileWire === 'string' ? profileWire : targetWire;
      } else {
        map[key] = null;
      }
    }
    result = map;
  }

  if (options.explicitMap && Object.keys(options.explicitMap).length > 0) {
    result = { ...(result ?? {}), ...options.explicitMap };
  }

  return result;
}

/**
 * Resolve a product `thinkingLevel` (`off`..`max`) into a DSH `reasoningEffort`
 * honoring `ModelThinkingConfig`, `KIMI_K3_RUNTIME_PROFILE.thinkingLevelMap`,
 * and mapping product `max` -> `xhigh` for standard models.
 */
export function resolveDshReasoningEffort(options: {
  thinkingLevel?: string | null;
  thinkingConfig?: ModelThinkingConfig;
  runtimeProfile?: ModelRuntimeProfile;
}): string | undefined {
  const raw = typeof options.thinkingLevel === 'string'
    ? options.thinkingLevel.trim().toLowerCase()
    : '';
  let level = parseModelThinkingLevel(raw);

  if (!level) {
    if (options.thinkingConfig?.defaultLevel) {
      level = options.thinkingConfig.defaultLevel;
    } else if (options.runtimeProfile === ModelRuntimeProfile.MoonshotKimiK3) {
      level = ModelThinkingLevel.Max;
    } else {
      return undefined;
    }
  }

  if (options.runtimeProfile === ModelRuntimeProfile.MoonshotKimiK3) {
    const mapped = KIMI_K3_RUNTIME_PROFILE.thinkingLevelMap[level];
    return typeof mapped === 'string' ? mapped : undefined;
  }

  if (options.thinkingConfig) {
    const mapped = resolveOpenClawThinkingLevel(options.thinkingConfig, level);
    if (mapped) return mapped;
    return resolveOpenClawThinkingLevel(options.thinkingConfig, options.thinkingConfig.defaultLevel);
  }

  if (level === ModelThinkingLevel.Max) {
    return OpenClawThinkingLevel.XHigh;
  }
  return level;
}

function mapApiFormat(
  providerId: string,
  apiFormat: string | undefined,
): DshHostProviderSpec['api'] {
  const fmt = (apiFormat ?? '').trim().toLowerCase();
  if (fmt === 'anthropic' || fmt === 'anthropic-messages') return 'anthropic-messages';
  if (fmt === 'openai-responses' || fmt === 'responses') return 'openai-responses';
  if (fmt === 'gemini' || fmt === 'google' || fmt === 'google-generative-ai') {
    return 'google-generative-ai';
  }
  if (providerId === ProviderName.Anthropic) return 'anthropic-messages';
  if (providerId === OpenClawProviderId.Google || providerId === ProviderName.Gemini) {
    return 'google-generative-ai';
  }
  return 'openai-completions';
}

function resolveProxyRouteSegment(
  rawId: string,
  canonicalId: string,
  cfg: LobsterProviderConfig,
): string | null {
  if (cfg.authType === 'lobster_plan' || LOBSTER_PLAN_PROXY_PROVIDERS.has(canonicalId)) {
    return canonicalId;
  }
  if (canonicalId === ProviderName.Copilot) {
    return ProviderName.Copilot;
  }
  if (
    rawId === OpenClawProviderId.OpenAICodex
    || (canonicalId === ProviderName.OpenAI && cfg.authType === 'oauth')
  ) {
    return OpenClawProviderId.OpenAICodex;
  }
  if (
    rawId === 'xai-oauth'
    || (canonicalId === ProviderName.Xai && cfg.authType === 'oauth')
  ) {
    return 'xai-oauth';
  }
  // MiniMax OAuth already resolves a direct oauthAccessToken + oauthBaseUrl in
  // claudeSettings.ts; never overwrite it to a non-existent `/v1/minimax` proxy path.
  if (canonicalId === ProviderName.Minimax && cfg.authType === 'oauth') {
    return null;
  }
  if (cfg.authType === 'oauth') {
    const hasDirectEndpoint = Boolean(cfg.baseUrl?.trim() && cfg.apiKey?.trim());
    return hasDirectEndpoint ? null : canonicalId;
  }
  return null;
}

function isNativeOpenAIEndpoint(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

function isMoonshotFamilyProvider(providerName: string | undefined): boolean {
  const normalized = providerName?.trim().toLowerCase() ?? '';
  return normalized === 'moonshot' || normalized === 'kimi' || normalized === 'kimi-coding';
}

function stripTrailingV1Segment(rawBaseUrl: string): string {
  const normalized = rawBaseUrl.trim().replace(/\/+$/, '');
  return normalized.endsWith('/v1')
    ? normalized.slice(0, -'/v1'.length).replace(/\/+$/, '') || normalized
    : normalized;
}

/**
 * Translate a server `thinkingConfig` into DSH / pi-ai's `thinkingLevelMap`
 * so `getSupportedThinkingLevels()` exposes the exact allowed product levels.
 */
export function buildDshThinkingLevelMap(
  thinkingConfig: ModelThinkingConfig,
): Partial<Record<ModelThinkingLevel, string | null>> {
  const allowed = new Set<ModelThinkingLevel>(
    thinkingConfig.options.map((option) => option.level),
  );
  const map: Partial<Record<ModelThinkingLevel, string | null>> = {};
  if (!allowed.has(ModelThinkingLevel.Off)) {
    map[ModelThinkingLevel.Off] = null;
  }
  for (const level of NON_OFF_THINKING_LEVELS) {
    map[level] = allowed.has(level) ? level : null;
  }
  return map;
}

function defaultBaseUrlForProvider(providerId: string): string | undefined {
  switch (providerId) {
    case ProviderName.OpenAI:
      return 'https://api.openai.com/v1';
    case ProviderName.Anthropic:
      return 'https://api.anthropic.com';
    case ProviderName.DeepSeek:
      return 'https://api.deepseek.com/v1';
    case OpenClawProviderId.Google:
    case ProviderName.Gemini:
      return 'https://generativelanguage.googleapis.com/v1beta';
    case ProviderName.Moonshot:
    case 'kimi':
      return 'https://api.moonshot.cn/v1';
    case ProviderName.Qwen:
    case 'dashscope':
      return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    case ProviderName.OpenRouter:
      return 'https://openrouter.ai/api/v1';
    default:
      return undefined;
  }
}

function sanitizeModelCustomParams(
  customParams: Record<string, unknown> | undefined,
  runtimeProfile: ModelRuntimeProfile | undefined,
): Record<string, unknown> | undefined {
  if (!customParams || typeof customParams !== 'object' || Array.isArray(customParams)) {
    return undefined;
  }
  const reserved = runtimeProfile === ModelRuntimeProfile.MoonshotKimiK3
    ? new Set<string>(findKimiK3ReservedCustomParamKeys(customParams))
    : null;
  const filtered = Object.fromEntries(
    Object.entries(customParams).filter(([key, value]) => value !== undefined && (!reserved || !reserved.has(key))),
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

/**
 * Convert LobsterAI `AppConfig.providers` into `DshHostProviderSpec[]` for
 * in-memory registration via `POST /api/lobsterai/ops` (`syncProviders`).
 *
 * Notice:
 * - Never writes API keys to disk.
 * - Routes OAuth & LobsterAI Plan providers through the local `modelAuthProxyUrl`
 *   so DSH `pi-ai` speaks standard OpenAI/Anthropic wire protocols while main
 *   handles token refresh, quota alerts, and enterprise headers.
 * - Avoids route ID collision with DSH's built-in `deepseek-official` adapter
 *   by mapping LobsterAI's provider IDs cleanly.
 */
export function buildDshProvidersPayload(options: BuildDshProvidersOptions): {
  providers: DshHostProviderSpec[];
  virtualAliases: Record<string, { provider: string; model: string }>;
} {
  const specs: DshHostProviderSpec[] = [];
  const specsById = new Map<string, DshHostProviderSpec>();
  const proxyUrl = options.modelAuthProxyUrl?.replace(/\/+$/, '') || '';

  for (const [rawKey, cfg] of Object.entries(options.providers ?? {})) {
    if (!cfg || cfg.enabled === false) continue;
    const rawId = rawKey.trim();
    if (!rawId) continue;

    const providerId = canonicalizeDshProviderId(rawId);
    if (!providerId) continue;

    // Avoid clashing with DSH's reserved built-in deepseek-official route.
    const routeId = providerId === 'deepseek-official' ? 'lobster-deepseek' : providerId;

    const proxySegment = resolveProxyRouteSegment(rawId, providerId, cfg);
    const usesProxy = Boolean(proxyUrl && proxySegment);
    const isCodexOAuth = proxySegment === OpenClawProviderId.OpenAICodex;
    const isLobsterPlanProvider =
      cfg.authType === 'lobster_plan'
      || providerId === OpenClawProviderId.LobsteraiServer;
    const isLobsterPlanProxy = Boolean(
      usesProxy && (cfg.authType === 'lobster_plan' || LOBSTER_PLAN_PROXY_PROVIDERS.has(providerId)),
    );

    const api = isCodexOAuth
      ? OpenClawApi.OpenAIResponses
      : mapApiFormat(providerId, cfg.apiFormat);

    const rawBaseURL = usesProxy
      ? `${proxyUrl}/v1/${encodeURIComponent(proxySegment!)}`
      : (cfg.baseUrl?.trim().replace(/\/+$/, '') || defaultBaseUrlForProvider(providerId));

    if (!rawBaseURL) continue;

    let baseURL = rawBaseURL;
    if (!usesProxy && api === OpenClawApi.AnthropicMessages) {
      baseURL = stripTrailingV1Segment(rawBaseURL);
    } else if (!usesProxy && (api === OpenClawApi.OpenAICompletions || api === OpenClawApi.OpenAIResponses)) {
      baseURL = stripOpenAIEndpointSuffix(rawBaseURL);
    }

    if (!baseURL) continue;

    const apiKey = usesProxy
      ? (options.modelAuthProxySecret || 'lobsterai-local-proxy')
      : (cfg.apiKey?.trim() || undefined);

    // Skip non-local remote providers that have neither an API key nor a proxy.
    const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(baseURL);
    if (!apiKey && !isLoopback) continue;

    const profileSource = isLobsterPlanProvider
      ? ModelRuntimeProfileSource.Server
      : isCustomProviderKey(providerId)
        ? ModelRuntimeProfileSource.Custom
        : ModelRuntimeProfileSource.BuiltIn;

    const models: DshHostProviderModelSpec[] = (cfg.models ?? [])
      .filter((m) => m && typeof m.id === 'string' && m.id.trim().length > 0)
      .map((m) => {
        const modelId = m.id.trim();
        const modelApi = m.apiFormat ? mapApiFormat(providerId, m.apiFormat) : api;
        const rawModelBaseUrl = (m.baseURL ?? m.baseUrl)?.trim().replace(/\/+$/, '') || undefined;
        let modelBaseURL: string | undefined;
        if (rawModelBaseUrl) {
          if (!usesProxy && modelApi === OpenClawApi.AnthropicMessages) {
            modelBaseURL = stripTrailingV1Segment(rawModelBaseUrl);
          } else if (modelApi === OpenClawApi.OpenAICompletions || modelApi === OpenClawApi.OpenAIResponses) {
            modelBaseURL = stripOpenAIEndpointSuffix(rawModelBaseUrl);
          } else {
            modelBaseURL = rawModelBaseUrl;
          }
        } else if (isLobsterPlanProxy && modelApi === OpenClawApi.AnthropicMessages) {
          // `@anthropic-ai/sdk` appends `/v1/messages` to `baseURL`, so Anthropic
          // models on `lobsterai-server` target the proxy origin directly.
          modelBaseURL = proxyUrl;
        }

        const runtimeProfile = resolveModelRuntimeProfile({
          source: profileSource,
          providerId,
          modelId,
          api: modelApi,
          serverRuntimeProfile: m.runtimeProfile,
        });
        const profileDef = runtimeProfile
          ? getModelRuntimeProfileDefinition(runtimeProfile)
          : undefined;

        const reasoning = profileDef
          ? profileDef.reasoning
          : Boolean(m.reasoning ?? m.supportsThinking);
        const thinkingConfig = reasoning
          ? parseModelThinkingConfig(m.thinkingConfig)
          : undefined;
        const hasRequestOptionsV1 = Boolean(
          thinkingConfig && supportsLobsterAIRequestOptionsV1(m.requestCapabilities),
        );

        const contextWindow = isPositiveModelLimit(m.contextWindow)
          ? m.contextWindow
          : profileDef?.contextWindow;
        const rawMaxTokens = profileDef?.maxTokens
          ?? (isPositiveModelLimit(m.maxTokens) ? m.maxTokens : undefined);
        const fallbackPlanMaxTokens = isLobsterPlanProvider && rawMaxTokens === undefined
          ? (contextWindow && contextWindow > 0
            ? Math.min(LOBSTERAI_SERVER_DEFAULT_MODEL_MAX_TOKENS, contextWindow)
            : LOBSTERAI_SERVER_DEFAULT_MODEL_MAX_TOKENS)
          : undefined;
        const maxTokens = clampModelMaxTokens(rawMaxTokens ?? fallbackPlanMaxTokens, contextWindow);
        const defaultMaxTokens = runtimeProfile === ModelRuntimeProfile.MoonshotKimiK3
          ? Math.min(
            KIMI_K3_DEFAULT_REQUEST_MAX_TOKENS,
            contextWindow && contextWindow > 0
              ? Math.max(1, Math.floor(contextWindow / 2))
              : KIMI_K3_DEFAULT_REQUEST_MAX_TOKENS,
          )
          : undefined;

        const baseThinkingLevelMap = profileDef
          ? { ...profileDef.thinkingLevelMap }
          : thinkingConfig
            ? buildDshThinkingLevelMap(thinkingConfig)
            : undefined;
        const thinkingLevelMap = m.thinkingLevelMap && Object.keys(m.thinkingLevelMap).length > 0
          ? { ...(baseThinkingLevelMap ?? {}), ...m.thinkingLevelMap }
          : baseThinkingLevelMap;
        const customParams = sanitizeModelCustomParams(m.customParams, runtimeProfile);

        const modelCompat: Record<string, unknown> = {
          ...(m.compat ?? {}),
        };
        if (profileDef) {
          Object.assign(modelCompat, profileDef.compat);
          if (modelApi === OpenClawApi.OpenAICompletions) {
            modelCompat.requiresReasoningContentOnAssistantMessages = true;
          }
        } else if (
          modelApi === OpenClawApi.OpenAICompletions
          && isMoonshotFamilyProvider(m.provider)
          && modelCompat.requiresReasoningContentOnAssistantMessages === undefined
        ) {
          modelCompat.requiresReasoningContentOnAssistantMessages = true;
        }
        if (
          hasRequestOptionsV1
          && modelApi === OpenClawApi.OpenAICompletions
          && modelCompat.supportsReasoningEffort === undefined
        ) {
          modelCompat.supportsReasoningEffort = true;
        }

        const supportsImage = profileDef
          ? profileDef.input.includes('image')
          : Boolean(m.supportsImage);

        const spec: DshHostProviderModelSpec = {
          id: modelId,
          name: m.name?.trim() || modelId,
          ...(modelApi !== api ? { api: modelApi } : {}),
          ...(modelBaseURL ? { baseURL: modelBaseURL } : {}),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(m.contextWindows?.length ? { contextWindows: m.contextWindows } : {}),
          ...(m.contextWindowDefault ? { contextWindowDefault: m.contextWindowDefault } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(defaultMaxTokens !== undefined ? { defaultMaxTokens } : {}),
          input: supportsImage ? ['text', 'image'] : ['text'],
          reasoning,
          ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
          ...(runtimeProfile ? { runtimeProfile } : {}),
          ...(hasRequestOptionsV1 && thinkingConfig
            ? {
                thinkingConfig,
                requestOptionsVersion: LOBSTERAI_REQUEST_OPTIONS_VERSION,
              }
            : {}),
          ...(customParams ? { customParams } : {}),
          ...(Object.keys(modelCompat).length > 0 ? { compat: modelCompat } : {}),
        };
        return spec;
      });

    if (models.length === 0) continue;

    const existingSpec = specsById.get(routeId);
    if (existingSpec) {
      for (const model of models) {
        if (!existingSpec.models.some((candidate) => candidate.id === model.id)) {
          existingSpec.models.push(model);
        }
      }
      continue;
    }

    const compat: Record<string, unknown> = {};
    if (api === OpenClawApi.OpenAICompletions) {
      if (!isNativeOpenAIEndpoint(baseURL)) {
        // pi-ai auto-enables supportsDeveloperRole and supportsStore for any
        // openai-completions URL outside its small built-in non-standard list.
        // Reasoning models then send system prompts with `role: "developer"`,
        // which OpenAI-compatible gateways (including lobsterai-server / Qwen /
        // custom proxies) reject.
        compat.supportsDeveloperRole = false;
        compat.supportsStore = false;
      }
      // Kimi / Moonshot thinking compatibility in OpenAI-compat mode.
      if (isMoonshotFamilyProvider(providerId)) {
        compat.requiresReasoningContentOnAssistantMessages = true;
      }
    }

    const providerSpec: DshHostProviderSpec = {
      id: routeId,
      displayName: routeId,
      api,
      baseURL,
      ...(apiKey ? { apiKey } : {}),
      ...(cfg.headers && Object.keys(cfg.headers).length > 0 ? { headers: cfg.headers } : {}),
      ...(Object.keys(compat).length > 0 ? { compat } : {}),
      models,
    };
    specsById.set(routeId, providerSpec);
    specs.push(providerSpec);
  }

  const virtualAliases: Record<string, { provider: string; model: string }> = {};
  for (const [alias, target] of Object.entries(options.virtualAliases ?? {})) {
    if (!target || typeof target.provider !== 'string' || typeof target.model !== 'string') continue;
    virtualAliases[alias] = {
      provider: canonicalizeDshProviderId(target.provider),
      model: target.model,
    };
  }

  return {
    providers: specs,
    virtualAliases,
  };
}

export interface LobsterMcpServerRecord {
  id: string;
  name: string;
  enabled: boolean;
  transportType: 'stdio' | 'sse' | 'http' | 'streamable-http' | string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  oauthEnabled?: boolean;
  toolFilter?: McpToolFilter;
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

const DSH_MCP_SERVER_NAME_MAX_LENGTH = 32;
const DSH_MCP_NAME_HASH_LENGTH = 8;
const DSH_MCP_MAX_TIMEOUT_MS = 2_147_483_647;

// Mirrors `@deepseek-ai/dsh-mcp-client` (`templates.ts`): any `${...}` token
// that is not strictly `${credential:<IDENT>}` throws during `mcpManager.register`.
// DSH does not support template escaping (even `$${...}` still matches SUSPECT).
const DSH_TEMPLATE_SUSPECT_RE = /\$\{[^}]*\}/g;
const DSH_CREDENTIAL_TOKEN_EXACT_RE = /^\$\{credential:[A-Za-z_][A-Za-z0-9_]*\}$/;

/**
 * Map a LobsterAI MCP transport type (`stdio`, `sse`, `http`, `streamable-http`)
 * to the DSH host transport discriminant, preserving legacy `sse` instead of
 * coercing it to `streamable-http`.
 */
export function resolveDshMcpTransport(transportType: string): DshMcpTransport {
  const normalized = transportType.trim().toLowerCase();
  if (normalized === DshMcpTransport.Stdio) return DshMcpTransport.Stdio;
  if (normalized === DshMcpTransport.Sse) return DshMcpTransport.Sse;
  return DshMcpTransport.StreamableHttp;
}

function shortStableHash(input: string, length = DSH_MCP_NAME_HASH_LENGTH): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, length);
}

function withStableHashSuffix(base: string, seed: string): string {
  const suffix = shortStableHash(seed, DSH_MCP_NAME_HASH_LENGTH);
  const maxPrefixLength = DSH_MCP_SERVER_NAME_MAX_LENGTH - suffix.length - 1;
  const prefix = base.slice(0, maxPrefixLength).replace(/[-_]+$/, '') || 'mcp';
  return `${prefix}-${suffix}`;
}

function normalizeDshTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return undefined;
  }
  return Math.min(Math.floor(value), DSH_MCP_MAX_TIMEOUT_MS);
}

function validateRemoteMcpUrl(rawUrl: string | undefined): string | null {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Inspect a string against `@deepseek-ai/dsh-mcp-client`'s `assertTemplateSyntax`
 * rules. Returns the first offending `${...}` occurrence or `null` when valid.
 */
export function findInvalidDshTemplateToken(value: string): string | null {
  for (const match of value.matchAll(DSH_TEMPLATE_SUSPECT_RE)) {
    if (!DSH_CREDENTIAL_TOKEN_EXACT_RE.test(match[0])) {
      return match[0];
    }
  }
  return null;
}

function findInvalidTemplateField(spec: DshHostMcpServerSpec): string | null {
  if (spec.transport === DshMcpTransport.Stdio) {
    if (spec.command && findInvalidDshTemplateToken(spec.command)) return 'command';
    for (const [index, arg] of (spec.args ?? []).entries()) {
      if (findInvalidDshTemplateToken(arg)) return `args[${index}]`;
    }
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      if (findInvalidDshTemplateToken(value)) return `env.${key}`;
    }
    if (spec.cwd && findInvalidDshTemplateToken(spec.cwd)) return 'cwd';
    return null;
  }
  if (spec.url && findInvalidDshTemplateToken(spec.url)) return 'url';
  for (const [key, value] of Object.entries(spec.headers ?? {})) {
    if (findInvalidDshTemplateToken(value)) return `headers.${key}`;
  }
  return null;
}

/**
 * Sanitize an arbitrary LobsterAI MCP server name into DSH's strict
 * `SERVER_NAME_PATTERN` (`/^[A-Za-z0-9_-]{1,32}$/`).
 *
 * - Pure non-ASCII names (e.g. `高德地图`, `百度地图`) derive a deterministic
 *   `mcp-<sha256-8>` identifier from `fallbackSeed || raw` so they never collide.
 * - Names exceeding 32 characters are cleanly truncated with a deterministic
 *   8-character SHA-256 suffix while staying within 32 characters.
 */
export function normalizeDshMcpServerName(raw: string, fallbackSeed?: string): string {
  const trimmed = raw.trim();
  const cleaned = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');

  if (!cleaned) {
    const seed = fallbackSeed?.trim() || trimmed;
    if (!seed) return 'mcp-server';
    return `mcp-${shortStableHash(seed, DSH_MCP_NAME_HASH_LENGTH)}`;
  }

  if (cleaned.length <= DSH_MCP_SERVER_NAME_MAX_LENGTH) {
    return cleaned;
  }

  const truncationSeed = fallbackSeed?.trim() ? `${trimmed}:${fallbackSeed.trim()}` : trimmed;
  return withStableHashSuffix(cleaned, truncationSeed);
}

/**
 * Convert LobsterAI SQLite `mcp_servers` records into `DshHostMcpServerSpec[]`
 * with OAuth bearer headers dynamically resolved through `McpOAuthManager`.
 */
export async function buildDshMcpServerSpecs(
  records: LobsterMcpServerRecord[],
  oauthManager?: Pick<McpOAuthManager, 'resolveAuthorizationHeaders'>,
): Promise<{
  servers: DshHostMcpServerSpec[];
  needsReauthIds: string[];
  warnings: string[];
  namesById: Map<string, string>;
}> {
  const servers: DshHostMcpServerSpec[] = [];
  const needsReauthIds: string[] = [];
  const warnings: string[] = [];
  const usedNames = new Set<string>();
  const namesById = new Map<string, string>();

  const recordWarning = (message: string): void => {
    warnings.push(message);
    console.warn(`[DSH:MCP] ${message}`);
  };

  const reserveUniqueName = (rec: LobsterMcpServerRecord): string => {
    const baseSeed = rec.id.trim() || rec.name.trim() || String(usedNames.size);
    let candidate = normalizeDshMcpServerName(rec.name || rec.id, rec.id);
    if (usedNames.has(candidate)) {
      candidate = withStableHashSuffix(candidate, baseSeed);
      let attempt = 2;
      while (usedNames.has(candidate)) {
        candidate = withStableHashSuffix(candidate, `${baseSeed}:${attempt}`);
        attempt += 1;
      }
    }
    usedNames.add(candidate);
    namesById.set(rec.id, candidate);
    return candidate;
  };

  for (const rec of records) {
    if (!rec.enabled) continue;
    const label = rec.name || rec.id || '<unnamed>';
    const toolCallTimeoutMs = normalizeDshTimeoutMs(rec.requestTimeoutMs);
    const startupTimeoutMs = normalizeDshTimeoutMs(rec.connectionTimeoutMs);
    const timeoutFields = {
      ...(startupTimeoutMs !== undefined ? { startupTimeoutMs } : {}),
      ...(toolCallTimeoutMs !== undefined ? { toolCallTimeoutMs } : {}),
    };
    const toolFilter = normalizeMcpToolFilter(rec.toolFilter);

    const transport = resolveDshMcpTransport(rec.transportType);
    if (transport === DshMcpTransport.Stdio) {
      if (!rec.command) continue;
      const draft: DshHostMcpServerSpec = {
        name: 'placeholder',
        enabled: true,
        transport: DshMcpTransport.Stdio,
        command: rec.command,
        args: rec.args ?? [],
        env: rec.env ?? {},
        ...(rec.cwd ? { cwd: rec.cwd } : {}),
        ...(toolFilter ? { toolFilter } : {}),
        ...timeoutFields,
      };
      const invalidField = findInvalidTemplateField(draft);
      if (invalidField) {
        recordWarning(
          `Skipping stdio MCP server "${label}": field "${invalidField}" contains unsupported \${...} syntax rejected by DSH (only \${credential:REF} is permitted).`,
        );
        continue;
      }
      draft.name = reserveUniqueName(rec);
      servers.push(draft);
      continue;
    }

    const validatedUrl = validateRemoteMcpUrl(rec.url);
    if (!validatedUrl) {
      if (rec.url) {
        recordWarning(
          `Skipping remote MCP server "${label}": malformed or unsupported URL (expected absolute http/https URL).`,
        );
      }
      continue;
    }

    const headers: Record<string, string> = { ...(rec.headers ?? {}) };
    if (rec.oauthEnabled && oauthManager) {
      try {
        const authHeaders = await oauthManager.resolveAuthorizationHeaders(rec.id);
        if (authHeaders) {
          for (const existingKey of Object.keys(headers)) {
            if (existingKey.toLowerCase() === 'authorization') {
              delete headers[existingKey];
            }
          }
          Object.assign(headers, authHeaders);
        } else {
          needsReauthIds.push(rec.id);
          continue;
        }
      } catch {
        needsReauthIds.push(rec.id);
        continue;
      }
    }

    const draft: DshHostMcpServerSpec = {
      name: 'placeholder',
      enabled: true,
      transport,
      url: validatedUrl,
      headers,
      ...(toolFilter ? { toolFilter } : {}),
      ...timeoutFields,
    };
    const invalidField = findInvalidTemplateField(draft);
    if (invalidField) {
      recordWarning(
        `Skipping remote MCP server "${label}": field "${invalidField}" contains unsupported \${...} syntax rejected by DSH (only \${credential:REF} is permitted).`,
      );
      continue;
    }
    draft.name = reserveUniqueName(rec);
    servers.push(draft);
  }

  return { servers, needsReauthIds, warnings, namesById };
}
