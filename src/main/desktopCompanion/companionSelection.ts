import { randomUUID } from 'crypto';
import { BrowserWindow, screen, shell, systemPreferences } from 'electron';
import type { EventEmitter } from 'events';

import { CompanionAnalyticsAction, CompanionAnalyticsInteraction as Interaction, CompanionAnalyticsSource, CompanionAnalyticsStage } from '../../shared/desktopCompanion/analytics';
import { DEFAULT_SELECTION_EXCLUDED_APPS, isCompanionSelectionBlocked } from '../../shared/desktopCompanion/appCategories';
import {
  CompanionCapability,
  DesktopCompanionIpc,
  type DesktopCompanionPreferences,
  type DesktopCompanionSelection,
  type DesktopCompanionSelectionCommand,
  DesktopCompanionSelectionCommandType,
  DesktopCompanionSelectionMode,
  DesktopCompanionSize,
  DesktopCompanionSurface,
} from '../../shared/desktopCompanion/constants';
import {
  clampCompanionBounds,
  companionCardSlot,
  companionMenuOpensUp,
  type CompanionRect,
  type CompanionSelectionAnchor,
  type CompanionSize,
  rectContains,
  resolveCompanionCardBounds,
  resolveCompanionToolbarBounds,
  resolveCompanionToolbarMenuBounds,
} from '../../shared/desktopCompanion/geometry';
import {
  isCompanionSelectionAction,
  rankCompanionSelectionActions,
} from '../../shared/desktopCompanion/selectionActions';
import type { CompanionAnalytics } from './companionAnalytics';
import { isCompanionTextTooLarge } from './companionClipboard';
import type { CompanionQuickAnswerService } from './quickAnswerService';
import { SelectionGestureTracker } from './selectionGesture';
import { isScreenshotApp, SelectionKeyEffect, selectionKeyEffect,type SelectionKeyEvent } from './selectionKeys';

const INVALID_COORDINATE = -99999;
const PAUSE_MS = 60 * 60_000;
const PERMISSION_POLL_MS = 2_000;
const SHOW_FALLBACK_MS = 150;
const MAC_ACCESSIBILITY_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'AltGraph', 'OS']);
const LEFT_BUTTON = 0;
// Reads after a selection gesture that selection-hook reported nothing for, each timed from
// the previous read. Chromium and Electron apps turn their accessibility tree on 2 s after a
// failed read, and every failed read, ours included, restarts that wait.
const RECOVERY_READ_DELAYS_MS = [80, 2_500, 1_000];
// A macOS screenshot keeps the toolbar and card on screen until it is taken: Cmd+Shift+4 at the
// end of its click or drag (or this long at most), the Cmd+Shift+5 toolbar for this long.
const CAPTURE_MS = 30_000;
const CAPTURE_TOOLBAR_MS = 20_000;
// After the shot, the screen flash and thumbnail still belong to the screenshot.
const CAPTURE_SETTLE_MS = 400;
// A pointer-only selection whose ends are this far apart vertically spans lines.
const POINTER_LINE_SLOP = 12;

interface Point { x: number; y: number }

interface MouseEventData extends Point { button?: number }

/** The subset of selection-hook's TextSelectionData the companion uses. */
export interface SelectionHookEvent {
  text: string;
  programName: string;
  /** Top-left and bottom-left of the first line, top-right and bottom-right of the last. */
  startTop: Point;
  startBottom?: Point;
  endTop: Point;
  endBottom: Point;
  mousePosStart?: Point;
  mousePosEnd: Point;
  posLevel: number;
}

export interface SelectionHookLike extends EventEmitter {
  start(config?: Record<string, unknown>): boolean;
  stop(): boolean;
  cleanup(): void;
  setGlobalFilterMode(mode: number, list?: string[]): boolean;
  getCurrentSelection(): SelectionHookEvent | null;
}

export interface SelectionHookModule {
  new (): SelectionHookLike;
  FilterMode: { EXCLUDE_LIST: number };
  PositionLevel: { SEL_FULL: number };
}

export interface SelectionHost {
  analytics?: CompanionAnalytics;
  preferences(): DesktopCompanionPreferences;
  /** False while the companion is off or hidden by a snooze. */
  isAvailable(): boolean;
  createWindow(surface: typeof DesktopCompanionSurface.Selection, focusable: boolean): BrowserWindow;
  setPreferences(patch: Partial<DesktopCompanionPreferences>): void;
  publish(): void;
  openSettings(): void;
}

