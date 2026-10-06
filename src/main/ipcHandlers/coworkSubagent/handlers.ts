import { ipcMain } from 'electron';

import { CoworkIpcChannel } from '../../../shared/cowork/constants';

export interface CoworkSubagentRuntimeAdapter {
  getSubTaskHistory: (
    parentSessionId: string,
    agentId: string,
    sessionKey?: string,
  ) => Promise<unknown>;
  listSubagentRuns: (parentSessionId: string) => unknown[];
  listSubagentRunsByAgent: (
    agentId: string,
    limit: number,
    offset: number,
  ) => { runs: unknown[]; hasMore: boolean };
}

export interface CoworkSubagentEngineRouter {
  deleteSubagentSession: (parentSessionId: string, runId: string) => Promise<boolean>;
}

export interface CoworkSubagentHandlerDeps {
  getOpenClawRuntimeAdapter: () => CoworkSubagentRuntimeAdapter | null;
  getCoworkEngineRouter: () => CoworkSubagentEngineRouter;
}

export function registerCoworkSubagentHandlers(deps: CoworkSubagentHandlerDeps): void {
  const { getOpenClawRuntimeAdapter, getCoworkEngineRouter } = deps;

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
      const adapter = getOpenClawRuntimeAdapter();
      if (!adapter) {
        return { success: false, error: 'Runtime adapter not available' };
      }
      try {
        const messages = await adapter.getSubTaskHistory(
          options.parentSessionId,
          options.agentId,
          options.sessionKey,
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
    const adapter = getOpenClawRuntimeAdapter();
    if (!adapter) return { success: true, runs: [] };
    const runs = adapter.listSubagentRuns(options.parentSessionId);
    return { success: true, runs };
  });

  ipcMain.handle(
    CoworkIpcChannel.SubagentListByAgent,
    async (_event, options: { agentId: string; limit?: number; offset?: number }) => {
      const adapter = getOpenClawRuntimeAdapter();
      if (!adapter) return { success: true, runs: [], hasMore: false };
      const result = adapter.listSubagentRunsByAgent(
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
      const adapter = getOpenClawRuntimeAdapter();
      if (!adapter) {
        return { success: false, error: 'Runtime adapter not available' };
      }
      try {
        const deleted = await getCoworkEngineRouter().deleteSubagentSession(
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
