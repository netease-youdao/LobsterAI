import { type BrowserWindow, ipcMain, type Rectangle, screen } from 'electron';

import { CoworkSessionStatusValue } from '../../renderer/types/cowork';
import { CompanionAnalyticsAction, CompanionAnalyticsInteraction as Interaction, CompanionAnalyticsSource, CompanionAnalyticsStage } from '../../shared/desktopCompanion/analytics';
import { type CompanionSurfaceSize, DesktopCompanionSize } from '../../shared/desktopCompanion/constants';
import { clampCompanionBounds, resolveCompanionResultBounds } from '../../shared/desktopCompanion/geometry';
import {
  COMPANION_RECENT_TASK_LIMIT, COMPANION_RECENT_TASKS_KEY, type CompanionRecentTask,
  CompanionResultIpc, type CompanionResultState, type CompanionTaskInfo, type CompanionTaskRecord,
  normalizeCompanionTaskRecords,
} from '../../shared/desktopCompanion/results';
import type { CompanionAnalytics } from './companionAnalytics';
import { dismissCompanionPanelOnBlur } from './companionWindow';

interface ResultHost {
  analytics?: CompanionAnalytics;
  store: { get<T = unknown>(key: string): T | undefined; set<T = unknown>(key: string, value: T): void };
  getTaskInfo(sessionId: string): CompanionTaskInfo | null;
  getOrbBounds(): Rectangle | null;
  createWindow(): BrowserWindow;
  assertSender(id: number): void;
  beforeOpen(): void;
  openMain(sessionId: string): void;
  isCapturing(): boolean;
  publish(): void;
}

/** Owns compact task notifications and their bounded history; full answers open in the main window. */
export class CompanionResultsController {
  private window: BrowserWindow | null = null;
  private visible = false;
  private pinned = false;
  private moved = false;
  private disposing = false;
  private workArea: Rectangle | null = null;
  private focusOnShow = true;
  private size: CompanionSurfaceSize = { width: DesktopCompanionSize.ResultCompactWidth, height: 160 };
  private records: CompanionTaskRecord[];

  constructor(private readonly host: ResultHost, legacySessionId: string | null) {
    const storedRecords = host.store.get(COMPANION_RECENT_TASKS_KEY);
    this.records = normalizeCompanionTaskRecords(storedRecords);
    // An explicitly empty list means its last card was closed, not that migration is needed.
    if (storedRecords === undefined && legacySessionId) this.record(legacySessionId);
    const handle = (channel: string, callback: (value: unknown) => unknown, resultOnly = false) => {
      ipcMain.handle(channel, (event, value: unknown) => {
        host.assertSender(event.sender.id);
        if (event.senderFrame !== event.sender.mainFrame || (resultOnly && event.sender.id !== this.webContentsId)) {
          throw new Error('Invalid companion result IPC sender');
        }
        return callback(value);
      });
    };
    handle(CompanionResultIpc.Open, value => this.open(value));
    handle(CompanionResultIpc.Hide, () => this.hide(), true);
    handle(CompanionResultIpc.Dismiss, value => this.dismiss(value), true);
    handle(CompanionResultIpc.Pin, value => { this.pinned = value === true; host.publish(); }, true);
    handle(CompanionResultIpc.Recent, () => this.recent());
    handle(CompanionResultIpc.PassThrough, value => this.browserWindow?.setIgnoreMouseEvents(value === true, { forward: true }), true);
  }

  get browserWindow(): BrowserWindow | null { return this.window && !this.window.isDestroyed() ? this.window : null; }
  get webContentsId(): number | null { return this.browserWindow?.webContents.id ?? null; }
  get state(): CompanionResultState {
    return {
      visible: this.visible, pinned: this.pinned,
      cardMaxHeight: Math.min(DesktopCompanionSize.Result.height, this.workArea?.height ?? DesktopCompanionSize.Result.height)
        - DesktopCompanionSize.SurfacePad * 2,
      recentTasks: this.records.map(record => ({ ...record })),
    };
  }

  record(sessionId: string): void {
    if (!sessionId.trim() || sessionId.length > 200) return;
    const previous = this.records.find(record => record.sessionId === sessionId);
    this.records = [previous ?? { sessionId, viewedAt: 0 }, ...this.records.filter(record => record.sessionId !== sessionId)]
      .slice(0, COMPANION_RECENT_TASK_LIMIT);
    this.save();
  }

  private save(): void { this.host.store.set(COMPANION_RECENT_TASKS_KEY, this.records.map(record => ({ ...record }))); }

  private dismiss(sessionId: unknown): void {
    if (typeof sessionId !== 'string' || !this.records.some(record => record.sessionId === sessionId)) return;
    this.host.analytics?.report({ action: CompanionAnalyticsAction.Action, source: CompanionAnalyticsSource.Result, interactionType: Interaction.Dismiss });
    this.records = this.records.filter(record => record.sessionId !== sessionId);
    this.save();
    if (this.visible && !this.recent().length) this.hide();
    this.host.publish();
  }

