import type { CoworkMessage } from '../../coworkStore';
import {
  extractGatewayHistoryEntries,
  shouldSuppressHeartbeatText,
} from '../openclawHistory';
import {
  isSameHistoryEntry,
  type ReconciledConversationEntry,
} from './openclawConversationReconciliation';

export type CronRunHistoryEntry = ReconciledConversationEntry;

export type CronRunLocalHistoryEntry = CronRunHistoryEntry & {
  id: string;
};

const CronRunHistoryMetadataKey = {
  SessionKey: 'openclawCronRunSessionKey',
  EntryIndex: 'openclawCronRunEntryIndex',
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

export const getCronRunHistorySessionKey = (metadata: unknown): string | null => {
  if (!isRecord(metadata)) return null;
  const value = metadata[CronRunHistoryMetadataKey.SessionKey];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const withCronRunHistoryMetadata = (
  entry: CronRunHistoryEntry,
  sessionKey: string,
  entryIndex: number,
): CronRunHistoryEntry => ({
  ...entry,
  metadata: {
    ...(entry.metadata ?? {}),
    [CronRunHistoryMetadataKey.SessionKey]: sessionKey,
    [CronRunHistoryMetadataKey.EntryIndex]: entryIndex,
  },
});

export const buildCronRunHistoryEntries = (
  historyMessages: unknown[],
  sessionKey: string,
): CronRunHistoryEntry[] => {
  const entries: CronRunHistoryEntry[] = [];

  for (const entry of extractGatewayHistoryEntries(historyMessages)) {
    const role = entry.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = entry.text.trim();
    if (!text || shouldSuppressHeartbeatText(role, text)) continue;

    let metadata: Record<string, unknown> | undefined;
    if (role === 'assistant' && (entry.usage || entry.model)) {
      metadata = {};
      if (entry.usage) {
        metadata.usage = {
          ...(entry.usage.input != null && { inputTokens: entry.usage.input }),
          ...(entry.usage.output != null && { outputTokens: entry.usage.output }),
        };
      }
      if (entry.model) {
        metadata.model = entry.model;
      }
    }

    entries.push(withCronRunHistoryMetadata({
      role,
      text,
      ...(metadata && { metadata }),
      ...(entry.timestamp != null && { timestamp: entry.timestamp }),
    }, sessionKey, entries.length));
  }

  return entries;
};

export const buildCronRunLocalHistoryEntries = (
  messages: CoworkMessage[],
): CronRunLocalHistoryEntry[] => {
  return messages
    .filter((message) => message.type === 'user' || message.type === 'assistant')
    .map((message) => ({
      id: message.id,
      role: message.type as 'user' | 'assistant',
      text: message.content.trim(),
      metadata: isRecord(message.metadata) ? message.metadata : undefined,
      timestamp: message.timestamp,
    }))
    .filter((entry) => entry.text && !shouldSuppressHeartbeatText(entry.role, entry.text));
};

export const hasCronRunHistoryForSession = (
  messages: CoworkMessage[],
  sessionKey: string,
): boolean => {
  return messages.some((message) => getCronRunHistorySessionKey(message.metadata) === sessionKey);
};

export const isLocalConversationCoveredByCronHistory = (
  localEntries: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
  authoritativeEntries: ReadonlyArray<CronRunHistoryEntry>,
): boolean => {
  if (localEntries.length > authoritativeEntries.length) return false;

  let authIdx = 0;
  for (const local of localEntries) {
    let matched = false;
    while (authIdx < authoritativeEntries.length) {
      const authoritative = authoritativeEntries[authIdx++];
      if (isSameHistoryEntry(local, authoritative)) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
};

export const shouldReplaceLocalConversationWithCronHistory = (
  localEntries: ReadonlyArray<CronRunLocalHistoryEntry>,
  authoritativeEntries: ReadonlyArray<CronRunHistoryEntry>,
  sessionKey: string,
): boolean => {
  const hasOtherCronRunHistory = localEntries.some((entry) => {
    const importedSessionKey = getCronRunHistorySessionKey(entry.metadata);
    return Boolean(importedSessionKey && importedSessionKey !== sessionKey);
  });

  return !hasOtherCronRunHistory
    && isLocalConversationCoveredByCronHistory(localEntries, authoritativeEntries);
};

export const findCronRunHistoryLocalMatch = (
  authoritative: CronRunHistoryEntry,
  localEntries: ReadonlyArray<CronRunLocalHistoryEntry>,
  usedLocalMessageIds: ReadonlySet<string>,
  sessionKey: string,
): CronRunLocalHistoryEntry | undefined => {
  return localEntries.find((entry) => {
    if (usedLocalMessageIds.has(entry.id)) return false;
    if (!isSameHistoryEntry(entry, authoritative)) return false;
    const importedSessionKey = getCronRunHistorySessionKey(entry.metadata);
    return !importedSessionKey || importedSessionKey === sessionKey;
  });
};
