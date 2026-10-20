import { type ModelPresetId, parseModelPresetId, parseModelPresetModelId } from '../modelPresets/constants';

/** Hide the internal provider suffix without changing the model's routing ID. */
export const formatModelDisplayName = (model: string): string => model.replace(/-YoudaoInner$/i, '');

/** Use the reply's recorded model rather than the session's current selection. */
export const getMessageModelLabel = (
  metadata: unknown,
  modelPresetName: (presetId: ModelPresetId) => string,
): string | null => {
  const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : null;
  const modelPresetId = parseModelPresetId(record?.modelPresetId);
  const resolved = typeof record?.resolvedModelId === 'string' ? record.resolvedModelId.trim() : '';
  if (modelPresetId && resolved && !parseModelPresetModelId(resolved)) {
    return `${modelPresetName(modelPresetId)}（${formatModelDisplayName(resolved.split('/').pop() || resolved)}）`;
  }
  const model = typeof record?.model === 'string' ? record.model.trim() : '';
  const actualModel = model && !parseModelPresetModelId(model) ? model
    : resolved && !parseModelPresetModelId(resolved) ? resolved : '';
  if (!actualModel) return null;
  const label = formatModelDisplayName(actualModel.split('/').pop() || actualModel);
  const presetId = modelPresetId ?? parseModelPresetModelId(model);
  return presetId ? `${modelPresetName(presetId)}（${label}）` : label;
};
