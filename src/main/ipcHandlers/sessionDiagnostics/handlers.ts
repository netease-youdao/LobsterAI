import type Database from 'better-sqlite3';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'path';

import { CoworkIpcChannel } from '../../../shared/cowork/constants';
import {
  buildSessionDiagnosticsDefaultFileName,
  exportSessionDiagnosticsZip,
} from '../../sessionDiagnostics/archive';
import { readSessionDiagnosticsData } from '../../sessionDiagnostics/repository';

export interface SessionDiagnosticsHandlerDeps {
  getDatabase: () => Database.Database;
  getAppVersion: () => string;
  getDownloadsPath: () => string;
}

const ensureZipFileName = (value: string): string => (
  value.toLowerCase().endsWith('.zip') ? value : `${value}.zip`
);

export function registerSessionDiagnosticsHandlers(
  deps: SessionDiagnosticsHandlerDeps,
): void {
  ipcMain.handle(
    CoworkIpcChannel.ExportSessionDiagnostics,
    async (
      event,
      options: {
        sessionId?: string;
      },
    ) => {
      try {
        const sessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
        if (!sessionId) {
          return { success: false, error: 'Session id is required' };
        }

        const diagnosticsData = readSessionDiagnosticsData(deps.getDatabase(), sessionId);
        if (!diagnosticsData) {
          return { success: false, error: 'Session not found' };
        }

        const defaultName = buildSessionDiagnosticsDefaultFileName({
          title: diagnosticsData.session.title,
          sessionId,
        });
        const ownerWindow = BrowserWindow.fromWebContents(event.sender);
        const saveOptions = {
          defaultPath: path.join(deps.getDownloadsPath(), defaultName),
          filters: [{ name: 'ZIP', extensions: ['zip'] }],
        };
        const saveResult = ownerWindow
          ? await dialog.showSaveDialog(ownerWindow, saveOptions)
          : await dialog.showSaveDialog(saveOptions);

        if (saveResult.canceled || !saveResult.filePath) {
          return { success: true, canceled: true };
        }

        const outputPath = ensureZipFileName(saveResult.filePath);
        await exportSessionDiagnosticsZip(outputPath, {
          data: diagnosticsData,
          appVersion: deps.getAppVersion(),
          exportedAt: new Date().toISOString(),
        });

        return { success: true, canceled: false, path: outputPath };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to export session diagnostics',
        };
      }
    },
  );
}
