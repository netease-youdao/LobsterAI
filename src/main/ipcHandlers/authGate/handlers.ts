import type { IpcMain } from 'electron';

import { type AuthAccessState, AuthIpcChannel } from '../../../shared/auth/constants';

export interface AuthGateHandlerDeps {
  ipcMain: Pick<IpcMain, 'handle'>;
  getAuthAccessState: () => AuthAccessState;
}

export function registerAuthGateHandlers(deps: AuthGateHandlerDeps): void {
  deps.ipcMain.handle(AuthIpcChannel.GetAccessState, () => deps.getAuthAccessState());
}
