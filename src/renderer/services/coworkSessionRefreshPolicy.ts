import type { CoworkSessionsChangedPayload } from '../../shared/cowork/constants';

export interface CoworkPreservedMessageWindow {
  offset: number;
  limit: number;
}

export const shouldReloadCurrentSessionForChange = (
  currentSessionId: string | null,
  payload?: CoworkSessionsChangedPayload,
): boolean => {
  if (!currentSessionId) return false;
  if (!payload || !Array.isArray(payload.sessionIds) || payload.sessionIds.length === 0) return true;
  return payload.sessionIds.includes(currentSessionId);
};

export const getPreservedMessageWindow = (
  currentOffset: number,
  refreshedOffset: number,
  refreshedTotal: number,
): CoworkPreservedMessageWindow | null => {
  const safeCurrentOffset = Math.max(0, Math.floor(currentOffset));
  const safeRefreshedOffset = Math.max(0, Math.floor(refreshedOffset));
  const safeRefreshedTotal = Math.max(0, Math.floor(refreshedTotal));

  if (safeCurrentOffset >= safeRefreshedOffset || safeCurrentOffset >= safeRefreshedTotal) {
    return null;
  }

  return {
    offset: safeCurrentOffset,
    limit: safeRefreshedTotal - safeCurrentOffset,
  };
};
