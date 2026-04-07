import type { ApiFormat } from './constants';

export interface ProviderConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  apiFormat?: ApiFormat;
  models?: Array<{
    id: string;
    name: string;
    supportsImage?: boolean;
  }>;
  displayName?: string;
  codingPlanEnabled?: boolean;
  authType?: 'apikey' | 'oauth';
  oauthRefreshToken?: string;
  oauthTokenExpiresAt?: number;
}
