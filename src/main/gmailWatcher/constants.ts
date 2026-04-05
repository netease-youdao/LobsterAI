/**
 * Constants for the Gmail Watcher module.
 */

export const GmailIpcChannel = {
  StartOAuth: 'gmail:startOAuth',
  GetStatus: 'gmail:getStatus',
  Enable: 'gmail:enable',
  Disable: 'gmail:disable',
  Disconnect: 'gmail:disconnect',
} as const;
export type GmailIpcChannel = (typeof GmailIpcChannel)[keyof typeof GmailIpcChannel];

export const GmailStorageKey = {
  OAuthTokens: 'gmail_oauth_tokens',
  Config: 'gmail_watcher_config',
  LastHistoryId: 'gmail_last_history_id',
} as const;

/**
 * Google OAuth2 configuration for Gmail API access.
 *
 * IMPORTANT: Users must provide their own Google Cloud OAuth Client ID
 * via the settings UI. These are the well-known Google endpoints only.
 */
export const GoogleOAuthEndpoint = {
  AuthUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  TokenUrl: 'https://oauth2.googleapis.com/token',
  RevokeUrl: 'https://oauth2.googleapis.com/revoke',
} as const;

/**
 * Gmail API scopes required for watch + read-only access.
 * - gmail.readonly: read messages, labels, history
 * - gmail.labels: needed for watch() to filter by labels
 */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

/** Gmail API base URL */
export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';

/** Default polling interval for checking new mail (ms) */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** Maximum polling interval after backoff (ms) */
export const MAX_POLL_INTERVAL_MS = 5 * 60_000;

/** Gmail watch() expiration: 7 days. Re-register before expiry. */
export const WATCH_RENEWAL_INTERVAL_MS = 6 * 24 * 60 * 60_000; // 6 days

export interface GmailOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export interface GmailWatcherConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  labelFilter: string; // e.g. 'INBOX', 'UNREAD'
  agentPromptTemplate: string; // template for agent prompt
  pollIntervalMs: number;
}

export const DEFAULT_GMAIL_WATCHER_CONFIG: GmailWatcherConfig = {
  enabled: false,
  clientId: '',
  clientSecret: '',
  labelFilter: 'INBOX',
  agentPromptTemplate:
    'You have received a new email:\n\nFrom: {{from}}\nSubject: {{subject}}\nDate: {{date}}\n\nBody:\n{{snippet}}\n\nPlease summarize this email and suggest a reply if appropriate.',
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
};
