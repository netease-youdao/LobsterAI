import { getMessageModelLabel } from '../../shared/cowork/messageModelLabel';
import { ModelPresetId, parseModelPresetId, parseModelPresetModelId } from '../../shared/modelPresets/constants';
import { t } from '../i18n';

export type ReplyModelPresetNames = Record<ModelPresetId, string>;

/** Capture the desktop language before handing projection to an isolated worker. */
export const replyModelPresetNames = (): ReplyModelPresetNames => ({
  [ModelPresetId.Balanced]: t('modelPresetBalanced'),
  [ModelPresetId.Ultimate]: t('modelPresetUltimate'),
});

const safeModel = (value: unknown): string | undefined => typeof value === 'string'
  && !/(?:[\u0000-\u001f\u007f]|:\/\/|localhost|\b\d{1,3}(?:\.\d{1,3}){3}\b|sk-[A-Za-z0-9])/iu.test(value) ? value : undefined;

export function replyModelLabel(metadata: Record<string, unknown>,
  names: ReplyModelPresetNames = replyModelPresetNames(), selectedPresetId?: unknown): string | null {
  const label = getMessageModelLabel({
    model: safeModel(metadata.model),
    resolvedModelId: safeModel(metadata.resolvedModelId),
    // Prefer the reply's explicit tier/route; otherwise use this run's frozen selection.
    modelPresetId: parseModelPresetId(metadata.modelPresetId)
      ?? parseModelPresetModelId(safeModel(metadata.model)) ?? parseModelPresetId(selectedPresetId),
  }, presetId => names[presetId]);
  return label ? label.slice(0, 120).replace(/[\uD800-\uDBFF]$/u, '') : null;
}

/** Change only the message label, using this run's frozen selection and this message's execution metadata. */
export function replyInputModel(role: string, metadata: Record<string, unknown>, original: unknown,
  names: ReplyModelPresetNames = replyModelPresetNames(), selectedPresetId?: unknown): unknown {
  if ((role !== 'user' && role !== 'assistant') || !original || typeof original !== 'object' || Array.isArray(original)) return original;
  const model = original as Record<string, unknown>;
  const label = replyModelLabel(metadata, names, selectedPresetId);
  return label ? { ...model, displayName: label } : original;
}
