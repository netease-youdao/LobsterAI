import { randomUUID } from 'crypto';
import { type BrowserWindow, ipcMain, screen } from 'electron';

import { DesktopCompanionSize } from '../../shared/desktopCompanion/constants';
import { type CompanionSelectionAnchor, type CompanionSize, resolveCompanionSelectionBounds } from '../../shared/desktopCompanion/geometry';
import {
  LanguageTool, LanguageToolCode, type LanguageToolInput,
  type LanguageToolRequest, LanguageToolsIpc, SpeechCommand, SpeechStatus,
} from '../../shared/desktopCompanion/languageTools';
import type { CompanionLanguageClient } from './languageToolClient';

interface Host {
  createWindow(): BrowserWindow;
  getSelectionAnchor(): CompanionSelectionAnchor | null;
  assertSender(id: number): void;
  publish(): void;
  hideSelection(): void;
  abortFollowUp(id: number): void;
}

/** A persistent window owns audio, so hiding a selection never interrupts read-aloud. */
export class CompanionLanguageToolsController {
  private window: BrowserWindow | null = null;
  private input: LanguageToolInput | null = null;
  private status: SpeechStatus = SpeechStatus.Idle;
  private anchor: CompanionSelectionAnchor | null = null;
  private size: CompanionSize = { ...DesktopCompanionSize.Answer };
  private pinned = false;
  constructor(private readonly host: Host, private readonly client?: CompanionLanguageClient) {
    const handle = (channel: string, callback: (value: unknown) => unknown, toolsOnly = false) => {
      ipcMain.handle(channel, (event, value: unknown) => {
        host.assertSender(event.sender.id);
        if (event.senderFrame !== event.sender.mainFrame || (toolsOnly && event.sender.id !== this.webContentsId)) {
          throw new Error('Invalid language tools IPC sender');
        }
        return callback(value);
      });
    };
    handle(LanguageToolsIpc.Open, value => this.open(value as LanguageToolInput));
    handle(LanguageToolsIpc.GetInput, () => this.input, true);
    handle(LanguageToolsIpc.Hide, () => this.window?.hide(), true);
    handle(LanguageToolsIpc.Close, () => this.reset(), true);
    handle(LanguageToolsIpc.Pin, value => { this.pinned = value === true; }, true);
    handle(LanguageToolsIpc.Start, value => this.client?.start(value as LanguageToolRequest, event => {
      if (this.window && !this.window.isDestroyed()) this.window.webContents.send(LanguageToolsIpc.Event, event);
    }) ?? { success: false, code: LanguageToolCode.Unavailable }, true);
    handle(LanguageToolsIpc.Abort, value => { if (typeof value === 'string') this.client?.abort(value); }, true);
    handle(LanguageToolsIpc.Quota, () => this.client?.quota() ?? { success: false, code: LanguageToolCode.Unavailable });
    handle(LanguageToolsIpc.SpeechStatus, value => {
      if (!Object.values(SpeechStatus).includes(value as SpeechStatus)) return;
      this.status = value as SpeechStatus;
      host.publish();
    }, true);
    handle(LanguageToolsIpc.SpeechCommand, value => this.command(value as SpeechCommand));
  }
  get browserWindow(): BrowserWindow | null { return this.window; }
  get webContentsId(): number | null { return this.window?.webContents.id ?? null; }
  get speechStatus(): SpeechStatus { return this.status; }

  open(input: LanguageToolInput): void {
    if (!input || !Object.values(LanguageTool).includes(input.tool)) return;
    // The orb only restores existing playback; it never opens an empty tools page.
    if (input.text === undefined) {
      if (this.input && this.window && !this.window.isDestroyed()) {
        this.place();
        this.window.show();
        this.window.focus();
      }
      return;
    }
    if (typeof input.text !== 'string' || !input.text.trim()) return;
    const cursor = screen.getCursorScreenPoint();
    this.anchor = this.host.getSelectionAnchor() ?? { x: cursor.x - 28, top: cursor.y - 18, bottom: cursor.y + 14 };
    this.host.hideSelection();
    if (this.window) this.host.abortFollowUp(this.window.webContents.id);
    this.input = { tool: input.tool, text: input.text, id: randomUUID() };
    this.pinned = false;
    this.size = { ...DesktopCompanionSize.Answer, height: input.tool === LanguageTool.Tts ? 290 : 330 };
    if (!this.window || this.window.isDestroyed()) {
      const win = this.host.createWindow();
      const ownerId = win.webContents.id;
      this.window = win;
      win.once('ready-to-show', () => { if (this.input && !win.isDestroyed()) { win.show(); win.focus(); } });
      win.on('blur', () => { if (!this.pinned) win.hide(); });
      win.on('closed', () => {
        this.client?.reset(); this.host.abortFollowUp(ownerId);
        this.window = null; this.input = null; this.status = SpeechStatus.Idle; this.host.publish();
      });
    }
    this.place();
    this.window.webContents.send(LanguageToolsIpc.Input, this.input);
    this.window.show();
    this.window.focus();
  }
  setContentSize(size: CompanionSize): void {
    if (!this.input || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
    this.size = {
      width: Math.max(240, Math.min(Math.ceil(size.width), DesktopCompanionSize.Answer.width)),
      height: Math.max(120, Math.min(Math.ceil(size.height), DesktopCompanionSize.Answer.height)),
    };
    this.place();
  }
  private place(): void {
    if (!this.window || this.window.isDestroyed() || !this.anchor) return;
    const display = screen.getDisplayNearestPoint({ x: Math.round(this.anchor.x), y: Math.round(this.anchor.bottom) });
    this.window.setBounds(resolveCompanionSelectionBounds(this.anchor, this.size, display.workArea));
  }
  command(command: SpeechCommand): void {
    if (!Object.values(SpeechCommand).includes(command)) return;
    this.window?.webContents.send(LanguageToolsIpc.SpeechCommand, command);
  }
  reset(): void {
    this.client?.reset();
    if (this.window) this.host.abortFollowUp(this.window.webContents.id);
    this.input = null;
    this.pinned = false;
    this.status = SpeechStatus.Idle;
    this.window?.webContents.send(LanguageToolsIpc.Reset);
    this.window?.hide();
    this.host.publish();
  }
  dispose(): void {
    for (const channel of Object.values(LanguageToolsIpc)) ipcMain.removeHandler(channel);
    this.client?.reset();
    this.window?.destroy();
    this.window = null;
  }
}
