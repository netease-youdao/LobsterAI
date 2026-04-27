import { ipcMain } from 'electron';

import { NimQrLoginIpc } from './constants';

export interface NimQrLoginHandlerDeps {
  startNimQrLogin: () => Promise<{
    uuid: string;
    qrValue: string;
    expiresIn: number;
    pollInterval: number;
    credentialKind: 'split';
    rawData: Record<string, unknown> | null;
  }>;
  pollNimQrLogin: (uuid: string) => Promise<{
    status: 'pending' | 'success' | 'failed';
    credentials?: {
      appKey: string;
      account: string;
      token: string;
    };
    errorCode?: string;
    error?: string;
  }>;
}

export function registerNimQrLoginHandlers(deps: NimQrLoginHandlerDeps): void {
  ipcMain.handle(NimQrLoginIpc.Start, async () => {
    try {
      return await deps.startNimQrLogin();
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to start NIM QR login');
    }
  });

  ipcMain.handle(NimQrLoginIpc.Poll, async (_event, uuid: string) => {
    try {
      return await deps.pollNimQrLogin(uuid);
    } catch (error) {
      return {
        status: 'failed' as const,
        error: error instanceof Error ? error.message : 'Failed to poll NIM QR login',
      };
    }
  });
}
