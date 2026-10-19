import { randomUUID } from 'crypto';
import { type BrowserWindow, ipcMain, screen } from 'electron';

import { CompanionAnalyticsAction, CompanionAnalyticsInteraction as Interaction, CompanionAnalyticsSource } from '../../shared/desktopCompanion/analytics';
import { DesktopCompanionSize } from '../../shared/desktopCompanion/constants';
import {
  clampCompanionBounds, companionCardSlot, companionPointerAnchor, type CompanionRect, type CompanionSelectionAnchor,
  type CompanionSize, resolveCompanionCardBounds,
} from '../../shared/desktopCompanion/geometry';
import {
  LanguageTool, LanguageToolCode, type LanguageToolInput,
  type LanguageToolRequest, LanguageToolsIpc, SpeechCommand, SpeechStatus,
} from '../../shared/desktopCompanion/languageTools';
import type { CompanionAnalytics } from './companionAnalytics';
import type { CompanionLanguageClient } from './languageToolClient';

interface Host {
  analytics?: CompanionAnalytics;
  createWindow(): BrowserWindow;
  getSelectionAnchor(): CompanionSelectionAnchor | null;
  getSelectionToolbarBounds(): CompanionRect | null;
  assertSender(id: number): void;
  publish(): void;
  hideSelection(): void;
  abortFollowUp(id: number): void;
  /** A screenshot shortcut is waiting for its shot; the card keeps showing when it loses focus to it. */
  isCapturing(): boolean;
}

/** How often a card that lost focus to a screenshot checks whether the shot is done. */
const CAPTURE_CHECK_MS = 500;

