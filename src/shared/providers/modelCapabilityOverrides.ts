import { ProviderRegistry } from './constants';
import type { ModelCapabilityOverrides } from './types';

/**
 * Returns the overrides needed for the user's model editor choices to stick,
 * or undefined when the registry already resolves to the same values. Values
 * that match the registry are left out so later preset updates still apply.
 */
export const buildModelCapabilityOverrides = (
  providerName: string,
  modelId: string,
  selected: { supportsImage: boolean; supportsThinking: boolean },
): ModelCapabilityOverrides | undefined => {
  const overrides: ModelCapabilityOverrides = {};
  const registrySupportsImage = ProviderRegistry.resolveModelSupportsImage(
    providerName,
    modelId,
    selected.supportsImage,
  );
  if (registrySupportsImage !== selected.supportsImage) {
    overrides.image = selected.supportsImage;
  }
  const registrySupportsThinking = ProviderRegistry.resolveModelSupportsThinking(
    providerName,
    modelId,
    selected.supportsThinking,
  );
  if (registrySupportsThinking !== selected.supportsThinking) {
    overrides.thinking = selected.supportsThinking;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
};
