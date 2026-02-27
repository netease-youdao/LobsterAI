import { shell } from 'electron';
import type { OAuthCredentials } from '@mariozechner/pi-ai';
import type { SqliteStore } from '../sqliteStore';
import { OAuthStore } from './store';
import type {
  OAuthModel,
  OAuthResolvedApiKey,
  OAuthStatus,
  OAuthSyncModelsResult,
  SupportedOAuthProviderKey,
} from './types';
import { loadPiAi } from '../libs/piAiLoader';
import {
  configureCoworkOpenAICompatProxy,
  getCoworkOpenAICompatProxyBaseURL,
} from '../libs/coworkOpenAICompatProxy';
import {
  ANTIGRAVITY_DEFAULT_BASE_URL,
  ANTIGRAVITY_OAUTH_PROVIDER_ID,
  ANTIGRAVITY_PROVIDER_KEY,
  DEFAULT_ANTIGRAVITY_MODELS,
  fetchAntigravityModels,
  getAntigravityProjectId,
  mergeAntigravityModels,
  normalizeAntigravityModelId,
  normalizeAntigravityModelList,
  toOAuthApiKeyPayload,
} from './providers/googleAntigravity';

const OPENAI_PROVIDER_KEY = 'openai' as const;
const OPENAI_OAUTH_PROVIDER_ID = 'openai-codex' as const;
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com';

type ProviderModel = {
  id: string;
  name: string;
  supportsImage?: boolean;
};

type ProviderOAuthMeta = {
  providerId: string;
  profileId?: string;
  email?: string;
  connectedAt?: number;
  lastSyncAt?: number;
};

type ProviderConfig = {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  apiFormat?: 'anthropic' | 'openai' | 'antigravity';
  authMode?: 'api-key' | 'oauth';
  oauth?: ProviderOAuthMeta;
  models?: ProviderModel[];
};

type AppConfig = {
  model?: {
    defaultModel?: string;
  };
  providers?: Record<string, ProviderConfig>;
};

type OAuthResolveApiConfigResult = {
  apiKey: string;
  baseURL: string;
  model: string;
  apiType: 'anthropic' | 'openai';
};

type ProviderMeta = {
  providerKey: SupportedOAuthProviderKey;
  providerId: typeof ANTIGRAVITY_OAUTH_PROVIDER_ID | typeof OPENAI_OAUTH_PROVIDER_ID;
  appProviderKey: 'antigravity' | 'openai';
  defaultBaseUrl: string;
};

const PROVIDERS: Record<SupportedOAuthProviderKey, ProviderMeta> = {
  antigravity: {
    providerKey: 'antigravity',
    providerId: ANTIGRAVITY_OAUTH_PROVIDER_ID,
    appProviderKey: 'antigravity',
    defaultBaseUrl: ANTIGRAVITY_DEFAULT_BASE_URL,
  },
  openai: {
    providerKey: 'openai',
    providerId: OPENAI_OAUTH_PROVIDER_ID,
    appProviderKey: 'openai',
    defaultBaseUrl: OPENAI_DEFAULT_BASE_URL,
  },
};

const sanitizeProviderModels = (models: OAuthModel[]): ProviderModel[] => {
  return normalizeAntigravityModelList(models).map((model) => ({
    id: model.id,
    name: model.name.slice(0, 120),
    supportsImage: model.supportsImage ?? false,
  }));
};

const toOptionalString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

const toOptionalNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const toOptionalStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
};

const isTokenExpiredOrNearExpiry = (expiresAtMs: number): boolean => (
  !Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs
);

export class OAuthService {
  private store: SqliteStore;
  private oauthStore: OAuthStore;

  constructor(store: SqliteStore) {
    this.store = store;
    this.oauthStore = new OAuthStore(store.getDatabase(), store.getSaveFunction());
  }

  private assertProvider(providerKey: SupportedOAuthProviderKey): ProviderMeta {
    const provider = PROVIDERS[providerKey];
    if (!provider) {
      throw new Error(`Unsupported OAuth provider: ${providerKey}`);
    }
    return provider;
  }

  private getAppConfig(): AppConfig {
    return this.store.get<AppConfig>('app_config') ?? {};
  }

  private setAppConfig(config: AppConfig): void {
    this.store.set('app_config', config);
  }