/** Reuses the tool window, but ends read-aloud whenever its card disappears. */
export class CompanionLanguageToolsController {
  private window: BrowserWindow | null = null;
  private input: LanguageToolInput | null = null;
  private status: SpeechStatus = SpeechStatus.Idle;
  private anchor: CompanionSelectionAnchor | null = null;
  private toolbarBounds: CompanionRect | null = null;
  private size: CompanionSize = { ...DesktopCompanionSize.Answer };
  private pinned = false;
  /** The user dragged the card away from the selection. */
  private moved = false;
  /** The window height the card may grow to beside the selection. */
  private cardHeight: number = DesktopCompanionSize.Answer.height;
  private captureTimer: ReturnType<typeof setTimeout> | undefined;
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
    handle(LanguageToolsIpc.PassThrough, value => this.window?.setIgnoreMouseEvents(value === true, { forward: true }), true);
    handle(LanguageToolsIpc.Start, value => {
      const request = value as LanguageToolRequest;
      // A renderer request already queued before dismissal must not restart hidden speech.
      if (request?.tool === LanguageTool.Tts && (!this.input || !this.window?.isVisible())) {
        return { success: false, code: LanguageToolCode.Unavailable };
      }
      return this.client?.start(request, event => {
        if (this.window && !this.window.isDestroyed()) this.window.webContents.send(LanguageToolsIpc.Event, event);
      }) ?? { success: false, code: LanguageToolCode.Unavailable };
    }, true);
    handle(LanguageToolsIpc.Abort, value => { if (typeof value === 'string') this.client?.abort(value); }, true);
    handle(LanguageToolsIpc.Quota, value => this.client?.quota(value as LanguageTool) ?? { success: false, code: LanguageToolCode.Unavailable });
    handle(LanguageToolsIpc.SpeechStatus, value => {
      if (!this.input || !this.window?.isVisible() || !Object.values(SpeechStatus).includes(value as SpeechStatus)) return;
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
    this.host.analytics?.report({ action: CompanionAnalyticsAction.Action, source: CompanionAnalyticsSource.Selection,
      interactionType: Interaction.Run, tool: input.tool });
    const cursor = screen.getCursorScreenPoint();
    this.anchor = this.host.getSelectionAnchor() ?? companionPointerAnchor(cursor);
    this.toolbarBounds = this.host.getSelectionToolbarBounds();
    this.host.hideSelection();
    if (this.window) this.host.abortFollowUp(this.window.webContents.id);
    this.cardHeight = companionCardSlot(this.anchor, this.workArea()).room;
    this.input = {
      tool: input.tool, text: input.text, id: randomUUID(), cardMaxHeight: this.cardHeight - DesktopCompanionSize.SurfacePad * 2,
    };
    this.pinned = false;
    this.moved = false;
    this.size = { width: DesktopCompanionSize.Answer.width, height: Math.min(this.cardHeight, input.tool === LanguageTool.Tts ? 290 : 330) };
    if (!this.window || this.window.isDestroyed()) {
      const win = this.host.createWindow();
      const ownerId = win.webContents.id;
      this.window = win;
      win.once('ready-to-show', () => { if (this.input && !win.isDestroyed()) { win.show(); win.focus(); } });
      win.on('blur', () => this.hideOnBlur(win));
      win.on('hide', () => {
        if (this.input?.tool === LanguageTool.Tts) this.reset();
      });
      // Only a drag by the user emits will-move; a card moved out of the way stays open.
      win.on('will-move', () => {
        this.moved = true;
        if (this.pinned) return;
        this.pinned = true;
        win.webContents.send(LanguageToolsIpc.Pinned, true);
      });
      win.on('closed', () => {
        this.client?.reset(); this.host.abortFollowUp(ownerId);
        this.window = null; this.input = null; this.status = SpeechStatus.Idle; this.host.publish();
      });
    }
    this.place();
    // The transparent margin lets clicks through until the pointer reaches the card.
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.window.webContents.send(LanguageToolsIpc.Input, this.input);
    this.window.show();
    this.window.focus();
  }
  setContentSize(size: CompanionSize): void {
    if (!this.input || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
    this.size = {
      width: Math.max(240, Math.min(Math.ceil(size.width), DesktopCompanionSize.Answer.width)),
      height: Math.max(120, Math.min(Math.ceil(size.height), this.cardHeight)),
    };
    this.place();
  }
  /** Clicking elsewhere closes an unpinned card, but a screenshot that took focus gets to capture it first. */
  private hideOnBlur(win: BrowserWindow, afterCapture = false): void {
    clearTimeout(this.captureTimer);
    // After a screenshot, focus usually comes back to the card; then it stays like before.
    if (win.isDestroyed() || this.pinned || (afterCapture && win.isFocused())) return;
    if (!this.host.isCapturing()) {
      win.hide();
      return;
    }
    this.captureTimer = setTimeout(() => this.hideOnBlur(win, true), CAPTURE_CHECK_MS);
  }
  private workArea(): CompanionRect {
    const anchor = this.anchor ?? companionPointerAnchor(screen.getCursorScreenPoint());
    return screen.getDisplayNearestPoint({ x: Math.round(anchor.left), y: Math.round(anchor.top) }).workArea;
  }
  private place(): void {
    if (!this.window || this.window.isDestroyed() || !this.anchor) return;
    const workArea = this.workArea();
    if (this.moved) {
      const { x, y } = this.window.getBounds();
      this.window.setBounds(clampCompanionBounds({ ...this.size, x, y }, workArea));
      return;
    }
    this.window.setBounds(resolveCompanionCardBounds(this.anchor, this.size, workArea, this.toolbarBounds));
  }
  command(command: SpeechCommand): void {
    if (!this.input || !this.window?.isVisible() || !Object.values(SpeechCommand).includes(command)) return;
    this.host.analytics?.report({ action: CompanionAnalyticsAction.Action, source: CompanionAnalyticsSource.LanguageTools,
      interactionType: command, tool: LanguageTool.Tts });
    this.window?.webContents.send(LanguageToolsIpc.SpeechCommand, command);
  }
  reset(): void {
    clearTimeout(this.captureTimer);
    this.captureTimer = undefined;
    this.client?.reset();
    if (this.window) this.host.abortFollowUp(this.window.webContents.id);
    this.input = null;
    this.pinned = false;
    this.moved = false;
    this.status = SpeechStatus.Idle;
    this.window?.webContents.send(LanguageToolsIpc.Reset);
    if (this.window?.isVisible()) this.window.hide();
    this.host.publish();
  }
  dispose(): void {
    clearTimeout(this.captureTimer);
    for (const channel of Object.values(LanguageToolsIpc)) ipcMain.removeHandler(channel);
    this.client?.reset();
    this.window?.destroy();
    this.window = null;
  }
}
