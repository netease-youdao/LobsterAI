import { ProviderRegistry } from './constants';
import {
  getModelRuntimeProfileDefinition,
  type ModelRuntimeProfile,
} from './modelRuntimeProfiles';
import type { ModelCapabilityOverrides } from './types';

/**
 * Returns the overrides needed for the user's model editor choices to stick,
 * or undefined when the registry/runtime-profile defaults already resolve to
 * the same values. Values that match the defaults are left out so later preset
 * updates still apply.
 */
export const buildModelCapabilityOverrides = (
  providerName: string,
  modelId: string,
  selected: { supportsImage: boolean; supportsThinking: boolean },
  runtimeProfile?: ModelRuntimeProfile,
): ModelCapabilityOverrides | undefined => {
  const overrides: ModelCapabilityOverrides = {};
  const profileDef = runtimeProfile
    ? getModelRuntimeProfileDefinition(runtimeProfile)
    : undefined;
  const registrySupportsImage = ProviderRegistry.resolveModelSupportsImage(
    providerName,
    modelId,
    selected.supportsImage,
  ) || Boolean(profileDef?.input.includes('image'));
  if (registrySupportsImage !== selected.supportsImage) {
    overrides.image = selected.supportsImage;
  }
  const registrySupportsThinking = ProviderRegistry.resolveModelSupportsThinking(
    providerName,
    modelId,
    selected.supportsThinking,
  ) || Boolean(profileDef?.reasoning);
  if (registrySupportsThinking !== selected.supportsThinking) {
    overrides.thinking = selected.supportsThinking;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
};
