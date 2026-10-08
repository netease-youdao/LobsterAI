export const OPENCLAW_XAI_AUTH_STORE_ENTRY = 'openclaw-xai-auth-store.mjs';
export const XAI_AUTH_PROVIDER = 'xai';
export const XAI_AUTH_CREDENTIAL_TYPE = 'oauth';
export const XaiAuthStoreErrorCode = {
  MigrationPending: 'XAI_AUTH_MIGRATION_PENDING',
} as const;

export interface XaiOAuthStatus {
  loggedIn: boolean;
  email?: string;
  displayName?: string;
  expiresAt?: number;
}

export interface XaiOAuthCredential {
  type: typeof XAI_AUTH_CREDENTIAL_TYPE;
  provider: typeof XAI_AUTH_PROVIDER;
  access: string;
  refresh?: string;
  expires?: number;
  [key: string]: unknown;
}

export interface OpenClawXaiAuthStore {
  readStatus(stateDir: string): XaiOAuthStatus;
  replaceCredential(stateDir: string, profileId: string, credential: XaiOAuthCredential): void;
  logout(stateDir: string): void;
}
