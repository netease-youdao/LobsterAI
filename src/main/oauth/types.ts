export type SupportedOAuthProviderKey = 'antigravity' | 'openai';

export type OAuthProviderId = 'google-antigravity' | 'openai-codex';

export type OAuthProfileRecord = {
  profileId: string;
  providerId: OAuthProviderId;
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  projectId: string;
  email?: string;
  scopes: string[];
  meta: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type OAuthStatus = {
  providerKey: SupportedOAuthProviderKey;
  connected: boolean;
  providerId: OAuthProviderId;
  profileId?: string;
  email?: string;
  expiresAtMs?: number;
  projectId?: string;
  connectedAt?: number;
  lastSyncAt?: number;
};

export type OAuthModel = {
  id: string;
  name: string;
  supportsImage?: boolean;
};

export type OAuthSyncModelsResult = {
  providerKey: SupportedOAuthProviderKey;
  models: OAuthModel[];
  source: 'remote' | 'cache' | 'default';
  warning?: string;
  syncedAt: number;
};

export type OAuthResolvedApiKey = {
  apiKey: string;
  expiresAtMs: number;
  providerKey: SupportedOAuthProviderKey;
};
