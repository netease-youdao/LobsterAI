import { EventEmitter } from 'events';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  CoworkSideChatIpcChannel,
  CoworkSideChatStatus,
} from '../../../shared/cowork/sideChat';
import type { DshSideChatManager } from '../../libs/dsh/dshSideChatManager';

const registeredHandlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      registeredHandlers.set(channel, handler);
    }),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

import { registerCoworkSideChatHandlers, wireCoworkSideChatEvents } from './handlers';

describe('coworkSideChat IPC handlers', () => {
  beforeEach(() => {
    registeredHandlers.clear();
  });

  test('registers CRUD, streaming, promote, and permission handlers and forwards events to windows', async () => {
    const fakeManager = Object.assign(new EventEmitter(), {
      listSideChats: vi.fn(() => []),
      getSideChat: vi.fn(() => ({ sideChat: null, pendingPermissions: [] })),
      createSideChat: vi.fn(() => ({ id: 'sc-1', parentSessionId: 'p-1', title: 'Side chat', messages: [] })),
      sendMessage: vi.fn(async () => undefined),
      stopSideChat: vi.fn(async () => true),
      renameSideChat: vi.fn((id: string, title: string) => ({ id, title })),
      deleteSideChat: vi.fn(async () => true),
      promoteSideChat: vi.fn(async () => ({ id: 'promoted-1' })),
      respondToPermission: vi.fn(() => true),
    });

    const onSessionsChanged = vi.fn();
    registerCoworkSideChatHandlers({
      getSideChatManager: () => fakeManager as unknown as DshSideChatManager,
      ensureEngineReady: vi.fn(async () => ({ ready: true })),
      onSessionsChanged,
    });

    const createRes = await registeredHandlers.get(CoworkSideChatIpcChannel.Create)!(
      {},
      { parentSessionId: 'p-1' },
    );
    expect(createRes).toEqual({
      success: true,
      sideChat: { id: 'sc-1', parentSessionId: 'p-1', title: 'Side chat', messages: [] },
    });

    const sendRes = await registeredHandlers.get(CoworkSideChatIpcChannel.SendMessage)!(
      {},
      { parentSessionId: 'p-1', sideChatId: 'sc-1', prompt: 'Hello' },
    );
    expect(sendRes).toEqual({ success: true });
    expect(fakeManager.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 'p-1',
      sideChatId: 'sc-1',
      prompt: 'Hello',
    }));

    const promoteRes = await registeredHandlers.get(CoworkSideChatIpcChannel.Promote)!(
      {},
      { parentSessionId: 'p-1', sideChatId: 'sc-1' },
    );
    expect(promoteRes).toEqual({ success: true, sessionId: 'promoted-1' });
    expect(onSessionsChanged).toHaveBeenCalledWith(['promoted-1']);

    const sent: Array<{ channel: string; payload: unknown }> = [];
    const unwire = wireCoworkSideChatEvents(
      fakeManager as unknown as DshSideChatManager,
      () => [{
        isDestroyed: () => false,
        webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } as never,
      }],
    );

    fakeManager.emit('status', {
      parentSessionId: 'p-1',
      sideChatId: 'sc-1',
      status: CoworkSideChatStatus.Running,
    });
    expect(sent).toEqual([{
      channel: CoworkSideChatIpcChannel.StreamStatus,
      payload: { parentSessionId: 'p-1', sideChatId: 'sc-1', status: CoworkSideChatStatus.Running },
    }]);
    unwire();
  });
});
