import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { beforeEach, expect, test, vi } from 'vitest';

import { NeteaseMailAction, NeteaseMailFailure, NeteaseMailIpc } from '../../../shared/neteaseMail/constants';
import { registerNeteaseMailHandlers } from './neteaseMail';

const handlers = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>());
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>) => handlers.set(channel, handler) } }));

const owner = { mainFrame: {} };
const window = { webContents: owner } as unknown as BrowserWindow;
const event = { sender: owner, senderFrame: owner.mainFrame } as IpcMainInvokeEvent;
beforeEach(() => { handlers.clear(); registerNeteaseMailHandlers(() => window); });

test('the real IPC reports unavailable capabilities until the provider is installed', async () => {
  expect(await handlers.get(NeteaseMailIpc.Availability)!(event)).toEqual({ authorization: false, confirmation: false });
  expect(await handlers.get(NeteaseMailIpc.Authorize)!(event)).toEqual({ success: false, code: NeteaseMailFailure.NotReady });
  expect(await handlers.get(NeteaseMailIpc.ResolveConfirmation)!(event, { messageId: 'message', toolCallId: 'call', action: NeteaseMailAction.Confirm }))
    .toEqual({ success: false, code: NeteaseMailFailure.NotReady });
});

test('does not expose authorization or actions to another window or a child frame', async () => {
  for (const caller of [{ sender: {}, senderFrame: owner.mainFrame }, { sender: owner, senderFrame: {} }]) {
    expect(await handlers.get(NeteaseMailIpc.Authorize)!(caller as IpcMainInvokeEvent)).toEqual({ success: false, code: NeteaseMailFailure.Unavailable });
    expect(await handlers.get(NeteaseMailIpc.CancelAuthorization)!(caller as IpcMainInvokeEvent)).toEqual({ success: false, code: NeteaseMailFailure.Unavailable });
    expect(await handlers.get(NeteaseMailIpc.Disconnect)!(caller as IpcMainInvokeEvent)).toEqual({ success: false, code: NeteaseMailFailure.Unavailable });
  }
  expect(await handlers.get(NeteaseMailIpc.ResolveConfirmation)!(event, { action: NeteaseMailAction.Confirm }))
    .toEqual({ success: false, code: NeteaseMailFailure.InvalidRequest });
});
