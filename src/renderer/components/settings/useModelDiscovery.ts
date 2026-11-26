import { useCallback, useEffect, useRef, useState } from 'react';

import type { DiscoveredModel } from '../../../shared/providers';
import { i18nService } from '../../services/i18n';
import {
  discoverModelsForProvider,
  formatModelDiscoveryError,
  mergeDiscoveredModels,
  type ProviderDiscoveryAuthState,
} from '../../services/providerModelDiscovery';
import type { Model, ProviderConfig, ProvidersConfig, ProviderType } from './modelProviderUtils';

export interface ModelDiscoveryDialogState {
  provider: ProviderType;
  candidates: DiscoveredModel[];
  effectiveApiFormat: 'anthropic' | 'openai' | 'gemini';
  openedAt: number;
}

export interface ModelDiscoveryErrorState {
  provider: ProviderType;
  message: string;
}

export function useModelDiscovery(params: {
  activeProvider: ProviderType;
  providers: ProvidersConfig;
  setProviders: React.Dispatch<React.SetStateAction<ProvidersConfig>>;
}) {
  const { activeProvider, providers, setProviders } = params;
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<ModelDiscoveryErrorState | null>(null);
  const [dialog, setDialog] = useState<ModelDiscoveryDialogState | null>(null);
  const generationRef = useRef(0);
  const latestProvidersRef = useRef(providers);
  latestProvidersRef.current = providers;

  // Switching providers invalidates any in-flight discovery request and clears
  // stale errors or pickers bound to the previous provider.
  useEffect(() => {
    generationRef.current += 1;
    setIsFetching(false);
    setError((prev) => (prev && prev.provider === activeProvider ? prev : null));
    setDialog((prev) => (prev && prev.provider === activeProvider ? prev : null));
  }, [activeProvider]);

  useEffect(() => () => {
    generationRef.current += 1;
  }, []);

  const closeDialog = useCallback(() => {
    setDialog(null);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const fetchModels = useCallback(async (
    provider: ProviderType,
    config: ProviderConfig,
    authState: ProviderDiscoveryAuthState,
  ) => {
    const operation = ++generationRef.current;
    setIsFetching(true);
    setError(null);
    try {
      const { result, effectiveApiFormat } = await discoverModelsForProvider({
        provider,
        config,
        authState,
      });
      if (operation !== generationRef.current) return;

      if (!result.ok) {
        setError({
          provider,
          message: formatModelDiscoveryError(result, (key) => i18nService.t(key)),
        });
        return;
      }

      if (result.models.length === 0) {
        setError({
          provider,
          message: i18nService.t('fetchModelsEmpty'),
        });
        return;
      }

      setDialog({
        provider,
        candidates: result.models,
        effectiveApiFormat,
        openedAt: Date.now(),
      });
    } catch {
      if (operation !== generationRef.current) return;
      setError({
        provider,
        message: i18nService.t('fetchModelsNetworkError'),
      });
    } finally {
      if (operation === generationRef.current) {
        setIsFetching(false);
      }
    }
  }, []);

  const applySelection = useCallback((selectedIds: ReadonlySet<string>) => {
    if (!dialog) return;
    const { provider, candidates, effectiveApiFormat } = dialog;
    setProviders((prev) => {
      const currentProvider = prev[provider];
      if (!currentProvider) return prev;
      const currentModels: readonly Model[] = currentProvider.models ?? [];
      const nextModels = mergeDiscoveredModels({
        provider,
        effectiveApiFormat,
        currentModels,
        candidates,
        selectedIds,
      });
      return {
        ...prev,
        [provider]: {
          ...currentProvider,
          models: nextModels,
        },
      };
    });
    setDialog(null);
  }, [dialog, setProviders]);

  return {
    isFetching,
    error: error?.provider === activeProvider ? error.message : null,
    dialog: dialog?.provider === activeProvider ? dialog : null,
    fetchModels,
    applySelection,
    closeDialog,
    clearError,
  };
}
