import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { MessageSpeechIpc, type MessageSpeechRequest } from '../../shared/cowork/messageSpeech';
import {
  LanguageTool,
  LanguageToolCode,
  type LanguageToolResult,
} from '../../shared/desktopCompanion/languageTools';
import type { CompanionLanguageClient } from '../desktopCompanion/languageToolClient';

interface MessageSpeechHost {
  getMainWindow(): BrowserWindow | null;
  client: CompanionLanguageClient;
  beforeStart(): void;
}

/** Main-window speech has its own request lifetime, independent of the companion card. */
export class MessageSpeechController {
  private active: { requestId: string; window: BrowserWindow; detach: () => void } | null = null;

  constructor(private readonly host: MessageSpeechHost) {
    ipcMain.handle(MessageSpeechIpc.Start, (event, request: MessageSpeechRequest) => {
      this.assertSender(event);
      return this.start(request);
    });
    ipcMain.handle(MessageSpeechIpc.Stop, (event, requestId: unknown) => {
      this.assertSender(event);
      if (typeof requestId === 'string' && requestId === this.active?.requestId) this.stop();
    });
  }

  private assertSender(event: IpcMainInvokeEvent): void {
    const win = this.host.getMainWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Invalid message speech IPC sender');
    }
  }

  private start(request: MessageSpeechRequest): LanguageToolResult {
    const win = this.host.getMainWindow();
    if (!win || win.isDestroyed() || !win.isVisible()) return { success: false, code: LanguageToolCode.Unavailable };
    if (!request || typeof request.sessionId !== 'string' || !request.sessionId
      || typeof request.messageId !== 'string' || !request.messageId) {
      return { success: false, code: LanguageToolCode.InvalidInput };
    }
    this.stop();
    const stop = () => this.stop();
    const contents = win.webContents;
    win.on('hide', stop);
    win.on('closed', stop);
    contents.on('render-process-gone', stop);
    contents.on('did-start-loading', stop);
    const active = {
      requestId: request.requestId,
      window: win,
      detach: () => {
        win.removeListener('hide', stop);
        win.removeListener('closed', stop);
        contents.removeListener('render-process-gone', stop);
        contents.removeListener('did-start-loading', stop);
      },
    };
    this.active = active;
    const result = this.host.client.start({ requestId: request.requestId, tool: LanguageTool.Tts, text: request.text }, event => {
      if (this.active === active && !win.isDestroyed() && !contents.isDestroyed()) {
        contents.send(MessageSpeechIpc.Event, event);
      }
    });
    if (result.success) this.host.beforeStart();
    else {
      this.active = null;
      active.detach();
    }
    return result;
  }

  stop(): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    this.host.client.abort(active.requestId);
    active.detach();
    if (!active.window.isDestroyed() && !active.window.webContents.isDestroyed()) {
      active.window.webContents.send(MessageSpeechIpc.Reset, active.requestId);
    }
  }

  dispose(): void {
    this.stop();
    ipcMain.removeHandler(MessageSpeechIpc.Start);
    ipcMain.removeHandler(MessageSpeechIpc.Stop);
  }
}
