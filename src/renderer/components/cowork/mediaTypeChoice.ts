import {
  type MediaPreference,
  MediaPreferenceMode,
  type MediaSelection,
  MediaSelectionSource,
  MediaType,
} from '../../../shared/media/defaultPolicy';
import { canonicalizeMediaModelId, mediaModelDisplayName } from '../../../shared/mediaModelAliases';

/**
 * One media type's row in the picker: system default, a model the user
 * picked, or no generation. Exactly one row carries the check.
 */
export interface MediaTypeChoice {
  /** Undefined until preferences load, so no row is checked yet. */
  preference?: MediaPreference['mode'];
  /** The model the type resolves to: the user's pick or the system default. */
  modelId?: string;
  /** The system default's name, shown on the default row while it is in use. */
  defaultModelName?: string;
}

export function resolveMediaTypeChoice(selection: MediaSelection | undefined, type: MediaType): MediaTypeChoice {
  if (!selection) return {};
  const isImage = type === MediaType.Image;
  const rawModelId = (isImage ? selection.imageModelId : selection.videoModelId)
    ?? (selection.mode === type ? selection.modelId : undefined);
  const modelId = canonicalizeMediaModelId(rawModelId) || undefined;
  const source = isImage ? selection.imageSource : selection.videoSource;
  const preference = (isImage ? selection.imagePreference : selection.videoPreference)
    ?? (source === MediaSelectionSource.Default ? MediaPreferenceMode.Inherit
      : source === MediaSelectionSource.Off || !modelId ? MediaPreferenceMode.Off
        : MediaPreferenceMode.Selected);
  const defaultModel = isImage ? selection.imageDefault : selection.videoDefault;
  const defaultModelName = preference === MediaPreferenceMode.Inherit && modelId
    ? mediaModelDisplayName(modelId, defaultModel?.modelName)
    : undefined;
  return { preference, modelId, defaultModelName };
}
