import { ipcMain } from 'electron';

import { CoworkIpcChannel } from '../../../shared/cowork/constants';
import type { CoworkSessionSummary, CoworkStore } from '../../coworkStore';

export interface CoworkPinnedHandlerDeps {
  getCoworkStore: () => Pick<CoworkStore, 'reorderPinnedSessions'>;
}

export interface ReorderPinnedSessionsResult {
  success: boolean;
  sessions?: CoworkSessionSummary[];
  error?: string;
}

export const handleReorderPinnedSessions = (
  deps: CoworkPinnedHandlerDeps,
  options?: { sessionIds?: unknown },
): ReorderPinnedSessionsResult => {
  try {
    const rawIds = options?.sessionIds;
    if (!Array.isArray(rawIds)) {
      return { success: false, error: 'sessionIds must be an array' };
    }
    const sessionIds = rawIds.filter((id): id is string => typeof id === 'string');
    const sessions = deps.getCoworkStore().reorderPinnedSessions(sessionIds);
    return { success: true, sessions };
  } catch (error) {
    console.error('[CoworkPinnedIPC] failed to reorder pinned sessions:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reorder pinned sessions',
    };
  }
};

export function registerCoworkPinnedHandlers(deps: CoworkPinnedHandlerDeps): void {
  ipcMain.handle(
    CoworkIpcChannel.ReorderPinnedSessions,
    async (_event, options?: { sessionIds?: unknown }) => (
      handleReorderPinnedSessions(deps, options)
    ),
  );
}