  private ensureProvider(appConfig: AppConfig, providerKey: SupportedOAuthProviderKey): ProviderConfig {
    const meta = this.assertProvider(providerKey);
    if (!appConfig.providers) {
      appConfig.providers = {};
    }
    const existing = appConfig.providers[meta.appProviderKey];
    if (existing) {
      if (!existing.baseUrl) {
        existing.baseUrl = meta.defaultBaseUrl;
      }
      if (providerKey === ANTIGRAVITY_PROVIDER_KEY) {
        existing.authMode = 'oauth';
        existing.apiFormat = 'antigravity';
        if (!Array.isArray(existing.models) || existing.models.length === 0) {
          existing.models = sanitizeProviderModels(DEFAULT_ANTIGRAVITY_MODELS);
        } else {
          existing.models = sanitizeProviderModels(
            existing.models.map((model) => ({
              id: model.id,
              name: model.name,
              supportsImage: model.supportsImage ?? false,
            }))
          );
        }
        existing.apiKey = '';
      } else if (providerKey === OPENAI_PROVIDER_KEY) {
        if (!existing.apiFormat) {
          existing.apiFormat = 'openai';
        }
        if (!existing.authMode) {
          existing.authMode = 'api-key';
        }
      }
      return existing;
    }

    if (providerKey === ANTIGRAVITY_PROVIDER_KEY) {
      const created: ProviderConfig = {
        enabled: false,
        apiKey: '',
        baseUrl: ANTIGRAVITY_DEFAULT_BASE_URL,
        apiFormat: 'antigravity',
        authMode: 'oauth',
        oauth: {
          providerId: ANTIGRAVITY_OAUTH_PROVIDER_ID,
        },
        models: sanitizeProviderModels(DEFAULT_ANTIGRAVITY_MODELS),
      };
      appConfig.providers[meta.appProviderKey] = created;
      return created;
    }

    const created: ProviderConfig = {
      enabled: false,
      apiKey: '',
      baseUrl: OPENAI_DEFAULT_BASE_URL,
      apiFormat: 'openai',
      authMode: 'api-key',
      oauth: {
        providerId: OPENAI_OAUTH_PROVIDER_ID,
      },
      models: [],
    };
    appConfig.providers[meta.appProviderKey] = created;
    return created;
  }

  private updateOAuthMeta(params: {
    providerKey: SupportedOAuthProviderKey;
    appConfig: AppConfig;
    email?: string;
    profileId?: string;
    connectedAt?: number;
    lastSyncAt?: number;
  }): void {
    const meta = this.assertProvider(params.providerKey);
    const provider = this.ensureProvider(params.appConfig, params.providerKey);
    const current = provider.oauth ?? { providerId: meta.providerId };
    provider.oauth = {
      ...current,
      providerId: meta.providerId,
      ...(params.email !== undefined ? { email: params.email } : {}),
      ...(params.profileId !== undefined ? { profileId: params.profileId } : {}),
      ...(params.connectedAt !== undefined ? { connectedAt: params.connectedAt } : {}),
      ...(params.lastSyncAt !== undefined ? { lastSyncAt: params.lastSyncAt } : {}),
    };
  }

  private toProfilePayload(params: {
    providerKey: SupportedOAuthProviderKey;
    credentials: OAuthCredentials;
    fallbackProjectId?: string;
    fallbackEmail?: string;
    fallbackScopes?: string[];
    fallbackMeta?: Record<string, unknown>;
  }): {
    accessToken: string;
    refreshToken: string;
    expiresAtMs: number;
    projectId: string;
    email?: string;
    scopes: string[];
    meta: Record<string, unknown>;
  } {
    const accessToken = toOptionalString(params.credentials.access);
    const refreshToken = toOptionalString(params.credentials.refresh);
    const expiresAtMs = toOptionalNumber(params.credentials.expires);
    if (!accessToken || !refreshToken || !expiresAtMs) {
      throw new Error('OAuth credentials are incomplete, please login again.');
    }

    if (params.providerKey === ANTIGRAVITY_PROVIDER_KEY) {
      const projectId = getAntigravityProjectId(
        toOptionalString(params.credentials.projectId) || params.fallbackProjectId
      );
      return {
        accessToken,
        refreshToken,
        expiresAtMs,
        projectId,
        email: toOptionalString(params.credentials.email) || params.fallbackEmail,
        scopes: toOptionalStringArray(params.credentials.scopes).length > 0
          ? toOptionalStringArray(params.credentials.scopes)
          : (params.fallbackScopes ?? []),
        meta: params.fallbackMeta ?? {},
      };
    }

    const accountId = toOptionalString(params.credentials.accountId);
    const mergedMeta: Record<string, unknown> = {
      ...(params.fallbackMeta ?? {}),
      ...(accountId ? { accountId } : {}),
    };
    return {
      accessToken,
      refreshToken,
      expiresAtMs,
      projectId: '',
      email: params.fallbackEmail,
      scopes: params.fallbackScopes ?? [],
      meta: mergedMeta,
    };
  }

