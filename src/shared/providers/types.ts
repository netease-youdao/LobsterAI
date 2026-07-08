import type { ApiFormat, ProviderAuthType } from './constants';

export interface ProviderConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  apiFormat?: ApiFormat;
  models?: Array<{
    id: string;
    name: string;
    supportsImage?: boolean;
    supportsThinking?: boolean;
    contextWindow?: number;
    customParams?: Record<string, unknown>;
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
