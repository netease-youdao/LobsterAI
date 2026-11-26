import type Database from 'better-sqlite3';

import { getMessageModelLabel } from '../../shared/cowork/messageModelLabel';
import { OpenClawCronRunMetadataKey } from '../../shared/cowork/openclawCronSessionKey';
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


export const ReplyModelMetadataBytes = 256 * 1024;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const labelSafe = (value: string): boolean => !/[\p{Cc}\p{Cf}]|:\/\/|localhost|\b\d{1,3}(?:\.\d{1,3}){3}\b|bearer\s|\b(?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]|\bsk-[A-Za-z0-9]/iu.test(value)
  && Buffer.from(value).toString('utf8') === value;
const concreteModel = (value: unknown): string | null => typeof value === 'string' && value.trim() && value.length <= 4096
  && labelSafe(value) && !parseModelPresetModelId(value.trim()) ? value : null;
const sameTurn = (assistant: Record<string, unknown>, user: Record<string, unknown>): boolean => {
  const assistantRun = assistant.remoteRunId, userRun = user.remoteRunId;
  if (assistantRun != null && (typeof assistantRun !== 'string' || !assistantRun)
    || userRun != null && (typeof userRun !== 'string' || !userRun)
    || assistantRun && userRun && assistantRun !== userRun) return false;
  const key = OpenClawCronRunMetadataKey.SessionKey, index = OpenClawCronRunMetadataKey.EntryIndex;
  if (assistant[key] != null || user[key] != null) {
    return typeof assistant[key] === 'string' && !!assistant[key] && assistant[key] === user[key]
      && Number.isSafeInteger(assistant[index]) && Number.isSafeInteger(user[index])
      && (user[index] as number) >= 0 && (assistant[index] as number) > (user[index] as number);
  }
  return typeof assistantRun === 'string' && !!assistantRun && assistantRun === userRun;
};

/** Read only the preceding user in this local conversation; never consult current selection/catalog. */
export function readReplyTurnPreset(db: Database.Database, sessionId: string, sequence: number,
  assistant: Record<string, unknown>, foreignRuns: ReadonlySet<string> = new Set()): unknown {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return undefined;
  const users = db.prepare(`SELECT sequence,CASE WHEN octet_length(metadata)<=? THEN metadata END AS metadata
    FROM cowork_messages WHERE session_id=? AND type='user' AND sequence<? ORDER BY sequence DESC LIMIT 2`)
    .all(ReplyModelMetadataBytes, sessionId, sequence) as Array<{ sequence: number; metadata: string | null }>;
  const user = users[0];
  if (!user?.metadata || users[1]?.sequence === user.sequence) return undefined;
  try {
    const metadata: unknown = JSON.parse(user.metadata);
    if (!record(metadata) || typeof metadata.remoteRunId === 'string' && foreignRuns.has(metadata.remoteRunId)
      || !sameTurn(assistant, metadata)) return undefined;
    return parseModelPresetId(metadata.modelPresetId);
  } catch { return undefined; }
}

/** Display evidence is independent of opaque execution modelRef/version. */
export function replyMessageModelLabel(db: Database.Database, sessionId: string, row: { type: string; sequence: number; metadata?: string | null },
  metadata: Record<string, unknown>, names: ReplyModelPresetNames = replyModelPresetNames(), selectedPresetId?: unknown,
  foreignRuns: ReadonlySet<string> = new Set()): string | null {
  if (row.type !== 'assistant') return null;
  const model = concreteModel(metadata.model), resolvedModelId = concreteModel(metadata.resolvedModelId);
  if (!model && !resolvedModelId) return null;
  // Live normalization intentionally retains only public fields. Cron provenance
  // remains local and is bounded by the same source metadata limit.
  let provenance = metadata;
  if (row.metadata && Buffer.byteLength(row.metadata) <= ReplyModelMetadataBytes) {
    try { const raw: unknown = JSON.parse(row.metadata); if (record(raw)) provenance = raw; } catch { /* No inferred turn. */ }
  }
  const virtualModel = typeof metadata.model === 'string' && labelSafe(metadata.model) ? safeModel(metadata.model) : undefined;
  const preset = parseModelPresetId(metadata.modelPresetId) ?? parseModelPresetModelId(virtualModel)
    ?? parseModelPresetId(selectedPresetId) ?? readReplyTurnPreset(db, sessionId, row.sequence, provenance, foreignRuns);
  const label = replyModelLabel({ model: model ?? undefined, resolvedModelId: resolvedModelId ?? undefined, modelPresetId: preset }, names);
  return label && labelSafe(label) && Buffer.byteLength(label) <= 480 ? label : null;
}
