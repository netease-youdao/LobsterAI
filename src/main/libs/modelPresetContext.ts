import { ModelPresetId, modelPresetModelId } from '../../shared/modelPresets/constants';
import {
  DEFAULT_CONTEXT_WINDOW_SELECTION,
  type ModelContextWindowMetadata,
  selectableContextWindows,
  userContextWindowSelection,
} from '../../shared/providers/modelContextWindow';

type PresetModelContext = ModelContextWindowMetadata;

const DEFAULT_PRESET_CONTEXT_WINDOW = 400_000;
// Same fallback as the pinned OpenClaw runtime when the model has no window metadata.
const DEFAULT_NATIVE_CONTEXT_WINDOW = 200_000;

export function presetContextWindowSelection(model: PresetModelContext | null, presetId?: ModelPresetId | null): string | null {
  return presetId && model?.presetContextWindows
    ? modelPresetModelId(presetId) : null;
}

export function buildPresetContextWindows(model: PresetModelContext): {
  contextWindows?: Array<{ id: string; label: string; contextWindow: number }>;
  contextWindowDefault?: string;
} {
  const hasPresets = !!presetContextWindowSelection(model, ModelPresetId.Balanced);
  if (!hasPresets && !model.contextWindowOptions?.length) return {};
  const original = typeof model.contextWindow === 'number' && Number.isInteger(model.contextWindow) && model.contextWindow > 0
    ? model.contextWindow : DEFAULT_NATIVE_CONTEXT_WINDOW;
  return {
    contextWindowDefault: DEFAULT_CONTEXT_WINDOW_SELECTION,
    contextWindows: [
      { id: DEFAULT_CONTEXT_WINDOW_SELECTION, label: String(original), contextWindow: original },
      ...(hasPresets ? Object.values(ModelPresetId) : []).map(presetId => {
        const configured = model.presetContextWindows?.[presetId];
        const contextWindow = typeof configured === 'number' && Number.isInteger(configured) && configured >= 4_000
          ? configured : DEFAULT_PRESET_CONTEXT_WINDOW;
        return { id: modelPresetModelId(presetId), label: String(contextWindow), contextWindow };
      }),
      ...[undefined, ...Object.values(ModelPresetId)].flatMap(presetId =>
        selectableContextWindows(model, presetId).map(contextWindow => ({
          id: userContextWindowSelection(contextWindow, presetId), label: String(contextWindow), contextWindow,
        }))),
    ],
  };
}
