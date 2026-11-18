import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { EventEmitter } from 'events';
import { beforeEach, expect, test, vi } from 'vitest';

import { MessageSpeechIpc, type MessageSpeechRequest } from '../../shared/cowork/messageSpeech';
import {
  LanguageTool,
  LanguageToolCode,
  type LanguageToolEvent,
  LanguageToolEventType,
  type LanguageToolRequest,
  type LanguageToolResult,
} from '../../shared/desktopCompanion/languageTools';
import type { CompanionLanguageClient } from '../desktopCompanion/languageToolClient';
import { MessageSpeechController } from './messageSpeechController';

const handlers = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, value: unknown) => unknown>());
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: (event: IpcMainInvokeEvent, value: unknown) => unknown) => handlers.set(channel, handler),
  removeHandler: (channel: string) => handlers.delete(channel),
} }));

const request: MessageSpeechRequest = {
  requestId: '00000000-1111-2222-3333-444444444444', sessionId: 'session', messageId: 'reply', text: 'Read this',
};

beforeEach(() => handlers.clear());

function fixture() {
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: vi.fn() });
  const win = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false, isVisible: vi.fn(() => true) });
  const client = {
    start: vi.fn((_input: LanguageToolRequest, _send: (event: LanguageToolEvent) => void): LanguageToolResult => ({ success: true })),
    abort: vi.fn(),
  };
  const beforeStart = vi.fn();
  const controller = new MessageSpeechController({ getMainWindow: () => win as unknown as BrowserWindow,
    client: client as unknown as CompanionLanguageClient, beforeStart });
  const invoke = (channel: string, value: unknown, frame = contents.mainFrame) => handlers.get(channel)!({
    sender: contents, senderFrame: frame,
  } as unknown as IpcMainInvokeEvent, value);
  return { contents, win, client, beforeStart, controller, invoke };
}

test('only accepts the main window frame and refuses synthesis while the window is hidden', () => {
  const f = fixture();
  expect(() => f.invoke(MessageSpeechIpc.Start, request, {})).toThrow('Invalid message speech IPC sender');
  const foreign = { sender: { mainFrame: {} }, senderFrame: {} } as unknown as IpcMainInvokeEvent;
  expect(() => handlers.get(MessageSpeechIpc.Start)!(foreign, request)).toThrow('Invalid message speech IPC sender');
  f.win.isVisible.mockReturnValue(false);
  expect(f.invoke(MessageSpeechIpc.Start, request)).toEqual({ success: false, code: LanguageToolCode.Unavailable });
  expect(f.client.start).not.toHaveBeenCalled();
  f.controller.dispose();
});

test('routes the shared TTS client to main-window events and stops the companion only on success', () => {
  const f = fixture();
  expect(f.invoke(MessageSpeechIpc.Start, request)).toEqual({ success: true });
  expect(f.client.start).toHaveBeenCalledWith({ requestId: request.requestId, tool: LanguageTool.Tts, text: request.text }, expect.any(Function));
  const audio: LanguageToolEvent = { requestId: request.requestId, type: LanguageToolEventType.Audio,
    index: 0, total: 1, mimeType: 'audio/mpeg', audioBase64: 'audio' };
  f.client.start.mock.calls[0][1](audio);
  expect(f.contents.send).toHaveBeenCalledWith(MessageSpeechIpc.Event, audio);
  expect(f.beforeStart).toHaveBeenCalledOnce();
  f.controller.dispose();
});

test('does not hide an authentication rejection behind a reset event', () => {
  const f = fixture();
  f.client.start.mockReturnValue({ success: false, code: LanguageToolCode.Unauthorized });
  expect(f.invoke(MessageSpeechIpc.Start, request)).toEqual({ success: false, code: LanguageToolCode.Unauthorized });
  expect(f.contents.send).not.toHaveBeenCalled();
  expect(f.beforeStart).not.toHaveBeenCalled();
  expect(f.win.listenerCount('hide')).toBe(0);
  f.controller.dispose();
});

test('an old stop or delayed audio cannot interfere with a replacement request', () => {
  const f = fixture();
  f.invoke(MessageSpeechIpc.Start, request);
  const late = f.client.start.mock.calls[0][1];
  const replacement = { ...request, requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
  f.invoke(MessageSpeechIpc.Start, replacement);
  f.invoke(MessageSpeechIpc.Stop, request.requestId);
  expect(f.client.abort.mock.calls).toEqual([[request.requestId]]);
  f.contents.send.mockClear();
  late({ requestId: request.requestId, type: LanguageToolEventType.Error, code: LanguageToolCode.Upstream });
  expect(f.contents.send).not.toHaveBeenCalled();
  f.controller.dispose();
});

test('hiding or reloading the main window aborts synthesis and detaches lifetime listeners', () => {
  for (const event of ['hide', 'did-start-loading']) {
    const f = fixture();
    f.invoke(MessageSpeechIpc.Start, request);
    (event === 'hide' ? f.win : f.contents).emit(event);
    expect(f.client.abort).toHaveBeenCalledWith(request.requestId);
    expect(f.contents.send).toHaveBeenCalledWith(MessageSpeechIpc.Reset, request.requestId);
    expect(f.win.listenerCount('hide')).toBe(0);
    expect(f.contents.listenerCount('did-start-loading')).toBe(0);
    f.controller.dispose();
  }
});
