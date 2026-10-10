import { type ModelThinkingConfig, type ModelThinkingLevel, parseModelThinkingLevel } from '../providers/modelThinking';

export const ModelPresetId = {
  Balanced: 'balanced',
  Ultimate: 'ultimate',
} as const;
export type ModelPresetId = typeof ModelPresetId[keyof typeof ModelPresetId];

export const ModelPresetIpc = {
  Available: 'model-presets:available',
  SelectSession: 'model-presets:select-session',
  GetPreferences: 'model-presets:preferences:get',
  SetPreference: 'model-presets:preferences:set',
} as const;

export function parseModelPresetId(value: unknown): ModelPresetId | null {
  return value === ModelPresetId.Balanced || value === ModelPresetId.Ultimate ? value : null;
}

export const modelPresetModelId = (presetId: ModelPresetId): string => `model-preset:${presetId}`;
export const modelPresetPreferenceKey = (ownerAccountKey: string): string => `chat_model_presets:${ownerAccountKey}`;

export interface AvailableModelPreset {
  presetId: ModelPresetId;
  costMultiplier: number;
  accessible: boolean;
  supportsImage: boolean;
  supportsThinking?: boolean;
  thinkingConfig?: ModelThinkingConfig | null;
  requestCapabilities?: string[];
  restrictionHint?: string;
}

export interface ModelPresetPreference {
  presetId: ModelPresetId;
  thinkingLevel?: ModelThinkingLevel;
}

export function parseModelPresetPreference(value: unknown): ModelPresetPreference | null {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const presetId = parseModelPresetId(record ? record.presetId : value);
  return presetId ? { presetId, thinkingLevel: parseModelThinkingLevel(record?.thinkingLevel) } : null;
}

export function isChatPresetSession(session: { scheduledTaskId?: string | null; claudeSessionId?: string | null }): boolean {
  if (session.scheduledTaskId) return false;
  const key = session.claudeSessionId?.trim();
  return !key || key.startsWith('lobsterai:') || /^agent:[^:]+:lobsterai:.+/.test(key);
}
