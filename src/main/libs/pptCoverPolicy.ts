import { MediaPreferenceMode, type MediaSelection, MediaSelectionMode } from '../../shared/media/defaultPolicy';
import type { PptCatalog } from '../../shared/pptCreation/constants';
import { PptCover, type PptCoverRequest } from '../../shared/pptCreation/cover';

// Only main-process catalog data may attach an image budget. Renderer-supplied
// media defaults are discarded by the normal turn resolver before this hook.
export function applyCoverMediaPolicy(catalog: PptCatalog, request: PptCoverRequest, selection: MediaSelection): MediaSelection {
  const model = catalog.coverImageModel ?? PptCover.DefaultImageModel;
  if (!catalog.enabled || catalog.version !== request.version || !catalog.examples.some(example => example.id === request.exampleId && example.cover)
    || selection.mode === MediaSelectionMode.None || selection.imageModelId !== model) throw new Error('Cover image configuration changed or unavailable');
  return { ...selection, mode: MediaSelectionMode.Image, modelId: model, imageModelId: model,
    videoModelId: undefined, videoDefault: undefined, videoPreference: MediaPreferenceMode.Off,
    imageDefault: { enabled: true, modelId: model, modelName: selection.modelName ?? model,
      params: { n: 1, size: '2848x1600' }, maxOutputsPerTurn: 1 } };
}
