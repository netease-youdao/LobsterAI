import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { NeteaseMailFailure, NeteaseMailIpc } from '../../../shared/neteaseMail/constants';
import type { NeteaseMailActionResult, NeteaseMailAvailability } from '../../../shared/neteaseMail/types';
import { isNeteaseMailConfirmationReference, isNeteaseMailConfirmationRequest, NeteaseMailIntegration } from '../../mcp/neteaseMailIntegration';

export function registerNeteaseMailHandlers(
  getWindow: () => BrowserWindow | null,
  integration = new NeteaseMailIntegration(),
): void {
  const isOwner = (event: IpcMainInvokeEvent): boolean => {
    const owner = getWindow()?.webContents;
    return Boolean(owner && event.sender === owner && event.senderFrame === owner.mainFrame);
  };
  const failure = (): NeteaseMailActionResult => ({ success: false, code: NeteaseMailFailure.Unavailable });
  ipcMain.handle(NeteaseMailIpc.Availability, async (event, reference: unknown): Promise<NeteaseMailAvailability> => {
    if (!isOwner(event) || (reference !== undefined && !isNeteaseMailConfirmationReference(reference))) return { authorization: false, confirmation: false };
    try {
      return await integration.getAvailability(isNeteaseMailConfirmationReference(reference) ? {
        confirmationId: reference.confirmationId, toolCallId: reference.toolCallId,
      } : undefined);
    } catch (error) {
      console.error('[NeteaseMail] Failed to read availability', error);
      return { authorization: false, confirmation: false };
    }
  });
  ipcMain.handle(NeteaseMailIpc.Authorize, async (event, options: unknown): Promise<NeteaseMailActionResult> => {
    if (!isOwner(event)) return failure();
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => key !== 'allowDelete')
      || ('allowDelete' in options && typeof options.allowDelete !== 'boolean'))) {
      return { success: false, code: NeteaseMailFailure.InvalidRequest };
    }
    try {
      return await integration.authorize(options ?? undefined);
    } catch (error) {
      console.error('[NeteaseMail] Authorization failed', error);
      return failure();
    }
  });
  ipcMain.handle(NeteaseMailIpc.ResolveConfirmation, async (event, request: unknown): Promise<NeteaseMailActionResult> => {
    if (!isOwner(event)) return failure();
    if (!isNeteaseMailConfirmationRequest(request)) return { success: false, code: NeteaseMailFailure.InvalidRequest };
    try {
      return await integration.resolveConfirmation(request);
    } catch (error) {
      console.error('[NeteaseMail] Confirmation failed', error);
      return failure();
    }
  });
  for (const [channel, action] of [
    [NeteaseMailIpc.CancelAuthorization, () => integration.cancelAuthorization()],
    [NeteaseMailIpc.Disconnect, () => integration.disconnect()],
  ] as const) {
    ipcMain.handle(channel, async (event): Promise<NeteaseMailActionResult> => {
      if (!isOwner(event)) return failure();
      try { return await action(); } catch { return failure(); }
    });
  }
}