  private recent(): CompanionRecentTask[] {
    const tasks = this.records.flatMap(record => {
      const info = this.host.getTaskInfo(record.sessionId);
      return info ? [{ id: info.id, title: info.title, status: info.status, updatedAt: info.updatedAt,
        preview: info.preview, viewedAt: record.viewedAt }] : [];
    });
    // Deleting a Cowork session also removes its shortcut from recent tasks.
    if (tasks.length !== this.records.length) {
      const remaining = new Set(tasks.map(task => task.id));
      this.records = this.records.filter(record => remaining.has(record.sessionId));
      this.save();
      this.host.publish();
    }
    return tasks.filter(task => task.status === CoworkSessionStatusValue.Running
      || task.updatedAt > task.viewedAt).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Reading the task in the main window marks its current result as seen. */
  markSessionViewed(sessionId: string): void {
    const record = this.records.find(item => item.sessionId === sessionId);
    const info = record && this.host.getTaskInfo(record.sessionId);
    if (!record || !info) return;
    const viewedAt = info.updatedAt;
    if (viewedAt <= record.viewedAt) return;
    record.viewedAt = viewedAt;
    this.save();
    if (this.visible && !this.recent().length) this.hide();
    this.host.publish();
  }

  /** Task activity shows compact bubbles without taking focus. */
  notify(): void {
    if (!this.visible && this.recent().length) this.open(undefined, false);
  }

  open(value?: unknown, focus = true): void {
    if (this.host.isCapturing()) return;
    if (value !== undefined && (typeof value !== 'string' || !this.records.some(record => record.sessionId === value))) return;
    if (typeof value === 'string') {
      if (!this.host.getTaskInfo(value)) { this.recent(); this.hide(); return; }
      this.host.analytics?.report({ action: CompanionAnalyticsAction.Action, source: CompanionAnalyticsSource.Result,
        interactionType: Interaction.OpenMain, hasSession: true });
      this.hide();
      this.host.beforeOpen();
      this.host.openMain(value);
      return;
    }
    if (!this.recent().length) { this.hide(); return; }
    const surfaceChanged = !this.visible;
    this.host.beforeOpen();
    if (!this.visible) {
      this.pinned = false;
      this.moved = false;
      const anchor = this.host.getOrbBounds();
      this.workArea = anchor ? screen.getDisplayMatching(anchor).workArea : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    }
    this.focusOnShow = focus;
    this.visible = true;
    if (!this.browserWindow) {
      const win = this.host.createWindow();
      this.window = win;
      win.once('ready-to-show', () => { if (this.visible && !win.isDestroyed()) this.reveal(win); });
      dismissCompanionPanelOnBlur(win, () => { if (!this.pinned && !this.host.isCapturing()) this.hide(); }, () => this.focusOnShow);
      win.on('will-move', () => { this.moved = true; this.pinned = true; this.host.publish(); });
      // A native hide notification can arrive after a rapid reopen.
      win.on('hide', () => { if (!win.isVisible()) this.hide(); });
      win.on('close', event => { if (!this.disposing) { event.preventDefault(); this.hide(); } });
      win.on('closed', () => { this.window = null; this.visible = false; });
    }
    this.reposition();
    const win = this.browserWindow!;
    win.setFocusable(focus);
    // Reopening via accessibility may not move the pointer again.
    if (surfaceChanged) win.setIgnoreMouseEvents(false, { forward: true });
    if (!win.webContents.isLoadingMainFrame()) this.reveal(win);
    this.host.publish();
  }

  private reveal(win: BrowserWindow): void {
    if (!win.isVisible()) this.host.analytics?.report({ action: CompanionAnalyticsAction.Action,
      source: CompanionAnalyticsSource.Result, interactionType: Interaction.Open,
      stage: CompanionAnalyticsStage.Shown, recentTaskCount: this.recent().length });
    if (this.focusOnShow) { win.show(); win.focus(); }
    else win.showInactive();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.browserWindow?.hide();
    this.host.publish();
  }

  setContentSize(size: CompanionSurfaceSize): void {
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
    this.size = {
      width: DesktopCompanionSize.ResultCompactWidth,
      height: Math.max(100, Math.min(Math.ceil(size.height), DesktopCompanionSize.Result.height)),
    };
    this.reposition();
  }

  reposition(): void {
    const win = this.browserWindow;
    if (!win || !this.workArea) return;
    const orb = this.host.getOrbBounds();
    // Attached bubbles follow the orb across displays; detached/standalone cards keep their own display.
    this.workArea = screen.getDisplayMatching(this.moved ? win.getBounds() : orb ?? this.workArea).workArea;
    const bounds = this.moved
      ? clampCompanionBounds({ ...win.getBounds(), ...this.size }, this.workArea)
      : resolveCompanionResultBounds(orb, this.size, this.workArea);
    win.setBounds(bounds);
  }

  dispose(): void {
    this.disposing = true;
    for (const channel of Object.values(CompanionResultIpc)) ipcMain.removeHandler(channel);
    this.window?.destroy();
    this.window = null;
  }
}
