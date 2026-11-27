import { BrowserWindow, ipcMain } from 'electron';

import {
  type CoworkSideChatCreateRequest,
  type CoworkSideChatDeleteRequest,
  CoworkSideChatIpcChannel,
  type CoworkSideChatPromoteRequest,
  type CoworkSideChatRenameRequest,
  type CoworkSideChatRespondPermissionRequest,
  type CoworkSideChatSendRequest,
  type CoworkSideChatStopRequest,
} from '../../../shared/cowork/sideChat';
import type { DshSideChatManager } from '../../libs/dsh/dshSideChatManager';

export interface CoworkSideChatHandlerDeps {
  getSideChatManager: () => DshSideChatManager;
  ensureEngineReady: (parentSessionId: string) => Promise<{ ready: boolean; error?: string }>;
  onSessionsChanged?: (sessionIds: string[]) => void;
  getAllWindows?: () => Array<Pick<BrowserWindow, 'isDestroyed' | 'webContents'>>;
}

function broadcast(
  getAllWindows: () => Array<Pick<BrowserWindow, 'isDestroyed' | 'webContents'>>,
  channel: CoworkSideChatIpcChannel,
  payload: unknown,
): void {
  for (const win of getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (error) {
      console.error(`[CoworkSideChat] failed to broadcast ${channel}:`, error);
    }
  }
}

export function wireCoworkSideChatEvents(
  manager: DshSideChatManager,
  getAllWindows: () => Array<Pick<BrowserWindow, 'isDestroyed' | 'webContents'>> = () => BrowserWindow.getAllWindows(),
): () => void {
  const onMessage = (event: unknown) => broadcast(getAllWindows, CoworkSideChatIpcChannel.StreamMessage, event);
  const onMessageUpdate = (event: unknown) => broadcast(getAllWindows, CoworkSideChatIpcChannel.StreamMessageUpdate, event);
  const onStatus = (event: unknown) => broadcast(getAllWindows, CoworkSideChatIpcChannel.StreamStatus, event);
  const onMetaChanged = (event: unknown) => broadcast(getAllWindows, CoworkSideChatIpcChannel.StreamMetaChanged, event);
  const onPermission = (event: unknown) => broadcast(getAllWindows, CoworkSideChatIpcChannel.StreamPermission, event);
  const onPermissionResolved = (event: unknown) => broadcast(getAllWindows, CoworkSideChatIpcChannel.StreamPermissionResolved, event);

  manager.on('message', onMessage);
  manager.on('messageUpdate', onMessageUpdate);
  manager.on('status', onStatus);
  manager.on('metaChanged', onMetaChanged);
  manager.on('permissionRequest', onPermission);
  manager.on('permissionResolved', onPermissionResolved);

  return () => {
    manager.off('message', onMessage);
    manager.off('messageUpdate', onMessageUpdate);
    manager.off('status', onStatus);
    manager.off('metaChanged', onMetaChanged);
    manager.off('permissionRequest', onPermission);
    manager.off('permissionResolved', onPermissionResolved);
  };
}

