export const AuthIpcChannel = {
  Callback: 'auth:callback',
  ClaimCreditsFinalReward: 'auth:claimCreditsFinalReward',
  Exchange: 'auth:exchange',
  GetAccessToken: 'auth:getAccessToken',
  GetActiveClientBanner: 'auth:getActiveClientBanner',
  GetActiveClientBanners: 'auth:getActiveClientBanners',
  GetClientBannerSnapshot: 'auth:getClientBannerSnapshot',
  GetModels: 'auth:getModels',
  GetPricingCatalog: 'auth:getPricingCatalog',
  GetProfileSummary: 'auth:getProfileSummary',
  GetPendingCallback: 'auth:getPendingCallback',
  GetQuota: 'auth:getQuota',
  GetUser: 'auth:getUser',
  LifecycleEvent: 'auth:lifecycleEvent',
  Login: 'auth:login',
  Logout: 'auth:logout',
  QuotaChanged: 'auth:quotaChanged',
  RefreshToken: 'auth:refreshToken',
  SessionChanged: 'auth:sessionChanged',
} as const;

export type AuthIpcChannel = typeof AuthIpcChannel[keyof typeof AuthIpcChannel];

export interface AuthLoginResult {
  success: boolean;
  redirectUrl?: string;
  error?: string;
}

export const AuthSessionStatus = {
  Authenticated: 'authenticated',
  Expired: 'expired',
  TemporarilyUnavailable: 'temporarily_unavailable',
  Unauthenticated: 'unauthenticated',
} as const;

export type AuthSessionStatus = typeof AuthSessionStatus[keyof typeof AuthSessionStatus];

export const AuthSessionChangeReason = {
  EnterpriseMembershipRevoked: 'enterprise_membership_revoked',
  RefreshRejected: 'refresh_rejected',
  UserLogout: 'user_logout',
} as const;

export type AuthSessionChangeReason =
  typeof AuthSessionChangeReason[keyof typeof AuthSessionChangeReason];

export const AuthRefreshOutcome = {
  NoTokens: 'no_tokens',
  Success: 'success',
  TerminalFailure: 'terminal_failure',
  TransientFailure: 'transient_failure',
} as const;

export type AuthRefreshOutcome = typeof AuthRefreshOutcome[keyof typeof AuthRefreshOutcome];

export type AuthTokenRefreshResult = {
  outcome: AuthRefreshOutcome;
  accessToken?: string;
};

export const AuthRefreshFailureKind = {
  Http: 'http_error',
  InvalidResponse: 'invalid_response',
  Network: 'network',
  Rejected: 'rejected',
  Timeout: 'timeout',
} as const;

export type AuthRefreshFailureKind =
  typeof AuthRefreshFailureKind[keyof typeof AuthRefreshFailureKind];

export const AuthRefreshReason = {
  CompatProxy: 'compat-proxy',
  Manual: 'manual',
  OpenClawProxy: 'openclaw-proxy',
  Passive: 'passive',
  Proactive: 'proactive',
} as const;

export type AuthRefreshReason = typeof AuthRefreshReason[keyof typeof AuthRefreshReason];

export const AuthLifecycleEventType = {
  Restore: 'auth_restore',
  TerminalExpired: 'auth_terminal_expired',
  TokenRefresh: 'token_refresh',
} as const;

export type AuthLifecycleEventType =
  typeof AuthLifecycleEventType[keyof typeof AuthLifecycleEventType];

export type AuthLifecycleEvent =
  | {
      eventType: typeof AuthLifecycleEventType.TokenRefresh;
      outcome: AuthRefreshOutcome;
      reason: AuthRefreshReason;
      durationMs: number;
      failureKind?: AuthRefreshFailureKind;
      httpStatus?: number;
      errorCode?: number;
      joinedRequests: number;
    }
  | {
      eventType: typeof AuthLifecycleEventType.Restore;
      outcome: AuthSessionStatus;
    }
  | {
      eventType: typeof AuthLifecycleEventType.TerminalExpired;
      outcome: typeof AuthSessionStatus.Expired;
      reason: AuthSessionChangeReason;
    };

export type AuthSessionChangedEvent = {
  status: AuthSessionStatus;
  reason: AuthSessionChangeReason;
};

export const AuthSubscriptionStatus = {
  Active: 'active',
  Enterprise: 'enterprise',
  Free: 'free',
} as const;

export type AuthSubscriptionStatus = typeof AuthSubscriptionStatus[keyof typeof AuthSubscriptionStatus];
