import { type AvailableModelPreset, ModelPresetId, modelPresetModelId } from '../../shared/modelPresets/constants';
import { ProviderName } from '../../shared/providers/constants';
import { parseLobsterAIRequestCapabilities } from '../../shared/providers/lobsterAIRequestOptions';
import { parseModelThinkingConfig } from '../../shared/providers/modelThinking';
import type { Model } from '../store/slices/modelSlice';
import { i18nService } from './i18n';

export function modelPresetName(presetId: ModelPresetId): string {
  return i18nService.t(presetId === ModelPresetId.Balanced ? 'modelPresetBalanced' : 'modelPresetUltimate');
}

export function modelPresetToModel(preset: AvailableModelPreset, resolved?: Model): Model {
  return {
    ...resolved,
    id: modelPresetModelId(preset.presetId),
    presetId: preset.presetId,
    name: modelPresetName(preset.presetId),
    providerKey: ProviderName.LobsteraiServer,
    isServerModel: true,
    costMultiplier: preset.costMultiplier,
    accessible: resolved?.accessible ?? preset.accessible,
    supportsImage: resolved?.supportsImage ?? preset.supportsImage,
    supportsThinking: resolved ? resolved.supportsThinking : preset.supportsThinking === true,
    thinkingConfig: resolved ? resolved.thinkingConfig : parseModelThinkingConfig(preset.thinkingConfig),
    requestCapabilities: resolved ? resolved.requestCapabilities : parseLobsterAIRequestCapabilities(preset.requestCapabilities),
    moreModel: false,
    restrictionHint: preset.restrictionHint,
    description: i18nService.t('modelPresetPricingHint'),
  };
}
