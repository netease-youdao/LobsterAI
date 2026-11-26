import { ipcMain } from 'electron';

import { CoworkIpcChannel } from '../../../shared/cowork/constants';
import type { DshSubagentSessions } from '../../libs/dsh/dshSubagentSessions';

export interface CoworkSubagentHandlerDeps {
  getSubagentSessions: () => Pick<DshSubagentSessions,
    'getSubTaskHistory' | 'listSubagentRuns' | 'listSubagentRunsByAgent' | 'deleteSubagentSession'>;
}

export function registerCoworkSubagentHandlers(deps: CoworkSubagentHandlerDeps): void {
  const { getSubagentSessions } = deps;

  ipcMain.handle(
    CoworkIpcChannel.SubTaskHistory,
    async (
      _event,
      options: {
        parentSessionId: string;
        agentId: string;
        sessionKey?: string;
      },
    ) => {
      try {
        const messages = await getSubagentSessions().getSubTaskHistory(
          options.parentSessionId,
          options.agentId,
        );
        return { success: true, messages };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch subagent history',
        };
      }
    },
  );

  ipcMain.handle(CoworkIpcChannel.SubagentList, async (_event, options: { parentSessionId: string }) => {
    const runs = await getSubagentSessions().listSubagentRuns(options.parentSessionId);
    return { success: true, runs };
  });

  ipcMain.handle(
    CoworkIpcChannel.SubagentListByAgent,
    async (_event, options: { agentId: string; limit?: number; offset?: number }) => {
      const result = getSubagentSessions().listSubagentRunsByAgent(
        options.agentId,
        options.limit ?? 20,
        options.offset ?? 0,
      );
      return { success: true, ...result };
    },
  );

  ipcMain.handle(
    CoworkIpcChannel.SubagentDelete,
    async (_event, options: { parentSessionId: string; runId: string }) => {
      try {
        const deleted = await getSubagentSessions().deleteSubagentSession(
          options.parentSessionId,
          options.runId,
        );
        return { success: true, deleted };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete subagent session',
        };
      }
    },
  );
}
