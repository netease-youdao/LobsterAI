import type { AppConfig } from '../config';
import type { Model } from '../store/slices/modelSlice';

/** Build the user-configurable model list from merged app config (same shape as App handleCloseSettings). */
export function buildAvailableModelsListFromAppConfig(config: AppConfig): Model[] {
  const allModels: Model[] = [];
  if (!config.providers) {
    return allModels;
  }
  Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
    if (providerConfig.enabled && providerConfig.models) {
      providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean }) => {
        allModels.push({
          id: model.id,
          name: model.name,
          provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
          providerKey: providerName,
          supportsImage: model.supportsImage ?? false,
        });
      });
    }
  });
  return allModels;
}
