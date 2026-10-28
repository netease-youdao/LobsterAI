import { MediaPreferenceMode, type MediaSelection, MediaSelectionMode } from '../media/defaultPolicy';

export function hasImageEditModel(selection?: MediaSelection): boolean {
  return !!selection && selection.mode !== MediaSelectionMode.None && selection.imagePreference !== MediaPreferenceMode.Off
    && !!(selection.imageModelId || selection.imageDefault?.modelId || (selection.mode === MediaSelectionMode.Image && selection.modelId));
}
