import { ProviderAuthType, ProviderName, ProviderRegistry } from '../../shared/providers';
import { getProviderDisplayName } from '../config';
import { store } from '../store';
import { setAvailableModels, setDefaultSelectedModel } from '../store/slices/modelSlice';
import type { ApiConfig } from './api';
import { apiService } from './api';
import { configService } from './config';
import { applyTypographyPreferences } from './typography';

export interface ProviderModelOption {
  id: string;
  name: string;
  provider?: string;
  providerKey?: string;
  openClawProviderId?: string;
  supportsImage?: boolean;
}

/**
 * Applies the loaded app config to a renderer: typography, API client config,
 * and the provider models offered by model pickers. Shared by the main window
 * and the desktop companion's composer window.
 */
export function applyAppConfigToStore(log?: (label: string) => void): ProviderModelOption[] {
  const config = configService.getConfig();
  applyTypographyPreferences(config);
  const apiConfig: ApiConfig = {
    apiKey: config.api.key,
    baseUrl: config.api.baseUrl,
  };
  apiService.setConfig(apiConfig);

  const providerModels: ProviderModelOption[] = [];
  if (config.providers) {
    Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
      if (providerConfig.enabled && providerConfig.models) {
        const openClawProviderId = ProviderRegistry.getOpenClawProviderIdForConfig(providerName, providerConfig);
        if (providerName === ProviderName.Minimax && providerConfig.authType === ProviderAuthType.OAuth) {
          log?.('MiniMax OAuth provider resolved to OpenClaw minimax-portal');
        }
        providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean }) => {
          providerModels.push({
            id: model.id,
            name: model.name,
            provider: getProviderDisplayName(providerName, providerConfig),
            providerKey: providerName,
            openClawProviderId,
            supportsImage: model.supportsImage ?? false,
          });
        });
      }
    });
  }
  store.dispatch(setAvailableModels(providerModels));
  if (providerModels.length > 0) {
    const allModels = store.getState().model.availableModels;
    const preferredModel = allModels.find(
      model => model.id === config.model.defaultModel
        && (!config.model.defaultModelProvider || model.providerKey === config.model.defaultModelProvider)
    ) ?? allModels[0];
    store.dispatch(setDefaultSelectedModel(preferredModel));
  }
  return providerModels;
}
