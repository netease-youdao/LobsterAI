import * as path from 'path';

export type ReconciledConversationEntry = {
  role: 'user' | 'assistant';
  text: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

const normalizeLocalMediaPathKey = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\\/g, '/').toLowerCase();
};

export const getLocalMediaAttachmentsKey = (metadata: unknown): string => {
  if (!isRecord(metadata) || !Array.isArray(metadata.localMediaAttachments)) {
    return '';
  }
  return metadata.localMediaAttachments
    .map((item) => {
      if (!isRecord(item)) return '';
      const localPath = normalizeLocalMediaPathKey(item.localPath);
      if (!localPath) return '';
      const mimeType = typeof item.mimeType === 'string' ? item.mimeType.trim().toLowerCase() : '';
      return `${localPath}\x1e${mimeType}`;
    })
    .filter(Boolean)
    .sort()
    .join('\x1f');
};

export const buildGatewayMediaMetadata = (
  entry: { mediaAttachments?: Array<{ localPath: string; mimeType?: string }> },
): Record<string, unknown> | undefined => {
  const attachments = entry.mediaAttachments
    ?.map((attachment) => {
      const localPath = attachment.localPath.trim();
      if (!localPath) return null;
      const mimeType = attachment.mimeType?.trim();
      return {
        localPath,
        ...(mimeType ? { mimeType } : {}),
        name: path.basename(localPath),
      };
    })
    .filter((attachment): attachment is { localPath: string; mimeType?: string; name: string } => attachment !== null);

  return attachments?.length ? { localMediaAttachments: attachments } : undefined;
};

export const isSameHistoryEntry = (
  left: { role: 'user' | 'assistant'; text: string },
  right: { role: 'user' | 'assistant'; text: string },
): boolean => left.role === right.role && left.text === right.text;

export const isSameReconciledEntry = (
  left: { role: 'user' | 'assistant'; text: string; metadata?: Record<string, unknown> },
  right: { role: 'user' | 'assistant'; text: string; metadata?: Record<string, unknown> },
): boolean => {
  return isSameHistoryEntry(left, right)
    && getLocalMediaAttachmentsKey(left.metadata) === getLocalMediaAttachmentsKey(right.metadata);
};

const historyEntryKey = (entry: { role: 'user' | 'assistant'; text: string }): string => {
  return `${entry.role}\x1f${entry.text}`;
};

const isValidMessageTimestamp = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
};

export const applyLocalTimestampsToEntries = (
  entries: ReconciledConversationEntry[],
  localEntries: Array<{ role: 'user' | 'assistant'; text: string; timestamp?: number }>,
): ReconciledConversationEntry[] => {
  const localTimestamps = new Map<string, number[]>();
  for (const entry of localEntries) {
    if (!isValidMessageTimestamp(entry.timestamp)) continue;
    const key = historyEntryKey(entry);
    const timestamps = localTimestamps.get(key) ?? [];
    timestamps.push(entry.timestamp);
    localTimestamps.set(key, timestamps);
  }

  return entries.map((entry) => {
    if (isValidMessageTimestamp(entry.timestamp)) {
      return entry;
    }
    const timestamps = localTimestamps.get(historyEntryKey(entry));
    const timestamp = timestamps?.shift();
    return timestamp != null ? { ...entry, timestamp } : entry;
  });
};

/**
 * Find the tail-alignment point between local and authoritative entries.
 *
 * `chat.history` can return a bounded tail window that starts in the middle of
 * a turn, often with an assistant entry before the first user anchor. Prefer a
 * full role/text overlap first; then fall back to user-message anchors and
 * report both the local and authoritative start indices so leading orphan
 * assistant entries are not duplicated into the local prefix on every poll.
 */
export const findTailAlignment = (
  localEntries: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
  authEntries: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
): { localIdx: number; authIdx: number } | null => {
  if (authEntries.length === 0) return null;
  if (localEntries.length === 0) return { localIdx: 0, authIdx: 0 };

  const maxEntryOverlap = Math.min(localEntries.length, authEntries.length);
  for (let overlap = maxEntryOverlap; overlap >= 1; overlap -= 1) {
    const localStart = localEntries.length - overlap;
    let match = true;
    for (let idx = 0; idx < overlap; idx += 1) {
      if (!isSameHistoryEntry(localEntries[localStart + idx], authEntries[idx])) {
        match = false;
        break;
      }
    }
    if (match) {
      return { localIdx: localStart, authIdx: 0 };
    }
  }

  const localUsers: Array<{ idx: number; text: string }> = [];
  for (let i = 0; i < localEntries.length; i++) {
    if (localEntries[i].role === 'user') {
      localUsers.push({ idx: i, text: localEntries[i].text });
    }
  }

  const authUsers: Array<{ idx: number; text: string }> = [];
  for (let i = 0; i < authEntries.length; i++) {
    const entry = authEntries[i];
    if (entry.role === 'user') {
      authUsers.push({ idx: i, text: entry.text });
    }
  }

  if (authUsers.length === 0 || localUsers.length === 0) {
    return { localIdx: 0, authIdx: 0 };
  }

  const maxK = Math.min(localUsers.length, authUsers.length);
  for (let k = maxK; k >= 1; k--) {
    const localStart = localUsers.length - k;
    let match = true;
    for (let j = 0; j < k; j++) {
      if (localUsers[localStart + j].text !== authUsers[j].text) {
        match = false;
        break;
      }
    }
    if (match) {
      const localIdx = localUsers[localStart].idx;
      const authIdx = authUsers[0].idx;
      if (authIdx > 0) {
        const leadingLocalIdx = localIdx - authIdx;
        const leadingAuthAlreadyPresent = leadingLocalIdx >= 0
          && authEntries.slice(0, authIdx).every((entry, idx) =>
            isSameHistoryEntry(localEntries[leadingLocalIdx + idx], entry),
          );
        if (!leadingAuthAlreadyPresent) {
          return {
            localIdx: Math.max(0, leadingLocalIdx),
            authIdx: 0,
          };
        }
      }
      return {
        localIdx,
        authIdx,
      };
    }
  }

  return null;
};
