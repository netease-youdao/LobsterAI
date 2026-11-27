import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { CoworkIpcChannel } from '../../../shared/cowork/constants';
import type {
  CoworkMessageEditPending,
  CoworkMessageEditRequest,
  CoworkMessageEditResult,
  CoworkMessageVersionSwitchRequest,
} from '../../../shared/cowork/messageEdit';
import type { CoworkStore } from '../../coworkStore';
import { t } from '../../i18n';
import type { CoworkEngineRouter } from '../../libs/agentEngine/coworkEngineRouter';
import { prepareMessageEdit, type PrepareMessageEditDeps } from '../../libs/agentEngine/prepareMessageEdit';
import type { CoworkContinueOptions } from '../../libs/agentEngine/types';

interface CoworkMessageEditHandlerDeps extends PrepareMessageEditDeps {
  getStore: () => CoworkStore;
  getRuntime: () => CoworkEngineRouter;
  isRemoteManaged: (sessionId: string) => boolean;
  hasPendingMedia: (sessionId: string) => boolean;
  resend: (event: IpcMainInvokeEvent, request: CoworkMessageEditRequest, options: CoworkContinueOptions) => Promise<CoworkMessageEditResult>;
}

function validTarget(request: { sessionId: string; messageId: string } | undefined): boolean {
  return typeof request?.sessionId === 'string' && Boolean(request.sessionId.trim())
    && typeof request.messageId === 'string' && Boolean(request.messageId.trim());
}

export function registerCoworkMessageEditHandlers(ipc: Pick<IpcMain, 'handle'>, deps: CoworkMessageEditHandlerDeps): void {
  const pending = (sessionId: string): CoworkMessageEditPending | undefined => {
    const op = deps.getStore().messageEdits.pending(sessionId);
    if (!op) return undefined;
    const { operationId, messageId, prompt, phase, removedImageIndexes } = op;
    return { operationId, messageId, prompt, phase, removedImageIndexes };
  };
  const checkLocalSession = (sessionId: string) => {
    if (deps.isRemoteManaged(sessionId)) throw new Error(t('coworkEditUnsupported'));
    if (deps.hasPendingMedia(sessionId)) throw new Error(t('coworkEditBusy'));
  };

  ipc.handle(CoworkIpcChannel.CheckMessageEdit, async (_event, request: { sessionId: string; messageId: string }) => {
    if (!validTarget(request)) return { success: false, error: t('coworkEditUnsupported') };
    try {
      checkLocalSession(request.sessionId);
      const message = deps.getStore().getMessage(request.sessionId, request.messageId);
      await prepareMessageEdit(message, { ...request, prompt: message?.content ?? '' }, { ...deps, validateOnly: true });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : t('coworkEditUnsupported') };
    }
  });

  ipc.handle(CoworkIpcChannel.EditMessage, async (event, request: CoworkMessageEditRequest): Promise<CoworkMessageEditResult> => {
    if (!validTarget(request) || typeof request.prompt !== 'string'
      || (request.removedImageIndexes !== undefined && !Array.isArray(request.removedImageIndexes))) {
      return { success: false, error: t('coworkEditUnsupported') };
    }
    try {
      checkLocalSession(request.sessionId);
      const prepared = await prepareMessageEdit(deps.getStore().getMessage(request.sessionId, request.messageId), request, deps);
      const result = await deps.resend(event, request, prepared);
      return { ...result, pending: pending(request.sessionId) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : t('coworkEditFailed'), pending: pending(request.sessionId) };
    }
  });

  ipc.handle(CoworkIpcChannel.SwitchMessageVersion, async (_event, request: CoworkMessageVersionSwitchRequest) => {
    if (!validTarget(request) || !Number.isInteger(request.targetIndex) || request.targetIndex < 1) {
      return { success: false, error: t('coworkEditUnsupported') };
    }
    try {
      checkLocalSession(request.sessionId);
      const messageId = await deps.getRuntime().switchMessageVersion(request);
      return { success: true, messageId };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : t('coworkVersionSwitchFailed') };
    }
  });

  ipc.handle(CoworkIpcChannel.GetMessageEdit, (_event, sessionId: string) => ({
    success: true,
    pending: typeof sessionId === 'string' && !deps.isRemoteManaged(sessionId) ? pending(sessionId) : undefined,
  }));

  ipc.handle(CoworkIpcChannel.RecoverMessageEdit, async (_event, request: { sessionId: string; operationId: string }) => {
    if (typeof request?.sessionId !== 'string' || typeof request.operationId !== 'string') {
      return { success: false, error: t('coworkEditUnsupported') };
    }
    try {
      checkLocalSession(request.sessionId);
      await deps.getRuntime().recoverMessageEdit(request.sessionId, request.operationId);
      return { success: true };
    } catch (error) {
      console.warn('[CoworkEdit] Could not restore the prior projection:', error);
      return { success: false, error: t('coworkEditRecoveryFailed'), pending: pending(request.sessionId) };
    }
  });
}
