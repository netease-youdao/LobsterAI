import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { expect, test, vi } from 'vitest';

import { CoworkIpcChannel, SESSION_AGNOSTIC_PERMISSION_SESSION_ID } from '../../../shared/cowork/constants';
import { MediaConfirmationAction } from '../../../shared/media/confirmation';
import type { CoworkRuntime } from '../../libs/agentEngine/types';
import type { McpRuntime } from '../../mcp/mcpRuntime';
import { registerCoworkPermissionHandlers } from './permissions';

function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>();
  const sender = { mainFrame: {} } as WebContents;
  const event = { sender, senderFrame: sender.mainFrame } as IpcMainInvokeEvent;
  const items = ['mine', 'hidden', 'text'].map(sessionId => ({ requestId: sessionId, sessionId, toolName: 'ask', toolInput: {} }));
  const runtime = { getSessionConfirmationMode: (id: string) => id === 'text' ? 'text' : 'modal',
    getPendingQuestions: () => items, listPendingPermissions: () => items.map(request => ({ sessionId: request.sessionId, request })),
  } as unknown as CoworkRuntime;
  const apply = vi.fn(async () => true);
  const resolve = vi.fn(() => true);
  const mcp = { getPendingMediaConfirmations: () => [items[0], { ...items[0], requestId: 'expired' }],
    canAccessLocalQuestion: (id: string) => ['mine', 'credentials'].includes(id),
    actOnMediaConfirmation: apply, resolveAskUser: resolve,
  } as unknown as McpRuntime;
  let epoch = 'A';
  registerCoworkPermissionHandlers({ ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); } },
    sender: () => sender, runtime: () => runtime, mcp: () => mcp,
    accountKey: () => epoch, isRuntimeRequest: () => false, canViewSession: id => id !== 'hidden' && id !== SESSION_AGNOSTIC_PERMISSION_SESSION_ID,
    sessionForRequest: id => id === 'credentials' ? SESSION_AGNOSTIC_PERMISSION_SESSION_ID : id, sanitize: request => request,
  });
  return { call: (channel: string, input?: unknown, caller = event) => handlers.get(channel)!(caller, input), event, resolve, apply,
    switchAccount: () => { epoch = 'B'; } };
}

test('reads and decisions are restricted to the main frame and active account', async () => {
  const f = fixture();
  const guest = { ...f.event, senderFrame: {} } as IpcMainInvokeEvent;
  expect(f.call(CoworkIpcChannel.GetPendingQuestions, undefined, guest)).toEqual([]);
  expect(f.call(CoworkIpcChannel.PermissionList)).toMatchObject({ success: true, items: [{ sessionId: 'mine' }] });
  expect(f.call(CoworkIpcChannel.GetPendingQuestions)).toMatchObject([{ requestId: 'mine' }, { requestId: 'mine' }]);
  const answer = { requestId: 'credentials', result: { behavior: 'allow', updatedInput: { answers: { credential: 'Use locally' } } } };
  await expect(f.call(CoworkIpcChannel.PermissionRespond, answer, guest)).resolves.toMatchObject({ success: false });
  await expect(f.call(CoworkIpcChannel.PermissionRespond, answer)).resolves.toMatchObject({ success: true });
  expect(f.resolve).toHaveBeenCalledExactlyOnceWith('credentials', { behavior: 'allow', answers: { credential: 'Use locally' }, skippedQuestionIds: undefined });
});

test('recoverable media uses the original revision-checked command and discards results after account switches', async () => {
  const f = fixture();
  const command = { requestId: 'mine', revision: 3, action: MediaConfirmationAction.Shown };
  await expect(f.call(CoworkIpcChannel.MediaConfirmation, { ...command, requestId: 'expired' })).resolves.toEqual({ success: false });
  const inFlight = f.call(CoworkIpcChannel.MediaConfirmation, command);
  f.switchAccount();
  await expect(inFlight).resolves.toEqual({ success: false });
  expect(f.apply).toHaveBeenCalledExactlyOnceWith(command);
  expect(f.resolve).not.toHaveBeenCalled();
});
