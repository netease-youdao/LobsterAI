import { ipcMain } from 'electron';

import { CoworkIpcChannel } from '../../../shared/cowork/constants';
import type { RemoteOwner } from '../../../shared/remote/constants';

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
    actor?: RemoteOwner | null,
  ) => { runs: unknown[]; hasMore: boolean };
}

export interface CoworkSubagentEngineRouter {
  deleteSubagentSession: (parentSessionId: string, runId: string) => Promise<boolean>;
}

export interface CoworkSubagentHandlerDeps {
  getOwner: () => RemoteOwner | null;
  assertSessionAccess: (sessionId: string) => void;
  assertAgentAccess: (agentId: string) => void;
  assertRunAccess: (parentSessionId: string, runId: string, sessionKey?: string) => void;
  beginDeleteOperation?: (parentSessionId: string, runId: string) => () => void;
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
        deps.assertSessionAccess(options.parentSessionId);
        deps.assertRunAccess(options.parentSessionId, options.agentId, options.sessionKey);
        const messages = await adapter.getSubTaskHistory(
          options.parentSessionId,
          options.agentId,
          options.sessionKey,
        );
        deps.assertSessionAccess(options.parentSessionId);
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
    try {
      deps.assertSessionAccess(options.parentSessionId);
      const runs = adapter.listSubagentRuns(options.parentSessionId);
      return { success: true, runs };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Session unavailable' };
    }
  });

  ipcMain.handle(
    CoworkIpcChannel.SubagentListByAgent,
    async (_event, options: { agentId: string; limit?: number; offset?: number }) => {
      const adapter = getOpenClawRuntimeAdapter();
      if (!adapter) return { success: true, runs: [], hasMore: false };
      try {
        deps.assertAgentAccess(options.agentId);
        const result = adapter.listSubagentRunsByAgent(
        options.agentId,
        options.limit ?? 20,
        options.offset ?? 0,
        deps.getOwner(),
      );
      return { success: true, ...result };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Agent unavailable' };
      }
    },
  );

  ipcMain.handle(
    CoworkIpcChannel.SubagentDelete,
    async (_event, options: { parentSessionId: string; runId: string }) => {
      let release: (() => void) | undefined;
      const adapter = getOpenClawRuntimeAdapter();
      if (!adapter) {
        return { success: false, error: 'Runtime adapter not available' };
      }
      try {
        deps.assertSessionAccess(options.parentSessionId);
        deps.assertRunAccess(options.parentSessionId, options.runId);
        release = deps.beginDeleteOperation?.(options.parentSessionId, options.runId);
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
      } finally { release?.(); }
    },
  );
}
