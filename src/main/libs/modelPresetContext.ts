import { ModelPresetId, modelPresetModelId } from '../../shared/modelPresets/constants';

type PresetModelContext = {
  contextWindow?: number;
  presetContextWindows?: Partial<Record<ModelPresetId, number | null>>;
};

const DEFAULT_CONTEXT_WINDOW_ID = 'model-default';
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
  if (!presetContextWindowSelection(model, ModelPresetId.Balanced)) return {};
  const original = typeof model.contextWindow === 'number' && Number.isInteger(model.contextWindow) && model.contextWindow > 0
    ? model.contextWindow : DEFAULT_NATIVE_CONTEXT_WINDOW;
  return {
    contextWindowDefault: DEFAULT_CONTEXT_WINDOW_ID,
    contextWindows: [
      { id: DEFAULT_CONTEXT_WINDOW_ID, label: String(original), contextWindow: original },
      ...Object.values(ModelPresetId).map(presetId => {
        const configured = model.presetContextWindows?.[presetId];
        const contextWindow = typeof configured === 'number' && Number.isInteger(configured) && configured >= 4_000
          ? configured : DEFAULT_PRESET_CONTEXT_WINDOW;
        return { id: modelPresetModelId(presetId), label: String(contextWindow), contextWindow };
      }),
    ],
  };
}
