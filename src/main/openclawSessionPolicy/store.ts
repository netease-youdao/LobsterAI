import {
  DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG,
  OPENCLAW_SESSION_MAINTENANCE,
  OPENCLAW_SESSION_POLICY_STORE_KEY,
  OpenClawSessionKeepAlive,
  type OpenClawSessionPolicyConfig,
} from './constants';

type KeyValueStore = {
  get: <T>(key: string) => T | undefined;
  set: (key: string, value: unknown) => void;
};

export const normalizeOpenClawSessionPolicyConfig = (
  value: unknown,
): OpenClawSessionPolicyConfig => {
  const keepAlive = (value as { keepAlive?: string } | null)?.keepAlive;
  const validValues = new Set(Object.values(OpenClawSessionKeepAlive));
  if (keepAlive && validValues.has(keepAlive as OpenClawSessionKeepAlive)) {
    return { keepAlive: keepAlive as OpenClawSessionKeepAlive };
  }
  return DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG;
};

export const mapKeepAliveToSessionReset = (
  keepAlive: OpenClawSessionKeepAlive,
): { mode: 'idle'; idleMinutes: number } => {
  switch (keepAlive) {
    case OpenClawSessionKeepAlive.OneDay:
      return { mode: 'idle', idleMinutes: 1440 };
    case OpenClawSessionKeepAlive.SevenDays:
      return { mode: 'idle', idleMinutes: 10080 };
    case OpenClawSessionKeepAlive.OneYear:
      return { mode: 'idle', idleMinutes: 525600 };
    case OpenClawSessionKeepAlive.ThirtyDays:
    default:
      return { mode: 'idle', idleMinutes: 43200 };
  }
};

export const buildOpenClawSessionConfig = (
  policy: OpenClawSessionPolicyConfig = DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG,
): {
  dmScope: 'per-account-channel-peer';
  reset: { mode: 'idle'; idleMinutes: number };
  maintenance: typeof OPENCLAW_SESSION_MAINTENANCE;
} => ({
  dmScope: 'per-account-channel-peer',
  reset: mapKeepAliveToSessionReset(policy.keepAlive),
  maintenance: { ...OPENCLAW_SESSION_MAINTENANCE },
});

export const loadOpenClawSessionPolicyConfig = (
  store: KeyValueStore,
): OpenClawSessionPolicyConfig => {
  return normalizeOpenClawSessionPolicyConfig(store.get(OPENCLAW_SESSION_POLICY_STORE_KEY));
};

export const saveOpenClawSessionPolicyConfig = (
  store: KeyValueStore,
  value: unknown,
): OpenClawSessionPolicyConfig => {
  const normalized = normalizeOpenClawSessionPolicyConfig(value);
  store.set(OPENCLAW_SESSION_POLICY_STORE_KEY, normalized);
  return normalized;
};
