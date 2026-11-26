import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { expect, it, vi } from 'vitest';

import { isMainWindowRequest } from './mainWindowIpc';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

it('requires the live main frame of the current settings window', () => {
  const mainFrame = {};
  const contents = { mainFrame, isDestroyed: vi.fn(() => false) } as unknown as WebContents;
  const request = (sender: WebContents, frame: unknown) => ({ sender, senderFrame: frame }) as IpcMainInvokeEvent;
  expect(isMainWindowRequest(contents, request(contents, mainFrame))).toBe(true);
  expect(isMainWindowRequest(contents, request(contents, {}))).toBe(false);
  expect(isMainWindowRequest(contents, request({} as WebContents, mainFrame))).toBe(false);
  expect(isMainWindowRequest(undefined, request(contents, mainFrame))).toBe(false);
  vi.mocked(contents.isDestroyed).mockReturnValue(true);
  expect(isMainWindowRequest(contents, request(contents, mainFrame))).toBe(false);
});