  private async loginWithPiAi(providerKey: SupportedOAuthProviderKey): Promise<OAuthCredentials> {
    const piAi = await loadPiAi();
    if (providerKey === ANTIGRAVITY_PROVIDER_KEY) {
      return piAi.loginAntigravity((info) => {
        void shell.openExternal(info.url);
      });
    }
    if (providerKey === OPENAI_PROVIDER_KEY) {
      return piAi.loginOpenAICodex({
        onAuth: (info) => {
          void shell.openExternal(info.url);
        },
        onPrompt: async () => {
          throw new Error('OpenAI Codex OAuth fallback prompt is not supported in desktop UI.');
        },
      });
    }
    throw new Error(`Unsupported OAuth provider: ${providerKey}`);
  }

  private async refreshWithPiAi(
    providerKey: SupportedOAuthProviderKey,
    refreshToken: string,
    projectId?: string
  ): Promise<OAuthCredentials> {
    const piAi = await loadPiAi();
    if (providerKey === ANTIGRAVITY_PROVIDER_KEY) {
      return piAi.refreshAntigravityToken(refreshToken, getAntigravityProjectId(projectId));
    }
    if (providerKey === OPENAI_PROVIDER_KEY) {
      return piAi.refreshOpenAICodexToken(refreshToken);
    }
    throw new Error(`Unsupported OAuth provider: ${providerKey}`);
  }

  getStatus(providerKey: SupportedOAuthProviderKey): OAuthStatus {
    const meta = this.assertProvider(providerKey);
    const appConfig = this.getAppConfig();
    const provider = this.ensureProvider(appConfig, providerKey);
    const profile = this.oauthStore.getProfile(meta.providerId);

    return {
      providerKey,
      connected: Boolean(profile),
      providerId: meta.providerId,
      profileId: profile?.profileId || provider.oauth?.profileId,
      email: profile?.email || provider.oauth?.email,
      expiresAtMs: profile?.expiresAtMs,
      projectId: providerKey === ANTIGRAVITY_PROVIDER_KEY ? (profile?.projectId || undefined) : undefined,
      connectedAt: provider.oauth?.connectedAt || profile?.createdAt,
      lastSyncAt: provider.oauth?.lastSyncAt,
    };
  }

  async login(providerKey: SupportedOAuthProviderKey): Promise<OAuthStatus> {
    const meta = this.assertProvider(providerKey);
    const credentials = await this.loginWithPiAi(providerKey);
    const profilePayload = this.toProfilePayload({
      providerKey,
      credentials,
      fallbackProjectId: providerKey === ANTIGRAVITY_PROVIDER_KEY ? getAntigravityProjectId(undefined) : '',
    });

    const profile = this.oauthStore.upsertProfile({
      profileId: `${meta.providerId}:default`,
      providerId: meta.providerId,
      accessToken: profilePayload.accessToken,
      refreshToken: profilePayload.refreshToken,
      expiresAtMs: profilePayload.expiresAtMs,
      projectId: profilePayload.projectId,
      email: profilePayload.email,
      scopes: profilePayload.scopes,
      meta: profilePayload.meta,
    });

    const appConfig = this.getAppConfig();
    const provider = this.ensureProvider(appConfig, providerKey);
    provider.authMode = 'oauth';
    if (providerKey === ANTIGRAVITY_PROVIDER_KEY) {
      provider.apiFormat = 'antigravity';
      provider.apiKey = '';
    } else {
      provider.apiFormat = 'openai';
      provider.apiKey = profile.accessToken;
    }
    this.updateOAuthMeta({
      providerKey,
      appConfig,
      email: profile.email,
      profileId: profile.profileId,
      connectedAt: profile.createdAt,
    });
    this.setAppConfig(appConfig);

    return this.getStatus(providerKey);
  }

