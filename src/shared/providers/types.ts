import type { ApiFormat, OpenAIApiMode, ProviderAuthType } from './constants';

/**
 * Capabilities the user set by hand in the model editor. Unlike the plain
 * `supportsImage` / `supportsThinking` fields, which may be stale snapshots of
 * a built-in preset, these always win over the provider registry.
 */
export interface ModelCapabilityOverrides {
  image?: boolean;
  thinking?: boolean;
}

export interface ProviderConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  apiFormat?: ApiFormat;
  /** Endpoint family used when apiFormat is 'openai'. Defaults to Chat Completions. */
  openaiApiMode?: OpenAIApiMode;
  models?: Array<{
    id: string;
    name: string;
    supportsImage?: boolean;
    supportsVideo?: boolean;
    supportsThinking?: boolean;
    contextWindow?: number;
    maxTokens?: number;
    customParams?: Record<string, unknown>;
    capabilityOverrides?: ModelCapabilityOverrides;
  }>;
  displayName?: string;
  codingPlanEnabled?: boolean;
  authType?: ProviderAuthType;
  /** OAuth access token (stored separately from apiKey to avoid conflicts) */
  oauthAccessToken?: string;
  /** Base URL returned by OAuth resource_url (stored separately from user-configured baseUrl) */
  oauthBaseUrl?: string;
  oauthRefreshToken?: string;
  oauthTokenExpiresAt?: number;
}