function loadSelectionHook(): SelectionHookModule | null {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null;
  try {
    return require('selection-hook') as SelectionHookModule;
  } catch (error) {
    console.warn('[DesktopCompanion] selection-hook is unavailable:', error);
    return null;
  }
}

const valid = (point: Point | undefined): point is Point => !!point
  && Number.isFinite(point.x) && Number.isFinite(point.y)
  && point.x !== INVALID_COORDINATE && point.y !== INVALID_COORDINATE;

/** The toolbar or card inside its window, without the transparent margin that holds its shadow. */
function visibleArea(bounds: CompanionRect): CompanionRect {
  const pad = DesktopCompanionSize.SurfacePad;
  return { x: bounds.x + pad, y: bounds.y + pad, width: bounds.width - pad * 2, height: bounds.height - pad * 2 };
}

/** Selection-hook reports physical pixels on Windows and points on macOS. */
function toDip(point: Point): Point {
  return process.platform === 'win32' ? screen.screenToDipPoint(point) : point;
}

export function selectionAnchor(data: SelectionHookEvent, fullLevel: number, cursor: Point): CompanionSelectionAnchor {
  if (data.posLevel >= fullLevel && valid(data.startTop) && valid(data.startBottom) && valid(data.endTop) && valid(data.endBottom)) {
    const startTop = toDip(data.startTop);
    const startBottom = toDip(data.startBottom);
    const endTop = toDip(data.endTop);
    const endBottom = toDip(data.endBottom);
    // Apps that report the whole selection as one rectangle give equal tops: one block to center on.
    const multiline = endTop.y - startTop.y >= Math.max(1, startBottom.y - startTop.y) / 2;
    return {
      left: multiline ? startTop.x : Math.min(startTop.x, endTop.x),
      right: multiline ? endTop.x : Math.max(startTop.x, endTop.x),
      top: Math.min(startTop.y, endTop.y),
      bottom: Math.max(startBottom.y, endBottom.y),
      multiline,
    };
  }
  // Only the pointer is known: the lines around where the gesture started and ended.
  const end = valid(data.mousePosEnd) ? toDip(data.mousePosEnd) : cursor;
  const start = valid(data.mousePosStart) ? toDip(data.mousePosStart) : end;
  const [first, last] = end.y < start.y ? [end, start] : [start, end];
  const multiline = last.y - first.y > POINTER_LINE_SLOP;
  return {
    left: multiline ? first.x : Math.min(start.x, end.x),
    right: multiline ? last.x : Math.max(start.x, end.x),
    top: first.y - 18,
    bottom: last.y + 14,
    multiline,
  };
}

/** Owns the system selection hook and the toolbar/answer window that follows a selection. */
export class CompanionSelectionController {
  private module: SelectionHookModule | null | undefined;
  private hook: SelectionHookLike | null = null;
  private running = false;
  private window: BrowserWindow | null = null;
  private selection: DesktopCompanionSelection | null = null;
  private anchor: CompanionSelectionAnchor | null = null;
  private size: CompanionSize = { ...DesktopCompanionSize.Toolbar };
  /** Where the bare toolbar sits inside the window, excluding its reserved menu space. */
  private toolbarBounds: CompanionRect | null = null;
  /** The renderer hit-tests menu items so unused menu space still belongs to the app below. */
  private passThrough = true;
  /** The window height an answer card may grow to beside the selection. */
  private cardHeight: number = DesktopCompanionSize.Answer.height;
  /** A screenshot is in progress until then (ms since epoch). */
  private captureUntil = 0;
  /** The screenshot is taken when its first click or drag ends. */
  private captureOnRelease = false;
  private capturePressed = false;
  /** A screenshot tool's overlay is in front; the shot is done when it leaves. */
  private captureOverlay = false;
  /** The user dragged the toolbar or answer card away from the selection. */
  private moved = false;
  private pendingShow = false;
  private showTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private permissionTimer: ReturnType<typeof setInterval> | undefined;
  private readonly gesture = new SelectionGestureTracker();
  private pausedUntil = 0;
  private status: CompanionCapability = CompanionCapability.Off;

