import {
  type DecisionModelApiKeys,
  type DecisionModelConfigView,
  DecisionModelProvider,
} from '../../shared/decisionModel/constants';

export interface DecisionModelConfig {
  enabled: boolean;
  provider: DecisionModelProvider;
  /** Full POST URL; only the compatible provider uses it. */
  endpoint: string;
  /**
   * Key of the selected provider, derived from apiKeys. Also stored, so builds
   * from before per-provider keys still find the active key.
   */
  apiKey: string;
  apiKeys: DecisionModelApiKeys;
}

export const DEFAULT_DECISION_MODEL_CONFIG: DecisionModelConfig = {
  enabled: false,
  provider: DecisionModelProvider.TypeSafe,
  endpoint: '',
  apiKey: '',
  apiKeys: {},
};

const PROVIDER_LIST = Object.values(DecisionModelProvider);
const PROVIDERS = new Set<string>(PROVIDER_LIST);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isProvider = (value: unknown): value is DecisionModelProvider =>
  typeof value === 'string' && PROVIDERS.has(value);

/** Keeps trimmed, non-empty string keys of known providers. */
function normalizeApiKeys(raw: unknown): DecisionModelApiKeys {
  const value = isRecord(raw) ? raw : {};
  const apiKeys: DecisionModelApiKeys = {};
  for (const provider of PROVIDER_LIST) {
    const key = value[provider];
    if (typeof key === 'string' && key.trim()) apiKeys[provider] = key.trim();
  }
  return apiKeys;
}

export function normalizeDecisionModelConfig(raw: unknown): DecisionModelConfig {
  const value = isRecord(raw) ? raw : {};
  const provider = isProvider(value.provider) ? value.provider : DEFAULT_DECISION_MODEL_CONFIG.provider;
  // Older builds stored one apiKey, saved together with the provider it was for.
  const apiKeys = isRecord(value.apiKeys)
    ? normalizeApiKeys(value.apiKeys)
    : normalizeApiKeys({ [provider]: value.apiKey });
  return {
    enabled: value.enabled === true,
    provider,
    endpoint: typeof value.endpoint === 'string' ? value.endpoint.trim() : '',
    apiKey: apiKeys[provider] ?? '',
    apiKeys,
  };
}

/** Applies a renderer update; fields that are absent or malformed keep their current value. */
export function applyDecisionModelConfigUpdate(
  current: DecisionModelConfig,
  update: unknown,
): DecisionModelConfig {
  const patch = isRecord(update) ? update : {};
  const provider = isProvider(patch.provider) ? patch.provider : current.provider;
  const apiKeys: Record<string, unknown> = { ...current.apiKeys };
  if (isRecord(patch.apiKeys)) {
    for (const keyProvider of PROVIDER_LIST) {
      const key = patch.apiKeys[keyProvider];
      if (typeof key === 'string') apiKeys[keyProvider] = key;
    }
  }
  if (typeof patch.apiKey === 'string') apiKeys[provider] = patch.apiKey;
  return normalizeDecisionModelConfig({
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    provider,
    endpoint: typeof patch.endpoint === 'string' ? patch.endpoint : current.endpoint,
    apiKeys,
  });
}

export function isValidDecisionEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Has everything a request needs, regardless of the enabled switch. */
export function isDecisionModelConfigured(config: DecisionModelConfig): boolean {
  if (!config.apiKey) return false;
  return config.provider !== DecisionModelProvider.Compatible || isValidDecisionEndpoint(config.endpoint);
}

export function isDecisionModelActive(config: DecisionModelConfig): boolean {
  return config.enabled && isDecisionModelConfigured(config);
}

export function toDecisionModelConfigView(config: DecisionModelConfig): DecisionModelConfigView {
  return {
    enabled: config.enabled,
    provider: config.provider,
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    apiKeys: { ...config.apiKeys },
    active: isDecisionModelActive(config),
  };
}