export function registerCoworkSideChatHandlers(deps: CoworkSideChatHandlerDeps): void {
  const { getSideChatManager, ensureEngineReady, onSessionsChanged } = deps;

  ipcMain.handle(
    CoworkSideChatIpcChannel.List,
    async (_event, options: { parentSessionId: string }) => {
      try {
        const parentSessionId = typeof options?.parentSessionId === 'string' ? options.parentSessionId.trim() : '';
        if (!parentSessionId) {
          return { success: false, error: 'parentSessionId is required' };
        }
        const sideChats = getSideChatManager().listSideChats(parentSessionId);
        return { success: true, sideChats };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list side chats',
        };
      }
    },
  );

  ipcMain.handle(
    CoworkSideChatIpcChannel.Get,
    async (_event, options: { sideChatId: string }) => {
      try {
        const sideChatId = typeof options?.sideChatId === 'string' ? options.sideChatId.trim() : '';
        if (!sideChatId) {
          return { success: false, error: 'sideChatId is required' };
        }
        const { sideChat, pendingPermissions } = getSideChatManager().getSideChat(sideChatId);
        return { success: true, sideChat, pendingPermissions };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to load side chat',
        };
      }
    },
  );

  ipcMain.handle(
    CoworkSideChatIpcChannel.Create,
    async (_event, options: CoworkSideChatCreateRequest) => {
      try {
        const parentSessionId = typeof options?.parentSessionId === 'string' ? options.parentSessionId.trim() : '';
        if (!parentSessionId) {
          return { success: false, error: 'parentSessionId is required' };
        }
        const sideChat = getSideChatManager().createSideChat({
          parentSessionId,
          title: options.title,
          forkedFromMessageId: options.forkedFromMessageId ?? null,
        });
        return { success: true, sideChat };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create side chat',
        };
      }
    },
  );

  ipcMain.handle(
    CoworkSideChatIpcChannel.SendMessage,
    async (_event, options: CoworkSideChatSendRequest) => {
      try {
        const parentSessionId = typeof options?.parentSessionId === 'string' ? options.parentSessionId.trim() : '';
        const sideChatId = typeof options?.sideChatId === 'string' ? options.sideChatId.trim() : '';
        if (!parentSessionId || !sideChatId) {
          return { success: false, error: 'parentSessionId and sideChatId are required' };
        }
        const readiness = await ensureEngineReady(parentSessionId);
        if (!readiness.ready) {
          return { success: false, error: readiness.error || 'Runtime is not ready' };
        }
        await getSideChatManager().sendMessage({
          parentSessionId,
          sideChatId,
          prompt: typeof options.prompt === 'string' ? options.prompt : '',
          displayPrompt: typeof options.displayPrompt === 'string' ? options.displayPrompt : undefined,
          selectedTextSnippets: Array.isArray(options.selectedTextSnippets) ? options.selectedTextSnippets : undefined,
          imageAttachments: Array.isArray(options.imageAttachments) ? options.imageAttachments : undefined,
          modelOverride: typeof options.modelOverride === 'string' ? options.modelOverride : undefined,
          thinkingLevel: typeof options.thinkingLevel === 'string' || options.thinkingLevel === null
            ? options.thinkingLevel
            : undefined,
        });
        return { success: true };
      } catch (error) {
        console.error('[CoworkSideChat] sendMessage failed:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to send side chat message',
        };
      }
    },
  );

  ipcMain.handle(
    CoworkSideChatIpcChannel.Stop,
    async (_event, options: CoworkSideChatStopRequest) => {
      try {
        const sideChatId = typeof options?.sideChatId === 'string' ? options.sideChatId.trim() : '';
        if (!sideChatId) {
          return { success: false, error: 'sideChatId is required' };
        }
        await getSideChatManager().stopSideChat(sideChatId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to stop side chat',
        };
      }
    },
  );

  ipcMain.handle(
    CoworkSideChatIpcChannel.Rename,
    async (_event, options: CoworkSideChatRenameRequest) => {
      try {
        const sideChatId = typeof options?.sideChatId === 'string' ? options.sideChatId.trim() : '';
        const title = typeof options?.title === 'string' ? options.title : '';
        if (!sideChatId || !title.trim()) {
          return { success: false, error: 'sideChatId and title are required' };
        }
        const sideChat = getSideChatManager().renameSideChat(sideChatId, title);
        return { success: true, sideChat };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to rename side chat',
        };
      }
    },
  );

  ipcMain.handle(
    CoworkSideChatIpcChannel.Delete,
    async (_event, options: CoworkSideChatDeleteRequest) => {
      try {
        const sideChatId = typeof options?.sideChatId === 'string' ? options.sideChatId.trim() : '';
        if (!sideChatId) {
          return { success: false, error: 'sideChatId is required' };
        }
        await getSideChatManager().deleteSideChat(sideChatId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete side chat',
        };
      }
    },
  );

  ipcMain.handle(
    CoworkSideChatIpcChannel.Promote,
    async (_event, options: CoworkSideChatPromoteRequest) => {
      try {
        const parentSessionId = typeof options?.parentSessionId === 'string' ? options.parentSessionId.trim() : '';
        const sideChatId = typeof options?.sideChatId === 'string' ? options.sideChatId.trim() : '';
        if (!parentSessionId || !sideChatId) {
          return { success: false, error: 'parentSessionId and sideChatId are required' };
        }
        const promoted = await getSideChatManager().promoteSideChat(parentSessionId, sideChatId);
        onSessionsChanged?.([promoted.id]);
        return { success: true, sessionId: promoted.id };
      } catch (error) {
        console.error('[CoworkSideChat] promote failed:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to promote side chat',
        };
      }
    },
  );

  ipcMain.handle(
    CoworkSideChatIpcChannel.RespondPermission,
    async (_event, options: CoworkSideChatRespondPermissionRequest) => {
      try {
        const requestId = typeof options?.requestId === 'string' ? options.requestId.trim() : '';
        if (!requestId || !options?.result) {
          return { success: false, error: 'requestId and result are required' };
        }
        const handled = getSideChatManager().respondToPermission(requestId, options.result);
        return { success: handled, ...(handled ? {} : { error: 'Permission request not found' }) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to respond to side chat permission',
        };
      }
    },
  );
}
