import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';

import { CoworkIpcChannel } from '../../../shared/cowork/constants';
import type { MediaConfirmationCommand } from '../../../shared/media/confirmation';
import { type CoworkPermissionSubmission, submitCoworkPermission } from '../../coworkPermissionIpc';
import type { CoworkRuntime } from '../../libs/agentEngine/types';
import type { McpRuntime } from '../../mcp/mcpRuntime';

interface Dependencies {
  ipcMain: Pick<IpcMain, 'handle'>;
  sender: () => WebContents | undefined;
  runtime: () => CoworkRuntime;
  mcp: () => Pick<McpRuntime, 'getPendingMediaConfirmations' | 'actOnMediaConfirmation' | 'canAccessLocalQuestion' | 'resolveAskUser'>;
  canViewSession: (id: string) => boolean;
  sessionForRequest: (id: string) => string | undefined;
  isRuntimeRequest: (id: string) => boolean;
  accountKey: () => string;
  sanitize: (request: unknown) => unknown;
}

export function registerCoworkPermissionHandlers(deps: Dependencies): void {
  const trusted = (event: IpcMainInvokeEvent) => {
    const owner = deps.sender();
    return !!owner && event.sender === owner && event.senderFrame === owner.mainFrame;
  };
  const visible = (id: string) => deps.canViewSession(id) && deps.runtime().getSessionConfirmationMode(id) !== 'text';

  deps.ipcMain.handle(CoworkIpcChannel.GetPendingQuestions, event => {
    if (!trusted(event)) return [];
    const runtime = deps.runtime();
    const native = (runtime.getPendingQuestions?.() ?? []).filter(item => visible(item.sessionId));
    const mcp = deps.mcp();
    const media = mcp.getPendingMediaConfirmations().filter(item =>
      visible(item.sessionId) && mcp.canAccessLocalQuestion(item.requestId));
    return [...native, ...media].map(deps.sanitize);
  });

  deps.ipcMain.handle(CoworkIpcChannel.MediaConfirmation, async (event, command: MediaConfirmationCommand) => {
    if (!trusted(event) || typeof command?.requestId !== 'string') return { success: false };
    const id = deps.sessionForRequest(command.requestId);
    const mcp = deps.mcp();
    if (!id || !visible(id) || !mcp.canAccessLocalQuestion(command.requestId)) return { success: false };
    const account = deps.accountKey();
    const applied = await mcp.actOnMediaConfirmation(command);
    return { success: applied && account === deps.accountKey() && visible(id) };
  });

  deps.ipcMain.handle(CoworkIpcChannel.PermissionList, event => {
    if (!trusted(event)) return { success: false, items: [] };
    const runtime = deps.runtime();
    const local = new Map((runtime.getPendingQuestions?.() ?? []).map(request => [request.requestId, request]));
    const items = (runtime.listPendingPermissions?.() ?? []).filter(item => visible(item.sessionId)).map(item => {
      const live = local.get(item.request.requestId);
      // The durable projection omits local tool inputs. Preserve desktop-only controls on reload.
      const request = live?.sessionId === item.sessionId ? { ...live, approval: item.request.approval } : item.request;
      return { sessionId: item.sessionId, request: deps.sanitize(request) };
    });
    return { success: true, items };
  });

  deps.ipcMain.handle(CoworkIpcChannel.PermissionRespond, async (event, options: CoworkPermissionSubmission) => {
    if (!trusted(event)) return { success: false, error: 'APPROVAL_ACCESS_DENIED' };
    try {
      const mcp = deps.mcp();
      const outcome = await submitCoworkPermission(options, {
        runtime: deps.runtime(),
        sessionForRequest: deps.sessionForRequest,
        isRuntimeRequest: deps.isRuntimeRequest,
        accountKey: deps.accountKey,
        canAccessSession: visible,
        canAccessLocalQuestion: id => mcp.canAccessLocalQuestion(id),
        resolveQuestion: (id, result) => {
          const input = result.behavior === 'allow' ? result.updatedInput : undefined;
          const resolved = mcp.resolveAskUser(id, {
            behavior: result.behavior,
            answers: input?.answers as Record<string, string> | undefined,
            skippedQuestionIds: Array.isArray(input?.skippedQuestionIds) ? input.skippedQuestionIds as string[] : undefined,
          });
          if (!resolved) throw new Error('QUESTION_UNAVAILABLE');
        },
      });
      if (outcome.kind === 'unknown' || outcome.kind === 'known_not_applied') {
        return { success: false, outcome, error: outcome.reason };
      }
      return { success: true, outcome };
    } catch (error) {
      console.warn('[CoworkPermission] Desktop response rejected', { requestId: options?.requestId });
      return { success: false, error: error instanceof Error ? error.message : 'Failed to respond to permission' };
    }
  });
}
