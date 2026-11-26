import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  dialog: vi.fn(), read: vi.fn(), exportZip: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => mocks.handlers.set(channel, handler) },
  BrowserWindow: { fromWebContents: () => null }, dialog: { showSaveDialog: mocks.dialog },
}));
vi.mock('../../sessionDiagnostics/archive', () => ({ buildSessionDiagnosticsDefaultFileName: () => 'session.zip', exportSessionDiagnosticsZip: mocks.exportZip }));
vi.mock('../../sessionDiagnostics/repository', () => ({ readSessionDiagnosticsData: mocks.read }));

import type Database from 'better-sqlite3';

import { CoworkIpcChannel } from '../../../shared/cowork/constants';
import { registerSessionDiagnosticsHandlers } from './handlers';

beforeEach(() => { vi.clearAllMocks(); mocks.handlers.clear(); });

test('a private session is checked before loading export contents', async () => {
  registerSessionDiagnosticsHandlers({
    assertSessionAccess: () => { throw new Error('Session unavailable'); },
    getDatabase: () => ({} as Database.Database), getAppVersion: () => 'test', getDownloadsPath: () => '/tmp',
  });
  await expect(mocks.handlers.get(CoworkIpcChannel.ExportSessionDiagnostics)!({ sender: {} }, { sessionId: 'private-a' }))
    .resolves.toEqual({ success: false, error: 'Session unavailable' });
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.dialog).not.toHaveBeenCalled();
});

test('switching accounts while choosing the export path does not write the old private session', async () => {
  let accessible = true;
  mocks.read.mockReturnValue({ session: { title: 'Private A' } });
  mocks.dialog.mockImplementation(async () => { accessible = false; return { canceled: false, filePath: '/tmp/private-a.zip' }; });
  registerSessionDiagnosticsHandlers({
    assertSessionAccess: () => { if (!accessible) throw new Error('Account changed'); },
    getDatabase: () => ({} as Database.Database), getAppVersion: () => 'test', getDownloadsPath: () => '/tmp',
  });
  await expect(mocks.handlers.get(CoworkIpcChannel.ExportSessionDiagnostics)!({ sender: {} }, { sessionId: 'private-a' }))
    .resolves.toEqual({ success: false, error: 'Account changed' });
  expect(mocks.exportZip).not.toHaveBeenCalled();
});
