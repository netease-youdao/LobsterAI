import { type ModelPresetId, parseModelPresetId, parseModelPresetModelId } from '../modelPresets/constants';

/** Hide the internal provider suffix without changing the model's routing ID. */
export const formatModelDisplayName = (model: string): string => model.replace(/-YoudaoInner$/i, '');

export interface MessageModelLabelParts {
  /** Preset name when the turn ran on a preset, otherwise the model name. */
  name: string;
  /** The model a preset resolved to. */
  detail: string | null;
}

/** Use the reply's recorded model rather than the session's current selection. */
export const getMessageModelLabelParts = (
  metadata: unknown,
  modelPresetName: (presetId: ModelPresetId) => string,
): MessageModelLabelParts | null => {
  const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : null;
  const modelPresetId = parseModelPresetId(record?.modelPresetId);
  const resolved = typeof record?.resolvedModelId === 'string' ? record.resolvedModelId.trim() : '';
  if (modelPresetId && resolved && !parseModelPresetModelId(resolved)) {
    return {
      name: modelPresetName(modelPresetId),
      detail: formatModelDisplayName(resolved.split('/').pop() || resolved),
    };
  }
  const model = typeof record?.model === 'string' ? record.model.trim() : '';
  const actualModel = model && !parseModelPresetModelId(model) ? model
    : resolved && !parseModelPresetModelId(resolved) ? resolved : '';
  if (!actualModel) return null;
  const label = formatModelDisplayName(actualModel.split('/').pop() || actualModel);
  const presetId = modelPresetId ?? parseModelPresetModelId(model);
  return presetId ? { name: modelPresetName(presetId), detail: label } : { name: label, detail: null };
};

export const getMessageModelLabel = (
  metadata: unknown,
  modelPresetName: (presetId: ModelPresetId) => string,
): string | null => {
  const parts = getMessageModelLabelParts(metadata, modelPresetName);
  if (!parts) return null;
  return parts.detail ? `${parts.name}（${parts.detail}）` : parts.name;
};
