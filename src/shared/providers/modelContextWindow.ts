import { type ModelPresetId, modelPresetModelId } from '../modelPresets/constants';

export const CONTEXT_WINDOW_SELECTION_CAPABILITY = 'context-window-selection-v1';
export const DEFAULT_CONTEXT_WINDOW_SELECTION = 'model-default';
export const USER_CONTEXT_WINDOW_SELECTION_PREFIX = 'user-context:';
export const MIN_SELECTABLE_CONTEXT_WINDOW = 400_000;
export const MAX_SELECTABLE_CONTEXT_WINDOW = 1_000_000;

export const ModelContextWindowIpc = {
  Get: 'model-context-window:get',
  Set: 'model-context-window:set',
} as const;

export interface ModelContextWindowMetadata {
  contextWindow?: number;
  contextWindowOptions?: number[];
  presetContextWindows?: Partial<Record<ModelPresetId, number | null>>;
  presetContextWindowOptions?: Partial<Record<ModelPresetId, number[]>>;
}

export interface ModelContextWindowRequest {
  modelId: string;
  presetId?: ModelPresetId;
  sessionId?: string;
}

export interface ModelContextWindowState {
  options: number[];
  defaultWindow?: number;
  override: number | null;
}

export function parseContextWindowOptions(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = [...new Set(value.filter((tokens): tokens is number =>
    typeof tokens === 'number' && Number.isInteger(tokens)
    && tokens >= MIN_SELECTABLE_CONTEXT_WINDOW && tokens <= MAX_SELECTABLE_CONTEXT_WINDOW))].sort((a, b) => a - b);
  return options.length ? options : undefined;
}

export function selectableContextWindows(model: ModelContextWindowMetadata | null, presetId?: ModelPresetId): number[] {
  const options = parseContextWindowOptions(model?.contextWindowOptions) ?? [];
  const presetOptions = presetId ? model?.presetContextWindowOptions?.[presetId] ?? [] : options;
  return options.filter(tokens => presetOptions.includes(tokens));
}

export function userContextWindowSelection(tokens: number, presetId?: ModelPresetId): string {
  return `${USER_CONTEXT_WINDOW_SELECTION_PREFIX}${presetId ? `${modelPresetModelId(presetId)}:` : ''}${tokens}`;
}

export function contextWindowPreferenceModelKey(modelId: string, presetId?: ModelPresetId): string {
  return presetId ? modelPresetModelId(presetId) : modelId;
}
