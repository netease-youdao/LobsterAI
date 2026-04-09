export const OpenClawSessionKeepAlive = {
  OneDay: '1d',
  SevenDays: '7d',
  ThirtyDays: '30d',
  OneYear: '365d',
} as const;

export type OpenClawSessionKeepAlive =
  typeof OpenClawSessionKeepAlive[keyof typeof OpenClawSessionKeepAlive];

export const OPENCLAW_SESSION_POLICY_STORE_KEY = 'openclaw_session_policy';

export interface OpenClawSessionPolicyConfig {
  keepAlive: OpenClawSessionKeepAlive;
}

export const DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG: OpenClawSessionPolicyConfig = {
  keepAlive: OpenClawSessionKeepAlive.ThirtyDays,
};

export const OPENCLAW_SESSION_MAINTENANCE = {
  pruneAfter: '365d',
  maxEntries: 1000000,
  rotateBytes: '1gb',
} as const;

export const OpenClawSessionPolicyIpc = {
  Get: 'openclaw:sessionPolicy:get',
  Set: 'openclaw:sessionPolicy:set',
} as const;

export type OpenClawSessionPolicyIpc =
  typeof OpenClawSessionPolicyIpc[keyof typeof OpenClawSessionPolicyIpc];