  disconnect(providerKey: SupportedOAuthProviderKey): void {
    const meta = this.assertProvider(providerKey);
    this.oauthStore.deleteProfile(meta.providerId);

    const appConfig = this.getAppConfig();
    const provider = this.ensureProvider(appConfig, providerKey);
    provider.oauth = {
      providerId: meta.providerId,
      lastSyncAt: provider.oauth?.lastSyncAt,
    };
    provider.apiKey = '';
    if (providerKey === OPENAI_PROVIDER_KEY) {
      provider.authMode = 'api-key';
    }
    this.setAppConfig(appConfig);
  }

  async resolveApiKey(
    providerKey: SupportedOAuthProviderKey,
    forceRefresh = false
  ): Promise<OAuthResolvedApiKey> {
    const meta = this.assertProvider(providerKey);
    const profile = this.oauthStore.getProfile(meta.providerId);
    if (!profile) {
      throw new Error('OAuth not connected. Please login first.');
    }

    let current = profile;
    if (forceRefresh || isTokenExpiredOrNearExpiry(profile.expiresAtMs)) {
      const refreshedCredentials = await this.refreshWithPiAi(
        providerKey,
        profile.refreshToken,
        profile.projectId
      );
      const refreshedPayload = this.toProfilePayload({
        providerKey,
        credentials: refreshedCredentials,
        fallbackProjectId: profile.projectId,
        fallbackEmail: profile.email,
        fallbackScopes: profile.scopes,
        fallbackMeta: profile.meta,
      });
      current = this.oauthStore.upsertProfile({
        profileId: profile.profileId,
        providerId: profile.providerId,
        accessToken: refreshedPayload.accessToken,
        refreshToken: refreshedPayload.refreshToken,
        expiresAtMs: refreshedPayload.expiresAtMs,
        projectId: refreshedPayload.projectId,
        email: refreshedPayload.email,
        scopes: refreshedPayload.scopes,
        meta: refreshedPayload.meta,
      });
    }

    if (providerKey === OPENAI_PROVIDER_KEY) {
      const appConfig = this.getAppConfig();
      const provider = this.ensureProvider(appConfig, providerKey);
      if (provider.authMode === 'oauth' && provider.apiKey !== current.accessToken) {
        provider.apiKey = current.accessToken;
        this.setAppConfig(appConfig);
      }
    }

    return {
      providerKey,
      apiKey: providerKey === ANTIGRAVITY_PROVIDER_KEY
        ? toOAuthApiKeyPayload({
            token: current.accessToken,
            projectId: getAntigravityProjectId(current.projectId),
          })
        : current.accessToken,
      expiresAtMs: current.expiresAtMs,
    };
  }

