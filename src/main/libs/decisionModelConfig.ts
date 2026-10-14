import {
  type DecisionModelConfigView,
  DecisionModelProvider,
} from '../../shared/decisionModel/constants';

export interface DecisionModelConfig {
  enabled: boolean;
  provider: DecisionModelProvider;
  /** Full POST URL; only the compatible provider uses it. */
  endpoint: string;
  apiKey: string;
}

export const DEFAULT_DECISION_MODEL_CONFIG: DecisionModelConfig = {
  enabled: false,
  provider: DecisionModelProvider.TypeSafe,
  endpoint: '',
  apiKey: '',
};

const PROVIDERS = new Set<string>(Object.values(DecisionModelProvider));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isProvider = (value: unknown): value is DecisionModelProvider =>
  typeof value === 'string' && PROVIDERS.has(value);

export function normalizeDecisionModelConfig(raw: unknown): DecisionModelConfig {
  const value = isRecord(raw) ? raw : {};
  return {
    enabled: value.enabled === true,
    provider: isProvider(value.provider) ? value.provider : DEFAULT_DECISION_MODEL_CONFIG.provider,
    endpoint: typeof value.endpoint === 'string' ? value.endpoint.trim() : '',
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim() : '',
  };
}

/** Applies a renderer update; fields that are absent or malformed keep their current value. */
export function applyDecisionModelConfigUpdate(
  current: DecisionModelConfig,
  update: unknown,
): DecisionModelConfig {
  const patch = isRecord(update) ? update : {};
  return normalizeDecisionModelConfig({
    ...current,
    ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
    ...(isProvider(patch.provider) ? { provider: patch.provider } : {}),
    ...(typeof patch.endpoint === 'string' ? { endpoint: patch.endpoint } : {}),
    ...(typeof patch.apiKey === 'string' ? { apiKey: patch.apiKey } : {}),
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
    active: isDecisionModelActive(config),
  };
}