  constructor(
    private readonly host: SelectionHost,
    private readonly quickAnswer: CompanionQuickAnswerService,
    private readonly loadModule: () => SelectionHookModule | null = loadSelectionHook,
  ) {}

  get capability(): CompanionCapability {
    return this.status;
  }

  get webContentsId(): number | null {
    return this.window && !this.window.isDestroyed() ? this.window.webContents.id : null;
  }

  get browserWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  get selectionAnchor(): CompanionSelectionAnchor | null {
    return this.selection && this.anchor ? { ...this.anchor } : null;
  }

  /** The measured toolbar only, without the transparent space reserved for its menu. */
  get selectionToolbarBounds(): CompanionRect | null {
    return this.selection && this.toolbarBounds ? { ...this.toolbarBounds } : null;
  }

  /** A screenshot shortcut was pressed and its shot is not taken yet; nothing should close for it. */
  get capturing(): boolean {
    return Date.now() < this.captureUntil;
  }

  /** Re-evaluates whether the hook should run after preferences, snooze, or permission changes. */
  sync(): void {
    const preferences = this.host.preferences();
    const wanted = preferences.selectionToolbar && this.host.isAvailable() && Date.now() >= this.pausedUntil;
    const previous = this.status;
    if (!wanted) {
      this.status = CompanionCapability.Off;
      this.stopHook();
      this.hide();
    } else {
      // Load the native module only once someone actually wants the toolbar.
      if (this.module === undefined) this.module = this.loadModule();
      if (!this.module) {
        this.status = CompanionCapability.Unsupported;
      } else if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
        this.status = CompanionCapability.NeedsPermission;
        this.stopHook();
        this.watchPermission();
      } else {
        this.status = this.startHook() ? CompanionCapability.Ready : CompanionCapability.Unsupported;
        if (this.status === CompanionCapability.Ready) this.ensureWindow();
      }
    }
    if (previous !== this.status) this.host.publish();
  }

  /** Prompts for macOS Accessibility and opens the matching System Settings pane. */
  requestPermission(): void {
    if (process.platform !== 'darwin') return;
    if (!systemPreferences.isTrustedAccessibilityClient(true)) {
      void shell.openExternal(MAC_ACCESSIBILITY_SETTINGS).catch((): void => undefined);
      this.watchPermission();
    }
    this.sync();
  }

  onForegroundChange(appId?: string): void {
    this.cancelRecovery();
    // Some screenshot shortcuts never reach the hook; their overlay coming to the front tells instead.
    if (appId && isScreenshotApp(appId)) {
      if (!this.capturing) this.startCapture(false);
      this.captureOverlay = true;
      return;
    }
    if (this.capturing) {
      if (this.captureOverlay) {
        this.captureOverlay = false;
        this.captureUntil = Date.now() + CAPTURE_SETTLE_MS;
      }
      return;
    }
    if (this.selection?.mode === DesktopCompanionSelectionMode.Toolbar) this.hide();
  }

  updateExclusions(): void {
    if (!this.hook || !this.module) return;
    this.hook.setGlobalFilterMode(this.module.FilterMode.EXCLUDE_LIST, this.excludedApps());
  }

  /** Apps skipped natively, before any text is read from them. */
  private excludedApps(): string[] {
    return [...DEFAULT_SELECTION_EXCLUDED_APPS, ...this.host.preferences().selectionExcludedApps];
  }

  handleCommand(command: DesktopCompanionSelectionCommand): void {
    const selection = this.selection;
    switch (command?.type) {
      case DesktopCompanionSelectionCommandType.Run:
        if (!selection || selection.tooLarge || !isCompanionSelectionAction(command.action)) return;
        this.host.analytics?.report({ action: CompanionAnalyticsAction.Action, source: CompanionAnalyticsSource.Selection,
          interactionType: Interaction.Run, tool: command.action });
        // Replace the visible toolbar, excluding any menu space above it.
        this.moved = false;
        this.cardHeight = this.toolbarBounds
          ? Math.min(DesktopCompanionSize.Answer.height, screen.getDisplayNearestPoint(this.toolbarBounds).workArea.height)
          : this.anchor ? companionCardSlot(this.anchor, this.workArea(this.anchor)).room : DesktopCompanionSize.Answer.height;
        this.selection = {
          ...selection,
          mode: DesktopCompanionSelectionMode.Answer,
          action: command.action,
          menuOpen: false,
          menuUp: false,
          cardMaxHeight: this.cardHeight - DesktopCompanionSize.SurfacePad * 2,
        };
        this.size = { width: DesktopCompanionSize.Answer.width, height: Math.min(this.cardHeight, DesktopCompanionSize.AnswerStartHeight) };
        this.window?.setFocusable(true);
        this.place();
        this.sendSelection();
        return;
      case DesktopCompanionSelectionCommandType.Pin:
        if (!selection) return;
        this.host.analytics?.report({ action: CompanionAnalyticsAction.Action, source: CompanionAnalyticsSource.Selection,
          interactionType: Interaction.Pin, pinned: command.pinned === true });
        this.selection = { ...selection, pinned: command.pinned === true };
        this.sendSelection();
        return;
      case DesktopCompanionSelectionCommandType.ExcludeApp: {
        if (!selection?.appId) return;
        this.host.analytics?.report({ action: CompanionAnalyticsAction.Action, source: CompanionAnalyticsSource.Selection, interactionType: Interaction.ExcludeApp });
        const current = this.host.preferences().selectionExcludedApps;
        if (!current.includes(selection.appId)) {
          this.host.setPreferences({ selectionExcludedApps: [...current, selection.appId].slice(-100) });
        }
        this.hide();
        return;
      }
      case DesktopCompanionSelectionCommandType.Pause:
        this.host.analytics?.report({ action: CompanionAnalyticsAction.Action, source: CompanionAnalyticsSource.Selection, interactionType: Interaction.Pause });
        this.pausedUntil = Date.now() + PAUSE_MS;
        this.hide();
        this.sync();
        setTimeout(() => this.sync(), PAUSE_MS + 1_000).unref?.();
        return;
      case DesktopCompanionSelectionCommandType.FocusInput:
        if (this.window && !this.window.isDestroyed()) {
          this.window.setFocusable(true);
          this.window.focus();
        }
        return;
      case DesktopCompanionSelectionCommandType.More: {
        if (selection?.mode !== DesktopCompanionSelectionMode.Toolbar) return;
        const open = command.open === true;
        if (open && !selection.menuOpen) this.host.analytics?.report({ action: CompanionAnalyticsAction.Action,
          source: CompanionAnalyticsSource.Selection, interactionType: Interaction.More });
        this.selection = { ...selection, menuOpen: open };
        this.sendSelection();
        return;
      }
      case DesktopCompanionSelectionCommandType.Settings:
        this.host.analytics?.report({ action: CompanionAnalyticsAction.Action, source: CompanionAnalyticsSource.Selection, interactionType: Interaction.OpenSettings });
        this.hide();
        this.host.openSettings();
        return;
      case DesktopCompanionSelectionCommandType.PassThrough:
        this.passThrough = command.passThrough === true;
        if (this.window && !this.window.isDestroyed()) this.window.setIgnoreMouseEvents(this.passThrough, { forward: true });
        return;
      case DesktopCompanionSelectionCommandType.Dismiss:
        this.hide();
        return;
      default:
    }
  }

  /** The renderer measures the bare toolbar or card; toolbar placement also reserves menu space. */
  setContentSize(size: CompanionSize): void {
    if (!this.selection) return;
    const previousMenuUp = this.selection.menuUp;
    const max = this.maxSize(this.selection);
    this.size = {
      width: Math.max(120, Math.min(Math.ceil(size.width), max.width)),
      height: Math.max(40, Math.min(Math.ceil(size.height), max.height)),
    };
    this.place();
    if (this.selection.menuUp !== previousMenuUp) this.sendSelection();
    if (this.pendingShow) this.reveal();
  }

  hide(): void {
    clearTimeout(this.showTimer);
    this.pendingShow = false;
    this.endCapture();
    if (!this.selection) return;
    this.selection = null;
    const win = this.window;
    if (win && !win.isDestroyed()) {
      this.quickAnswer.abortOwnedBy(win.webContents.id);
      win.hide();
      win.setFocusable(false);
    }
    this.sendSelection();
  }

  dispose(): void {
    clearInterval(this.permissionTimer);
    clearTimeout(this.showTimer);
    this.stopHook();
    try { this.hook?.cleanup(); } catch { /* already released */ }
    this.hook = null;
    this.window?.destroy();
    this.window = null;
  }

  private maxSize(selection: DesktopCompanionSelection): CompanionSize {
    if (selection.mode === DesktopCompanionSelectionMode.Answer) return { width: DesktopCompanionSize.Answer.width, height: this.cardHeight };
    return DesktopCompanionSize.Toolbar;
  }

  private startCapture(onRelease: boolean): void {
    this.captureUntil = Date.now() + (onRelease ? CAPTURE_MS : CAPTURE_TOOLBAR_MS);
    this.captureOnRelease = onRelease;
    this.capturePressed = false;
  }

  private endCapture(): void {
    this.captureUntil = 0;
    this.captureOnRelease = false;
    this.capturePressed = false;
    this.captureOverlay = false;
  }

  private startHook(): boolean {
    if (!this.module) return false;
    if (this.running) return true;
    try {
      if (!this.hook) {
        this.hook = new this.module();
        this.hook.on('text-selection', this.onSelection);
        this.hook.on('mouse-down', this.onMouseDown);
        this.hook.on('mouse-up', this.onMouseUp);
        this.hook.on('mouse-wheel', this.onWheel);
        this.hook.on('key-down', this.onKeyDown);
        this.hook.on('error', (error: Error) => console.warn('[DesktopCompanion] Selection hook error:', error.message));
      }
      this.running = this.hook.start({
        debug: false,
        enableMouseMoveEvent: false,
        // Never synthesize Cmd/Ctrl+C: reading through the clipboard would overwrite what the user copied.
        enableClipboard: false,
        selectionPassiveMode: false,
        globalFilterMode: this.module.FilterMode.EXCLUDE_LIST,
        globalFilterList: this.excludedApps(),
      });
      if (this.running) console.log('[DesktopCompanion] Selection hook started');
      return this.running;
    } catch (error) {
      console.error('[DesktopCompanion] Selection hook failed to start:', error);
      this.running = false;
      return false;
    }
  }

  private stopHook(): void {
    this.cancelRecovery();
    if (!this.running) return;
    try { this.hook?.stop(); } catch (error) { console.warn('[DesktopCompanion] Selection hook stop failed:', error); }
    this.running = false;
  }

  private watchPermission(): void {
    if (this.permissionTimer) return;
    this.permissionTimer = setInterval(() => {
      if (!systemPreferences.isTrustedAccessibilityClient(false)) return;
      clearInterval(this.permissionTimer);
      this.permissionTimer = undefined;
      this.sync();
    }, PERMISSION_POLL_MS);
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const win = this.host.createWindow(DesktopCompanionSurface.Selection, false);
    win.on('closed', () => { if (this.window === win) this.window = null; });
    // Only a drag by the user emits will-move; a card moved out of the way stays open.
    win.on('will-move', () => this.onUserMove());
    win.on('move', () => this.updateToolbarPosition());
    win.webContents.on('did-finish-load', () => this.sendSelection());
    this.window = win;
    return win;
  }

  private onSelection = (data: SelectionHookEvent): void => {
    // The hook read this gesture itself.
    this.cancelRecovery();
    this.showSelection(data);
  };

  private showSelection(data: SelectionHookEvent): void {
    if (this.status !== CompanionCapability.Ready || !data) return;
    const text = typeof data.text === 'string' ? data.text : '';
    if (isCompanionSelectionBlocked(data.programName ?? '', this.host.preferences().selectionExcludedApps)) return;
    if (this.selection?.pinned) return;
    const tooLarge = isCompanionTextTooLarge(text);
    if (!tooLarge && !text.trim()) return;
    const fullLevel = this.module?.PositionLevel.SEL_FULL ?? 3;
    this.anchor = selectionAnchor(data, fullLevel, screen.getCursorScreenPoint());
    this.selection = {
      id: randomUUID(),
      // Copy must preserve the selection verbatim; AI requests apply their own limits.
      text: tooLarge ? '' : text,
      tooLarge,
      appId: data.programName ?? '',
      actions: tooLarge ? [] : rankCompanionSelectionActions(text),
      mode: DesktopCompanionSelectionMode.Toolbar,
      action: null,
      pinned: false,
      menuOpen: false,
      menuUp: false,
    };
    this.toolbarBounds = null;
    this.passThrough = true;
    this.moved = false;
    this.endCapture();
    const win = this.ensureWindow();
    if (!win.isDestroyed()) {
      this.quickAnswer.abortOwnedBy(win.webContents.id);
      win.setFocusable(false);
      // The margin around the toolbar overlaps the selected line; clicks there belong to the app.
      win.setIgnoreMouseEvents(true, { forward: true });
    }
    this.size = { ...DesktopCompanionSize.Toolbar };
    this.place();
    this.sendSelection();
    // Wait for the renderer to measure itself so the toolbar never flashes at the wrong size.
    this.pendingShow = true;
    clearTimeout(this.showTimer);
    this.showTimer = setTimeout(() => this.reveal(), SHOW_FALLBACK_MS);
  }

  private onMouseDown = (data: MouseEventData): void => {
    this.cancelRecovery();
    if (!valid(data)) return;
    if (data.button === LEFT_BUTTON) this.gesture.down(data, Date.now());
    // The click or drag that takes the screenshot.
    if (this.capturing) {
      this.capturePressed = true;
      return;
    }
    if (!this.selection || !this.window || this.window.isDestroyed() || !this.window.isVisible()) return;
    const point = toDip(data);
    if (this.selection.mode === DesktopCompanionSelectionMode.Toolbar) {
      if (this.toolbarBounds && rectContains(visibleArea(this.toolbarBounds), point)) return;
      if (this.selection.menuOpen && !this.passThrough && rectContains(visibleArea(this.window.getBounds()), point)) return;
    } else if (rectContains(visibleArea(this.window.getBounds()), point)) return;
    if (this.selection.mode === DesktopCompanionSelectionMode.Toolbar || !this.selection.pinned) this.hide();
  };

  private onMouseUp = (data: MouseEventData): void => {
    if (data?.button !== LEFT_BUTTON || !valid(data)) return;
    if (this.moved && this.selection?.mode === DesktopCompanionSelectionMode.Toolbar) {
      // Recheck screen edges after the drag, keeping the visible bar in place
      // when its reserved menu space needs to switch sides.
      this.updateToolbarPosition();
      const menuUp = this.selection.menuUp;
      this.place();
      if (this.selection.menuUp !== menuUp) this.sendSelection();
    }
    if (this.capturing && this.captureOnRelease && this.capturePressed) {
      this.captureUntil = Date.now() + CAPTURE_SETTLE_MS;
      this.captureOnRelease = false;
    }
    if (this.gesture.up(data, Date.now()) && process.platform === 'darwin') this.recoverSelection({ x: data.x, y: data.y });
  };

  private onWheel = (): void => {
    this.cancelRecovery();
    if (this.capturing) return;
    if (this.selection?.mode === DesktopCompanionSelectionMode.Toolbar) this.hide();
  };

  /** Typing closes the toolbar; shortcuts leave it, so a screenshot shortcut can capture it. */
  private onKeyDown = (data: SelectionKeyEvent): void => {
    if (data?.uniKey && MODIFIER_KEYS.has(data.uniKey)) return;
    this.cancelRecovery();
    if (this.capturing) {
      // Escape cancels the screenshot and Space switches it to a window; neither is meant for the toolbar.
      if (data?.uniKey === 'Escape') this.endCapture();
      return;
    }
    const effect = selectionKeyEffect(data ?? {}, process.platform);
    if (effect === SelectionKeyEffect.Capture || effect === SelectionKeyEffect.CaptureToolbar) {
      this.startCapture(effect === SelectionKeyEffect.Capture);
      return;
    }
    if (effect === SelectionKeyEffect.Dismiss && this.selection?.mode === DesktopCompanionSelectionMode.Toolbar) this.hide();
  };

  /**
   * selection-hook reads a selection once, at mouse-up. A Chromium or Electron app only turns
   * its accessibility tree on after such a read fails, so its first selection would be lost.
   */
  private recoverSelection(point: Point, attempt = 0): void {
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      // Skip while a toolbar or card is still up (the gesture hit it, or it is pinned) and while
      // LobsterAI itself is in front.
      if (this.status !== CompanionCapability.Ready || this.selection || BrowserWindow.getFocusedWindow()) return;
      const data = this.readCurrentSelection();
      if (attempt === 0) {
        // Text readable right away was readable at mouse-up too: the hook chose not to report it.
        if (!data) this.recoverSelection(point, 1);
        return;
      }
      if (data) {
        console.debug(`[DesktopCompanion] Recovered a selection the hook missed in ${data.programName}`);
        // A direct read reports the mouse at (0, 0); anchor where the gesture ended instead.
        this.showSelection({ ...data, mousePosStart: point, mousePosEnd: point });
      } else if (attempt + 1 < RECOVERY_READ_DELAYS_MS.length) {
        this.recoverSelection(point, attempt + 1);
      }
    }, RECOVERY_READ_DELAYS_MS[attempt]);
  }

  private readCurrentSelection(): SelectionHookEvent | null {
    try {
      const data = this.hook?.getCurrentSelection();
      return data && typeof data.text === 'string' && (isCompanionTextTooLarge(data.text) || data.text.trim()) ? data : null;
    } catch (error) {
      console.warn('[DesktopCompanion] Reading the current selection failed:', error);
      return null;
    }
  }

  private cancelRecovery(): void {
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  private reveal(): void {
    clearTimeout(this.showTimer);
    if (!this.pendingShow || !this.selection || !this.window || this.window.isDestroyed()) return;
    this.pendingShow = false;
    this.host.analytics?.report({ action: CompanionAnalyticsAction.Action, source: CompanionAnalyticsSource.Selection,
      interactionType: Interaction.Open, stage: CompanionAnalyticsStage.Shown, surface: DesktopCompanionSurface.Selection });
    this.window.showInactive();
  }

  private onUserMove(): void {
    const selection = this.selection;
    if (!selection) return;
    this.moved = true;
    if (selection.mode === DesktopCompanionSelectionMode.Toolbar) return;
    if (selection.pinned) return;
    this.selection = { ...selection, pinned: true };
    this.sendSelection();
  }

  private updateToolbarPosition(): void {
    if (!this.moved || this.selection?.mode !== DesktopCompanionSelectionMode.Toolbar || !this.window || this.window.isDestroyed()) return;
    const bounds = this.window.getBounds();
    this.toolbarBounds = {
      ...this.size,
      x: bounds.x,
      y: bounds.y + (this.selection.menuUp ? bounds.height - this.size.height : 0),
    };
  }

  private workArea(anchor: CompanionSelectionAnchor): CompanionRect {
    return screen.getDisplayNearestPoint({ x: Math.round(anchor.left), y: Math.round(anchor.top) }).workArea;
  }

  private place(): void {
    if (!this.window || this.window.isDestroyed() || !this.anchor) return;
    const position = this.moved ? this.window.getBounds() : this.toolbarBounds;
    const workArea = position ? screen.getDisplayNearestPoint(position).workArea : this.workArea(this.anchor);
    const selection = this.selection;
    if (selection?.mode === DesktopCompanionSelectionMode.Toolbar) {
      const bounds = this.moved && this.toolbarBounds
        ? clampCompanionBounds({ ...this.toolbarBounds, ...this.size }, workArea)
        : resolveCompanionToolbarBounds(this.anchor, this.size, workArea).bounds;
      this.toolbarBounds = bounds;
      const menuUp = companionMenuOpensUp(bounds, DesktopCompanionSize.ToolbarMenu, workArea);
      this.selection = { ...selection, menuUp };
      // Reserve the menu before revealing the window. Toggling it only changes content,
      // avoiding a native resize/move racing the renderer's next frame.
      const expandedSize = { ...this.size, height: this.size.height + DesktopCompanionSize.ToolbarMenu };
      this.window.setBounds(resolveCompanionToolbarMenuBounds(bounds, expandedSize, menuUp, workArea));
    } else if (this.moved) {
      // A card the user moved keeps its spot as the answer grows.
      const { x, y } = this.window.getBounds();
      this.window.setBounds(clampCompanionBounds({ ...this.size, x, y }, workArea));
    } else {
      this.window.setBounds(resolveCompanionCardBounds(this.anchor, this.size, workArea, this.toolbarBounds));
    }
  }

  private sendSelection(): void {
    const win = this.window;
    if (win && !win.isDestroyed()) win.webContents.send(DesktopCompanionIpc.Selection, this.selection);
  }
}
