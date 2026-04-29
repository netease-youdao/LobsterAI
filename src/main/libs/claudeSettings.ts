import { type ApiFormat,type ProviderConfig, ProviderName, ProviderRegistry, resolveCodingPlanBaseUrl } from '../../shared/providers';
import type { SqliteStore } from '../sqliteStore';
import type { CoworkApiConfig } from './coworkConfigStore';
import { type AnthropicApiFormat,normalizeProviderApiFormat } from './coworkFormatTransform';
import {
  configureCoworkOpenAICompatProxy,
  getCoworkOpenAICompatProxyBaseURL,
  getCoworkOpenAICompatProxyStatus,
  type OpenAICompatProxyTarget,
} from './coworkOpenAICompatProxy';
import { readOpenAICodexAuthFile } from './openaiCodexAuth';

type LocalProviderConfig = Omit<ProviderConfig, 'apiFormat'> & { apiFormat?: ApiFormat | 'native' };

const gwDiagTs = (): string => {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const tz = d.getTimezoneOffset();
  const sign = tz <= 0 ? '+' : '-';
  const abs = Math.abs(tz);
  return `[GW-RESTART-DIAG] ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
};

type AppConfig = {
  model?: {
    defaultModel?: string;
    defaultModelProvider?: string;
  };
  providers?: Record<string, LocalProviderConfig>;
};

type ProviderModelConfig = {
  id: string;
  name: string;
  supportsImage?: boolean;
};

type ProviderModelInputConfig = {
  id: string;
  name?: string;
  supportsImage?: boolean;
};

export type ApiConfigResolution = {
  config: CoworkApiConfig | null;
  error?: string;
  providerMetadata?: {
    providerName: string;
    authType?: ProviderConfig['authType'];
    codingPlanEnabled: boolean;
    supportsImage?: boolean;
    modelName?: string;
  };
};

// Store getter function injected from main.ts
let storeGetter: (() => SqliteStore | null) | null = null;

export function setStoreGetter(getter: () => SqliteStore | null): void {
  storeGetter = getter;
}

// Auth token getter injected from main.ts for server model provider
let authTokensGetter: (() => { accessToken: string; refreshToken: string } | null) | null = null;

export function setAuthTokensGetter(getter: () => { accessToken: string; refreshToken: string } | null): void {
  authTokensGetter = getter;
}

// Server base URL getter injected from main.ts
let serverBaseUrlGetter: (() => string) | null = null;

export function setServerBaseUrlGetter(getter: () => string): void {
  serverBaseUrlGetter = getter;
}

// Cached server model metadata (populated when auth:getModels is called)
// Keyed by modelId → { supportsImage }
let serverModelMetadataCache: Map<string, { supportsImage?: boolean }> = new Map();

const serializeServerModelMetadata = (
  models: Array<{ modelId: string; supportsImage?: boolean }>,
): string => JSON.stringify(
  models
    .map((model) => ({
      modelId: model.modelId,
      supportsImage: model.supportsImage,
    }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId)),
);

export function updateServerModelMetadata(models: Array<{ modelId: string; supportsImage?: boolean }>): boolean {
  const previous = serializeServerModelMetadata(getAllServerModelMetadata());
  const nextCache = new Map(models.map(m => [m.modelId, { supportsImage: m.supportsImage }]));
  const next = serializeServerModelMetadata(Array.from(nextCache.entries()).map(([modelId, meta]) => ({
    modelId,
    supportsImage: meta.supportsImage,
  })));
  serverModelMetadataCache = nextCache;
  return previous !== next;
}

export function clearServerModelMetadata(): void {
  serverModelMetadataCache.clear();
}

export function getAllServerModelMetadata(): Array<{ modelId: string; supportsImage?: boolean }> {
  return Array.from(serverModelMetadataCache.entries()).map(([modelId, meta]) => ({
    modelId,
    supportsImage: meta.supportsImage,
  }));
}

function buildServerFallbackModels(effectiveModelId: string): NonNullable<LocalProviderConfig['models']> {
  const models = getAllServerModelMetadata().map((model) => ({
    id: model.modelId,
    name: model.modelId,
    supportsImage: model.supportsImage,
  }));

  if (!models.some(model => model.id === effectiveModelId)) {
    const cachedMeta = serverModelMetadataCache.get(effectiveModelId);
    models.unshift({
      id: effectiveModelId,
      name: effectiveModelId,
      supportsImage: cachedMeta?.supportsImage,
    });
  }

  return models;
}

function normalizeProviderModels(providerName: string, models?: ProviderModelInputConfig[]): ProviderModelConfig[] {
  return (models ?? [])
    .filter(model => model.id?.trim())
    .map(model => ({
      ...model,
      name: model.name || model.id,
      supportsImage: ProviderRegistry.resolveModelSupportsImage(
        providerName,
        model.id,
        model.supportsImage,
      ),
    }));
}

const getStore = (): SqliteStore | null => {
  if (!storeGetter) {
    return null;
  }
  return storeGetter();
};

type MatchedProvider = {
  providerName: string;
  providerConfig: LocalProviderConfig;
  modelId: string;
  apiFormat: AnthropicApiFormat;
  baseURL: string;
  supportsImage?: boolean;
  modelName?: string;
};

function getEffectiveProviderApiFormat(providerName: string, apiFormat: unknown): AnthropicApiFormat {
  if (providerName === ProviderName.OpenAI || providerName === ProviderName.Gemini || providerName === ProviderName.StepFun || providerName === ProviderName.Youdaozhiyun || providerName === ProviderName.Copilot) {
    return 'openai';
  }
  if (providerName === ProviderName.Anthropic) {
    return 'anthropic';
  }
  return normalizeProviderApiFormat(apiFormat);
}

function providerRequiresApiKey(providerName: string): boolean {
  return providerName !== ProviderName.Ollama && providerName !== ProviderName.LmStudio;
}

function shouldUseOpenAICodexOAuth(providerName: string, providerConfig: LocalProviderConfig): boolean {
  if (providerName !== ProviderName.OpenAI) {
    return false;
  }
  if (providerConfig.authType === 'oauth') {
    return true;
  }
  if (providerConfig.apiKey?.trim()) {
    return false;
  }
  return readOpenAICodexAuthFile() !== null;
}

function tryLobsteraiServerFallback(modelId?: string): MatchedProvider | null {
  const tokens = authTokensGetter?.();
  const serverBaseUrl = serverBaseUrlGetter?.();
  if (!tokens?.accessToken || !serverBaseUrl) return null;
  const effectiveModelId = modelId?.trim() || '';
  if (!effectiveModelId) return null;
  const baseURL = `${serverBaseUrl}/api/proxy/v1`;
  const cachedMeta = serverModelMetadataCache.get(effectiveModelId);
  console.log('[ClaudeSettings] lobsterai-server fallback activated:', { baseURL, modelId: effectiveModelId, supportsImage: cachedMeta?.supportsImage });
  return {
    providerName: ProviderName.LobsteraiServer,
    providerConfig: { enabled: true, apiKey: tokens.accessToken, baseUrl: baseURL, apiFormat: 'openai', models: buildServerFallbackModels(effectiveModelId) },
    modelId: effectiveModelId,
    apiFormat: 'openai',
    baseURL,
    supportsImage: cachedMeta?.supportsImage,
  };
}

function resolveMatchedProvider(appConfig: AppConfig): { matched: MatchedProvider | null; error?: string } {
  const providers = appConfig.providers ?? {};

  const resolveFallbackModel = (): {
    providerName: string;
    providerConfig: LocalProviderConfig;
    modelId: string;
  } | null => {
    for (const [providerName, providerConfig] of Object.entries(providers)) {
      if (!providerConfig?.enabled || !providerConfig.models || providerConfig.models.length === 0) {
        continue;
      }
      const fallbackModel = providerConfig.models.find((model) => model.id?.trim());
      if (!fallbackModel) {
        continue;
      }
      return {
        providerName,
        providerConfig,
        modelId: fallbackModel.id.trim(),
      };
    }
    return null;
  };

  const configuredModelId = appConfig.model?.defaultModel?.trim();
  let modelId = configuredModelId || '';
  if (!modelId) {
    const fallback = resolveFallbackModel();
    if (!fallback) {
      const serverFallback = tryLobsteraiServerFallback(configuredModelId);
      if (serverFallback) return { matched: serverFallback };
      return { matched: null, error: 'No available model configured in enabled providers.' };
    }
    modelId = fallback.modelId;
  }

  let providerEntry: [string, LocalProviderConfig] | undefined;
  const preferredProviderName = appConfig.model?.defaultModelProvider?.trim();

  // Handle lobsterai-server provider: dynamically construct from auth tokens
  if (preferredProviderName === ProviderName.LobsteraiServer) {
    const serverMatch = tryLobsteraiServerFallback(modelId);
    if (serverMatch) {
      return { matched: serverMatch };
    }
  }

  if (preferredProviderName) {
    const preferredProvider = providers[preferredProviderName];
    if (
      preferredProvider?.enabled
      && preferredProvider.models?.some((model) => model.id === modelId)
    ) {
      providerEntry = [preferredProviderName, preferredProvider];
    }
  }

  if (!providerEntry) {
    providerEntry = Object.entries(providers).find(([, provider]) => {
      if (!provider?.enabled || !provider.models) {
        return false;
      }
      return provider.models.some((model) => model.id === modelId);
    });
  }

  if (!providerEntry) {
    const fallback = resolveFallbackModel();
    if (fallback) {
      modelId = fallback.modelId;
      providerEntry = [fallback.providerName, fallback.providerConfig];
    } else {
      const serverFallback = tryLobsteraiServerFallback(modelId);
      if (serverFallback) return { matched: serverFallback };
      return { matched: null, error: `No enabled provider found for model: ${modelId}` };
    }
  }

  const [providerName, storedProviderConfig] = providerEntry;
  const providerConfig = shouldUseOpenAICodexOAuth(providerName, storedProviderConfig)
    ? { ...storedProviderConfig, authType: 'oauth' as const }
    : storedProviderConfig;
  const normalizedProviderModels = normalizeProviderModels(providerName, providerConfig.models);

  // MiniMax OAuth mode guard: if OAuth is selected but login has not been completed
  // (no access token), do not use the stale API key as an OAuth token.
  if (providerName === ProviderName.Minimax && (providerConfig as any).authType === 'oauth' && !(providerConfig as any).oauthAccessToken) {
    const serverFallback = tryLobsteraiServerFallback(modelId);
    if (serverFallback) return { matched: serverFallback };
    return { matched: null, error: 'MiniMax OAuth mode selected but login not completed.' };
  }

  let apiFormat = getEffectiveProviderApiFormat(providerName, providerConfig.apiFormat);
  let baseURL = providerConfig.baseUrl?.trim();

  if (providerConfig.codingPlanEnabled) {
    const resolved = resolveCodingPlanBaseUrl(providerName, true, apiFormat, baseURL ?? '');
    baseURL = resolved.baseUrl;
    apiFormat = resolved.effectiveFormat;
  }

  if (!baseURL) {
    const serverFallback = tryLobsteraiServerFallback(modelId);
    if (serverFallback) return { matched: serverFallback };
    return { matched: null, error: `Provider ${providerName} is missing base URL.` };
  }

   // Check for API key or OAuth credentials
  const hasApiKey = providerConfig.apiKey?.trim();
  const hasOAuthCreds =
    (providerName === ProviderName.Minimax && (providerConfig as any).authType === 'oauth' && !!(providerConfig as any).oauthAccessToken?.trim())
    || shouldUseOpenAICodexOAuth(providerName, providerConfig);
  if (apiFormat === 'anthropic' && providerRequiresApiKey(providerName) && !providerConfig.apiKey?.trim() && !hasApiKey && !hasOAuthCreds) {
    const serverFallback = tryLobsteraiServerFallback(modelId);
    if (serverFallback) return { matched: serverFallback };
    return { matched: null, error: `Provider ${providerName} requires API key for Anthropic-compatible mode.` };
  }

  const matchedModel = normalizedProviderModels.find((m) => m.id === modelId);

  return {
    matched: {
      providerName,
      providerConfig: {
        ...providerConfig,
        models: normalizedProviderModels,
      },
      modelId,
      apiFormat,
      baseURL,
      supportsImage: matchedModel?.supportsImage,
      modelName: matchedModel?.name,
    },
  };
}

export function resolveCurrentApiConfig(target: OpenAICompatProxyTarget = 'local'): ApiConfigResolution {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    return {
      config: null,
      error: 'Store is not initialized.',
    };
  }

  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig) {
    return {
      config: null,
      error: 'Application config not found.',
    };
  }

  const { matched, error } = resolveMatchedProvider(appConfig);
  if (!matched) {
    return {
      config: null,
      error,
    };
  }

  const resolvedBaseURL = matched.baseURL;
  let resolvedApiKey = matched.providerConfig.apiKey?.trim() || '';

  // Providers that don't require auth (e.g. Ollama) still need a non-empty
  // placeholder so downstream components (OpenClaw gateway, compat proxy)
  // don't reject the request with "No API key found for provider".
  const effectiveApiKey = resolvedApiKey
    || (!providerRequiresApiKey(matched.providerName) ? 'sk-lobsterai-local' : '');

  if (matched.apiFormat === 'anthropic') {
    return {
      config: {
        apiKey: effectiveApiKey,
        baseURL: resolvedBaseURL,
        model: matched.modelId,
        apiType: 'anthropic',
      },
      providerMetadata: {
        providerName: matched.providerName,
        codingPlanEnabled: !!matched.providerConfig.codingPlanEnabled,
        supportsImage: matched.supportsImage,
      },
    };
  }

  const proxyStatus = getCoworkOpenAICompatProxyStatus();
  if (!proxyStatus.running) {
    return {
      config: null,
      error: 'OpenAI compatibility proxy is not running.',
    };
  }

  configureCoworkOpenAICompatProxy({
    baseURL: resolvedBaseURL,
    apiKey: resolvedApiKey || undefined,
    model: matched.modelId,
    provider: matched.providerName,
  });

  const proxyBaseURL = getCoworkOpenAICompatProxyBaseURL(target);
  if (!proxyBaseURL) {
    return {
      config: null,
      error: 'OpenAI compatibility proxy base URL is unavailable.',
    };
  }

  return {
    config: {
      apiKey: resolvedApiKey || 'lobsterai-openai-compat',
      baseURL: proxyBaseURL,
      model: matched.modelId,
      apiType: 'openai',
    },
    providerMetadata: {
      providerName: matched.providerName,
      codingPlanEnabled: !!matched.providerConfig.codingPlanEnabled,
    },
  };
}

export function getCurrentApiConfig(target: OpenAICompatProxyTarget = 'local'): CoworkApiConfig | null {
  return resolveCurrentApiConfig(target).config;
}

/**
 * Resolve the raw API config directly from the app config,
 * without requiring the OpenAI compatibility proxy.
 * Used by OpenClaw config sync which has its own model routing.
 */
export function resolveRawApiConfig(): ApiConfigResolution {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    console.debug('[ClaudeSettings] resolveRawApiConfig: store is null, storeGetter not set yet');
    return { config: null, error: 'Store is not initialized.' };
  }
  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig) {
    console.debug('[ClaudeSettings] resolveRawApiConfig: app_config not found in store');
    return { config: null, error: 'Application config not found.' };
  }
  const { matched, error } = resolveMatchedProvider(appConfig);
  if (!matched) {
    const providerKeys = Object.keys(appConfig.providers ?? {});
    const defaultModel = appConfig.model?.defaultModel;
    const defaultProvider = appConfig.model?.defaultModelProvider;
    console.debug(`[ClaudeSettings] resolveRawApiConfig: no matched provider, error=${error}, providers=[${providerKeys.join(',')}], defaultModel=${defaultModel}, defaultProvider=${defaultProvider}`);
    return { config: null, error };
  }
  let apiKey = matched.providerConfig.apiKey?.trim() || '';
  let effectiveBaseURL = matched.baseURL;
  let effectiveApiFormat = matched.apiFormat;

  // Handle MiniMax OAuth: use oauthAccessToken and oauthBaseUrl (independent of apiKey)
  if (matched.providerName === ProviderName.Minimax && (matched.providerConfig as any).authType === 'oauth') {
    const oauthToken = (matched.providerConfig as any).oauthAccessToken?.trim();
    const oauthBaseUrl = (matched.providerConfig as any).oauthBaseUrl?.trim();
    if (oauthToken) {
      apiKey = oauthToken;
      if (oauthBaseUrl) effectiveBaseURL = oauthBaseUrl;
      effectiveApiFormat = 'anthropic';
    }
  }

  console.log('[ClaudeSettings] resolved raw API config:', JSON.stringify({
    ...matched,
    providerConfig: { ...matched.providerConfig, apiKey: apiKey ? '***' : '' },
  }));
  // OpenClaw's gateway requires a non-empty apiKey for every provider — even
  // local servers (Ollama, vLLM, etc.) that don't enforce auth.  When the user
  // leaves the key blank we supply a placeholder so the gateway doesn't reject
  // the request with "No API key found for provider".
  const effectiveApiKey = apiKey
    || (!providerRequiresApiKey(matched.providerName) ? 'sk-lobsterai-local' : '');
  return {
    config: {
      apiKey: effectiveApiKey,
      baseURL: effectiveBaseURL,
      model: matched.modelId,
      apiType: effectiveApiFormat === 'anthropic' ? 'anthropic' : 'openai',
    },
    providerMetadata: {
      providerName: matched.providerName,
      authType: matched.providerConfig.authType,
      codingPlanEnabled: !!matched.providerConfig.codingPlanEnabled,
      supportsImage: matched.supportsImage,
      modelName: matched.modelName,
    },
  };
}

  /**
   * Collect apiKeys for ALL configured providers (not just the currently selected one).
   * Used by OpenClaw config sync to pre-register all apiKeys as env vars at gateway
   * startup, so switching between providers doesn't require a process restart.
   *
   * Returns a map of env-var-safe provider name → apiKey.
   */
export function resolveAllProviderApiKeys(): Record<string, string> {
  const result: Record<string, string> = {};

  // lobsterai-server token is now managed by the token proxy
  // (openclawTokenProxy.ts) — no longer injected as an env var.

    // lobsterai-server: uses auth accessToken
    const tokens = authTokensGetter?.();
    const serverBaseUrl = serverBaseUrlGetter?.();
    if (tokens?.accessToken && serverBaseUrl) {
      result.SERVER = tokens.accessToken;
    }

    // All configured custom providers
    const sqliteStore = getStore();
    if (!sqliteStore) return result;
    const appConfig = sqliteStore.get<AppConfig>('app_config');
    if (!appConfig?.providers) return result;

    for (const [providerName, providerConfig] of Object.entries(appConfig.providers)) {
      if (!providerConfig?.enabled) continue;
      if (shouldUseOpenAICodexOAuth(providerName, providerConfig)) {
        continue;
      }
      // For MiniMax OAuth, inject oauthAccessToken instead of apiKey
      let apiKey = providerConfig.apiKey?.trim();
      if (providerName === ProviderName.Minimax && (providerConfig as any).authType === 'oauth') {
        const oauthToken = (providerConfig as any).oauthAccessToken?.trim();
        if (!oauthToken) continue; // OAuth not completed, skip
        apiKey = oauthToken;
      } else if (!apiKey && providerRequiresApiKey(providerName)) {
        continue;
      }
      const envName = providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      result[envName] = apiKey || 'sk-lobsterai-local';
    }

    const D = gwDiagTs;
    console.log(`${D()} resolveAllProviderApiKeys: hasServer=${!!result.SERVER} providers=[${Object.keys(result).filter(k => k !== 'SERVER').join(',')}]`);

    return result;
  }
  

export function buildEnvForConfig(config: CoworkApiConfig): Record<string, string> {
  const baseEnv = { ...process.env } as Record<string, string>;

  baseEnv.ANTHROPIC_AUTH_TOKEN = config.apiKey;
  baseEnv.ANTHROPIC_API_KEY = config.apiKey;
  baseEnv.ANTHROPIC_BASE_URL = config.baseURL;
  baseEnv.ANTHROPIC_MODEL = config.model;
  return baseEnv;
}

export type ProviderRawConfig = {
  providerName: string;
  baseURL: string;
  apiKey: string;
  apiType: 'anthropic' | 'openai';
  authType?: ProviderConfig['authType'];
  codingPlanEnabled: boolean;
  models: ProviderModelConfig[];
};

export function resolveAllEnabledProviderConfigs(): ProviderRawConfig[] {
  const sqliteStore = getStore();
  if (!sqliteStore) return [];
  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig?.providers) return [];

  const result: ProviderRawConfig[] = [];

  for (const [providerName, providerConfig] of Object.entries(appConfig.providers)) {
    if (!providerConfig?.enabled) continue;
    if (providerName === ProviderName.LobsteraiServer) continue;

    // When minimax is in OAuth mode, use oauthAccessToken and oauthBaseUrl
    // (independent from the user's manually entered apiKey/baseUrl).
    // This must come before the apiKey emptiness check below.
    if (providerName === ProviderName.Minimax && (providerConfig as any).authType === 'oauth') {
      const oauthToken = (providerConfig as any).oauthAccessToken?.trim();
      if (!oauthToken) continue; // OAuth not completed, skip
      const oauthBaseUrl = ((providerConfig as any).oauthBaseUrl?.trim()) || providerConfig.baseUrl?.trim() || '';
      if (!oauthBaseUrl) continue;
      const models = normalizeProviderModels(providerName, providerConfig.models);
      if (models.length === 0) continue;
      result.push({
        providerName,
        baseURL: oauthBaseUrl,
        apiKey: oauthToken,
        apiType: 'anthropic',
        authType: providerConfig.authType,
        codingPlanEnabled: false,
        models,
      });
      continue;
    }

    if (shouldUseOpenAICodexOAuth(providerName, providerConfig)) {
      const baseURL = providerConfig.baseUrl?.trim() || 'https://api.openai.com/v1';
      const models = normalizeProviderModels(providerName, providerConfig.models);
      if (models.length === 0) continue;
      result.push({
        providerName,
        baseURL,
        apiKey: '',
        apiType: 'openai',
        authType: 'oauth',
        codingPlanEnabled: false,
        models,
      });
      continue;
    }

    const apiKey = providerConfig.apiKey?.trim() || '';
    if (!apiKey && providerRequiresApiKey(providerName)) continue;

    const baseURL = providerConfig.baseUrl?.trim() || '';

    let effectiveBaseURL = baseURL;
    let effectiveApiFormat = getEffectiveProviderApiFormat(providerName, providerConfig.apiFormat);

    if (providerConfig.codingPlanEnabled) {
      const resolved = resolveCodingPlanBaseUrl(providerName, true, effectiveApiFormat, effectiveBaseURL);
      effectiveBaseURL = resolved.baseUrl;
      effectiveApiFormat = resolved.effectiveFormat;
    }

    if (!effectiveBaseURL) continue;

    const models = normalizeProviderModels(providerName, providerConfig.models);
    if (models.length === 0) continue;

    result.push({
      providerName,
      baseURL: effectiveBaseURL,
      apiKey: apiKey || 'sk-lobsterai-local',
      apiType: effectiveApiFormat === 'anthropic' ? 'anthropic' : 'openai',
      authType: providerConfig.authType,
      codingPlanEnabled: !!providerConfig.codingPlanEnabled,
      models,
    });
  }

  return result;
}

/**
 * Returns the long-lived GitHub OAuth token used by OpenClaw's built-in
 * github-copilot provider to exchange for short-lived Copilot API tokens.
 * OpenClaw reads this from the COPILOT_GITHUB_TOKEN env var.
 */
export function getCopilotGithubToken(): string | null {
  const sqliteStore = getStore();
  if (!sqliteStore) return null;
  const token = sqliteStore.get<string>('github_copilot_github_token');
  return token?.trim() || null;
}
