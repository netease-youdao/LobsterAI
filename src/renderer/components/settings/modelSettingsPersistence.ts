import { ProviderName } from '@shared/providers';

import { getProviderDisplayName } from '../../config';
import {
  getEffectiveApiFormat,
  getOpenClawProviderIdForConfig,
  hasProviderAuthConfigured,
  type ProviderConfig,
  type ProvidersConfig,
  type ProviderType,
  resolveBaseUrl,
  resolveModelSupportsImageForProvider,
} from './modelProviderUtils';

export interface AvailableModelEntry {
  id: string;
  name: string;
  provider?: string;
  providerKey?: string;
  openClawProviderId?: string;
  supportsImage?: boolean;
}

export const normalizeProvidersForSettingsSave = (providers: ProvidersConfig): ProvidersConfig => (
  Object.fromEntries(
    Object.entries(providers).map(([providerKey, providerConfig]) => {
      const apiFormat = getEffectiveApiFormat(providerKey, providerConfig.apiFormat);
      const hasValidAuth = hasProviderAuthConfigured(providerKey as ProviderType, providerConfig);
      return [
        providerKey,
        {
          ...providerConfig,
          enabled: providerConfig.enabled && hasValidAuth,
          apiFormat,
          ...(providerKey === ProviderName.Copilot ? { apiKey: '' } : {}),
          baseUrl: resolveBaseUrl(providerKey as ProviderType, providerConfig.baseUrl, apiFormat),
        },
      ];
    }),
  ) as ProvidersConfig
);

export const resolvePrimaryProviderForSettingsSave = (
  providers: ProvidersConfig,
  activeProvider: ProviderType,
): ProviderConfig => {
  const firstEnabledProvider = Object.entries(providers).find(
    ([, config]) => config.enabled,
  );
  return firstEnabledProvider
    ? firstEnabledProvider[1]
    : providers[activeProvider];
};

export const buildAvailableModelsFromProviders = (
  normalizedProviders: ProvidersConfig,
): AvailableModelEntry[] => {
  const allModels: AvailableModelEntry[] = [];
  Object.entries(normalizedProviders).forEach(([providerName, config]) => {
    if (config.enabled && config.models) {
      const openClawProviderId = getOpenClawProviderIdForConfig(providerName, config);
      config.models.forEach((model) => {
        allModels.push({
          id: model.id,
          name: model.name,
          provider: getProviderDisplayName(providerName, config),
          providerKey: providerName,
          openClawProviderId,
          supportsImage: resolveModelSupportsImageForProvider(providerName, model),
        });
      });
    }
  });
  return allModels;
};

const normalizeConnectionText = (value?: string): string => (value ?? '').trim();

const normalizeAuthType = (providerKey: ProviderType, value?: string): string => {
  if (providerKey === ProviderName.Minimax) {
    return value === 'apikey' ? 'apikey' : 'oauth';
  }
  return value === 'oauth' ? 'oauth' : 'apikey';
};

/**
 * Checks whether the connection fields of `activeProvider` differ from the
 * persisted baseline. A newly added custom provider not yet present in
 * `savedProviders` is always treated as dirty.
 */
export const isProviderConnectionDirty = (
  saved: ProviderConfig | undefined,
  current: ProviderConfig | undefined,
  providerKey: ProviderType,
): boolean => {
  if (!current) return false;
  if (!saved) return true;

  const savedApiFormat = getEffectiveApiFormat(providerKey, saved.apiFormat);
  const currentApiFormat = getEffectiveApiFormat(providerKey, current.apiFormat);

  return normalizeAuthType(providerKey, saved.authType) !== normalizeAuthType(providerKey, current.authType)
    || normalizeConnectionText(saved.apiKey) !== normalizeConnectionText(current.apiKey)
    || normalizeConnectionText(saved.baseUrl) !== normalizeConnectionText(current.baseUrl)
    || savedApiFormat !== currentApiFormat
    || (saved.openaiApiMode ?? '') !== (current.openaiApiMode ?? '')
    || Boolean(saved.codingPlanEnabled) !== Boolean(current.codingPlanEnabled)
    || normalizeConnectionText(saved.displayName) !== normalizeConnectionText(current.displayName);
};

/**
 * Reverts unsaved connection edits for `providerKey` back to `savedProviders`.
 * If `providerKey` was a newly added unsaved custom provider, removes it from
 * `currentProviders`.
 */
export const discardProviderConnectionDraft = (
  savedProviders: ProvidersConfig,
  currentProviders: ProvidersConfig,
  providerKey: ProviderType,
): ProvidersConfig => {
  const saved = savedProviders[providerKey];
  if (!saved) {
    const next = { ...currentProviders };
    delete next[providerKey];
    return next as ProvidersConfig;
  }

  const current = currentProviders[providerKey];
  if (!current) {
    return {
      ...currentProviders,
      [providerKey]: { ...saved },
    };
  }

  const codingPlanChanged = Boolean(saved.codingPlanEnabled) !== Boolean(current.codingPlanEnabled);
  return {
    ...currentProviders,
    [providerKey]: {
      ...current,
      authType: saved.authType,
      apiKey: saved.apiKey,
      baseUrl: saved.baseUrl,
      apiFormat: saved.apiFormat,
      openaiApiMode: saved.openaiApiMode,
      codingPlanEnabled: saved.codingPlanEnabled,
      displayName: saved.displayName,
      ...(codingPlanChanged ? { models: saved.models ? saved.models.map(m => ({ ...m })) : [] } : {}),
    },
  };
};

/**
 * Applies an immediate structural mutation (e.g. add/edit/delete model, toggle
 * enabled) to both the displayed state and the persisted baseline without
 * prematurely persisting unrelated unsaved connection edits.
 *
 * When `providerKey` is an unsaved new custom provider, `nextSaved` is `null`
 * so the mutation stays inside the new provider's draft until saved.
 */
export const applyImmediateProviderMutation = (
  savedProviders: ProvidersConfig,
  currentProviders: ProvidersConfig,
  providerKey: ProviderType,
  mutate: (provider: ProviderConfig) => ProviderConfig,
): { nextSaved: ProvidersConfig | null; nextCurrent: ProvidersConfig } => {
  const current = currentProviders[providerKey];
  if (!current) {
    return { nextSaved: null, nextCurrent: currentProviders };
  }

  const nextCurrent: ProvidersConfig = {
    ...currentProviders,
    [providerKey]: mutate(current),
  };

  const saved = savedProviders[providerKey];
  if (!saved) {
    return { nextSaved: null, nextCurrent };
  }

  const nextSaved: ProvidersConfig = {
    ...savedProviders,
    [providerKey]: mutate(saved),
  };

  return { nextSaved, nextCurrent };
};