  async syncModels(
    providerKey: SupportedOAuthProviderKey,
    force = false
  ): Promise<OAuthSyncModelsResult> {
    if (providerKey !== ANTIGRAVITY_PROVIDER_KEY) {
      throw new Error(`Model sync is not supported for provider: ${providerKey}`);
    }

    const appConfig = this.getAppConfig();
    const provider = this.ensureProvider(appConfig, providerKey);

    const cachedModels = sanitizeProviderModels(
      provider.models?.map((model) => ({
        id: model.id,
        name: model.name,
        supportsImage: model.supportsImage ?? false,
      })) || []
    );

    let remoteModels: OAuthModel[] = [];
    let source: OAuthSyncModelsResult['source'] = 'remote';
    let warning: string | undefined;

    const profile = this.oauthStore.getProfile(ANTIGRAVITY_OAUTH_PROVIDER_ID);
    if (!profile) {
      source = cachedModels.length > 0 ? 'cache' : 'default';
      warning = 'OAuth not connected, using cached model list.';
      remoteModels = mergeAntigravityModels(
        cachedModels.map((model) => ({
          id: model.id,
          name: model.name,
          supportsImage: model.supportsImage,
        })),
        DEFAULT_ANTIGRAVITY_MODELS
      );
    } else {
      try {
        let resolved = await this.resolveApiKey(providerKey, force);
        let payload = JSON.parse(resolved.apiKey) as { token?: string; projectId?: string };
        try {
          remoteModels = await fetchAntigravityModels({
            accessToken: payload.token || '',
            projectId: payload.projectId,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('401') || message.toLowerCase().includes('unauthorized')) {
            resolved = await this.resolveApiKey(providerKey, true);
            payload = JSON.parse(resolved.apiKey) as { token?: string; projectId?: string };
            remoteModels = await fetchAntigravityModels({
              accessToken: payload.token || '',
              projectId: payload.projectId,
            });
          } else {
            throw error;
          }
        }
      } catch (error) {
        source = cachedModels.length > 0 ? 'cache' : 'default';
        warning = error instanceof Error ? error.message : 'Failed to sync remote models';
        remoteModels = mergeAntigravityModels(
          cachedModels.map((model) => ({
            id: model.id,
            name: model.name,
            supportsImage: model.supportsImage,
          })),
          DEFAULT_ANTIGRAVITY_MODELS
        );
      }
    }

    const normalizedModels = sanitizeProviderModels(
      remoteModels.map((model) => ({
        id: model.id,
        name: model.name,
        supportsImage: model.supportsImage ?? false,
      }))
    );
    provider.models = normalizedModels;
    this.updateOAuthMeta({
      providerKey,
      appConfig,
      lastSyncAt: Date.now(),
      email: profile?.email,
      profileId: profile?.profileId,
      connectedAt: profile?.createdAt,
    });
    this.setAppConfig(appConfig);

    return {
      providerKey,
      models: normalizedModels,
      source,
      warning,
      syncedAt: Date.now(),
    };
  }

  async resolveApiConfig(
    providerKey: SupportedOAuthProviderKey,
    modelId?: string
  ): Promise<OAuthResolveApiConfigResult> {
    const appConfig = this.getAppConfig();
    const provider = this.ensureProvider(appConfig, providerKey);

    if (providerKey === ANTIGRAVITY_PROVIDER_KEY) {
      await this.resolveApiKey(providerKey, false);
      const normalizedModelId = modelId?.trim()
        ? modelId.trim()
        : appConfig.model?.defaultModel?.trim() || provider.models?.[0]?.id || DEFAULT_ANTIGRAVITY_MODELS[0].id;

      const normalizedProviderModel = normalizedModelId.startsWith('google-antigravity/')
        ? normalizedModelId
        : `google-antigravity/${normalizeAntigravityModelId(normalizedModelId)}`;
      const upstreamBaseURL = provider.baseUrl?.trim() || ANTIGRAVITY_DEFAULT_BASE_URL;

      configureCoworkOpenAICompatProxy({
        baseURL: upstreamBaseURL,
        model: normalizeAntigravityModelId(normalizedProviderModel),
        providerModelId: normalizedProviderModel,
        provider: ANTIGRAVITY_PROVIDER_KEY,
        upstreamKind: 'openai',
        endpointMode: 'cloudcode-sse',
        resolveAuthApiKey: async (forceRefresh?: boolean) => {
          const resolved = await this.resolveApiKey(providerKey, forceRefresh ?? false);
          return resolved.apiKey;
        },
      });

      const proxyBaseURL = getCoworkOpenAICompatProxyBaseURL();
      if (!proxyBaseURL) {
        throw new Error('OpenAI compatibility proxy base URL is unavailable.');
      }

      return {
        apiKey: 'lobsterai-antigravity-oauth',
        baseURL: proxyBaseURL,
        model: normalizedProviderModel,
        apiType: 'openai',
      };
    }

    const resolved = await this.resolveApiKey(providerKey, false);
    const resolvedModel = modelId?.trim()
      ? modelId.trim()
      : appConfig.model?.defaultModel?.trim() || provider.models?.[0]?.id || 'gpt-5.2-codex';
    const resolvedBaseURL = provider.baseUrl?.trim() || OPENAI_DEFAULT_BASE_URL;

    if (provider.authMode === 'oauth' && provider.apiKey !== resolved.apiKey) {
      provider.apiKey = resolved.apiKey;
      this.setAppConfig(appConfig);
    }

    return {
      apiKey: resolved.apiKey,
      baseURL: resolvedBaseURL,
      model: resolvedModel,
      apiType: 'openai',
    };
  }

}
