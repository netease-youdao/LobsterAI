import {
  MediaPreferenceMode,
  type MediaSelection,
  MediaType,
} from '../../../shared/media/defaultPolicy';
import { canonicalizeMediaModelId, mediaModelDisplayName } from '../../../shared/mediaModelAliases';
import type { MediaModel } from '../../types/mediaGeneration';
import { resolveMediaTypeChoice } from './mediaTypeChoice';

export interface CustomMediaModelBadge {
  /** Primary model name shown on the compact toolbar pill. */
  primaryName: string;
  /** Every explicitly chosen model name, in image-then-video order, for tooltips. */
  names: string[];
  /** Which media types carry an explicit user model selection. */
  types: MediaType[];
  /** Number of explicitly chosen custom media models (1 or 2). */
  count: number;
}

type MediaModelSummary = Pick<MediaModel, 'modelId' | 'displayName'>;

const resolveSelectedModelName = (
  selection: MediaSelection,
  modelId: string,
  models: readonly MediaModelSummary[],
): string => {
  const canonicalId = canonicalizeMediaModelId(modelId);
  const catalogMatch = models.find(
    (model) => canonicalizeMediaModelId(model.modelId) === canonicalId,
  );
  if (catalogMatch?.displayName) {
    return catalogMatch.displayName;
  }
  const selectionCanonicalId = selection.modelId
    ? canonicalizeMediaModelId(selection.modelId)
    : '';
  const fallbackName = selectionCanonicalId === canonicalId ? selection.modelName : undefined;
  return mediaModelDisplayName(canonicalId, fallbackName);
};

/**
 * Returns a toolbar badge descriptor only when the user explicitly overrode
 * System Default with a concrete image and/or video model. System Default and
 * Off stay invisible to keep the composer clutter-free.
 */
export function resolveCustomMediaModelBadge(
  selection: MediaSelection | undefined,
  mediaModels?: { image: readonly MediaModelSummary[]; video: readonly MediaModelSummary[] },
): CustomMediaModelBadge | null {
  if (!selection) return null;

  const entries: Array<{ type: MediaType; name: string }> = [];
  for (const type of [MediaType.Image, MediaType.Video] as const) {
    const choice = resolveMediaTypeChoice(selection, type);
    if (choice.preference !== MediaPreferenceMode.Selected || !choice.modelId) {
      continue;
    }
    const list = type === MediaType.Image
      ? (mediaModels?.image ?? [])
      : (mediaModels?.video ?? []);
    entries.push({
      type,
      name: resolveSelectedModelName(selection, choice.modelId, list),
    });
  }

  if (entries.length === 0) return null;

  return {
    primaryName: entries[0].name,
    names: entries.map((entry) => entry.name),
    types: entries.map((entry) => entry.type),
    count: entries.length,
  };
}

/**
 * Returns true when either image or video has been explicitly customized away
 * from System Default (either a specific model or disabled).
 */
export function hasNonDefaultMediaPreference(selection: MediaSelection | undefined): boolean {
  if (!selection) return false;
  return [MediaType.Image, MediaType.Video].some((type) => {
    const preference = resolveMediaTypeChoice(selection, type).preference;
    return preference === MediaPreferenceMode.Selected || preference === MediaPreferenceMode.Off;
  });
}
