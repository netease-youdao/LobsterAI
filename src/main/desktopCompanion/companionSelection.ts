import { randomUUID } from 'crypto';
import { type BrowserWindow, clipboard, Menu, screen, shell, systemPreferences } from 'electron';
import type { EventEmitter } from 'events';

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
  type CompanionSelectionAnchor,
  type CompanionSize,
  rectContains,
  resolveCompanionSelectionBounds,
} from '../../shared/desktopCompanion/geometry';
import {
  COMPANION_SELECTION_MAX_CHARS,
  isCompanionSelectionAction,
  rankCompanionSelectionActions,
} from '../../shared/desktopCompanion/selectionActions';
import { t } from '../i18n';
import type { CompanionQuickAnswerService } from './quickAnswerService';

const INVALID_COORDINATE = -99999;
const PAUSE_MS = 60 * 60_000;
const PERMISSION_POLL_MS = 2_000;
const SHOW_FALLBACK_MS = 150;
const MAC_ACCESSIBILITY_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'AltGraph', 'OS']);

interface Point { x: number; y: number }

/** The subset of selection-hook's TextSelectionData the companion uses. */
export interface SelectionHookEvent {
  text: string;
  programName: string;
  startTop: Point;
  endTop: Point;
  endBottom: Point;
  mousePosEnd: Point;
  posLevel: number;
}

export interface SelectionHookLike extends EventEmitter {
  start(config?: Record<string, unknown>): boolean;
  stop(): boolean;
  cleanup(): void;
  setGlobalFilterMode(mode: number, list?: string[]): boolean;
}

export interface SelectionHookModule {
  new (): SelectionHookLike;
  FilterMode: { EXCLUDE_LIST: number };
  PositionLevel: { SEL_FULL: number };
}

export interface SelectionHost {
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

/** Selection-hook reports physical pixels on Windows and points on macOS. */
function toDip(point: Point): Point {
  return process.platform === 'win32' ? screen.screenToDipPoint(point) : point;
}

export function selectionAnchor(data: SelectionHookEvent, fullLevel: number, cursor: Point): CompanionSelectionAnchor {
  const mouse = valid(data.mousePosEnd) ? toDip(data.mousePosEnd) : cursor;
  if (data.posLevel >= fullLevel && valid(data.endBottom) && valid(data.endTop)) {
    const top = toDip(data.endTop);
    const bottom = toDip(data.endBottom);
    return { x: mouse.x - 28, top: top.y, bottom: bottom.y };
  }
  return { x: mouse.x - 28, top: mouse.y - 18, bottom: mouse.y + 14 };
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
  private pendingShow = false;
  private showTimer: ReturnType<typeof setTimeout> | undefined;
  private permissionTimer: ReturnType<typeof setInterval> | undefined;
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

  onForegroundChange(): void {
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
        if (!selection || !isCompanionSelectionAction(command.action)) return;
        this.selection = { ...selection, mode: DesktopCompanionSelectionMode.Answer, action: command.action };
        this.size = { ...DesktopCompanionSize.Answer };
        this.window?.setFocusable(true);
        this.place();
        this.sendSelection();
        return;
      case DesktopCompanionSelectionCommandType.Pin:
        if (!selection) return;
        this.selection = { ...selection, pinned: command.pinned === true };
        this.sendSelection();
        return;
      case DesktopCompanionSelectionCommandType.ExcludeApp: {
        if (!selection?.appId) return;
        const current = this.host.preferences().selectionExcludedApps;
        if (!current.includes(selection.appId)) {
          this.host.setPreferences({ selectionExcludedApps: [...current, selection.appId].slice(-100) });
        }
        this.hide();
        return;
      }
      case DesktopCompanionSelectionCommandType.Pause:
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
      case DesktopCompanionSelectionCommandType.More:
        this.showMoreMenu();
        return;
      case DesktopCompanionSelectionCommandType.Dismiss:
        this.hide();
        return;
      default:
    }
  }

  /** The renderer reports its measured content so the window hugs the toolbar or card. */
  setContentSize(size: CompanionSize): void {
    if (!this.selection) return;
    const max = this.selection.mode === DesktopCompanionSelectionMode.Answer ? DesktopCompanionSize.Answer : DesktopCompanionSize.Toolbar;
    this.size = {
      width: Math.max(120, Math.min(Math.ceil(size.width), max.width)),
      height: Math.max(40, Math.min(Math.ceil(size.height), max.height)),
    };
    this.place();
    if (this.pendingShow) this.reveal();
  }

  hide(): void {
    clearTimeout(this.showTimer);
    this.pendingShow = false;
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

  private showMoreMenu(): void {
    const selection = this.selection;
    const win = this.window;
    if (!selection || !win || win.isDestroyed()) return;
    Menu.buildFromTemplate([
      { label: t('desktopCompanionSelectionCopy'), click: () => { clipboard.writeText(selection.text); this.hide(); } },
      { type: 'separator' },
      { label: t('desktopCompanionSelectionExclude'), click: () => this.handleCommand({ type: DesktopCompanionSelectionCommandType.ExcludeApp }) },
      { label: t('desktopCompanionSelectionPause'), click: () => this.handleCommand({ type: DesktopCompanionSelectionCommandType.Pause }) },
      { label: t('desktopCompanionSelectionSettings'), click: () => { this.hide(); this.host.openSettings(); } },
    ]).popup({ window: win });
  }

  private startHook(): boolean {
    if (!this.module) return false;
    if (this.running) return true;
    try {
      if (!this.hook) {
        this.hook = new this.module();
        this.hook.on('text-selection', this.onSelection);
        this.hook.on('mouse-down', this.onMouseDown);
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
    win.webContents.on('did-finish-load', () => this.sendSelection());
    this.window = win;
    return win;
  }

  private onSelection = (data: SelectionHookEvent): void => {
    if (this.status !== CompanionCapability.Ready || !data) return;
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text || isCompanionSelectionBlocked(data.programName ?? '', this.host.preferences().selectionExcludedApps)) return;
    if (this.selection?.pinned) return;
    const fullLevel = this.module?.PositionLevel.SEL_FULL ?? 3;
    this.anchor = selectionAnchor(data, fullLevel, screen.getCursorScreenPoint());
    this.selection = {
      id: randomUUID(),
      text: [...text].slice(0, COMPANION_SELECTION_MAX_CHARS).join(''),
      appId: data.programName ?? '',
      actions: rankCompanionSelectionActions(text),
      mode: DesktopCompanionSelectionMode.Toolbar,
      action: null,
      pinned: false,
    };
    const win = this.ensureWindow();
    if (!win.isDestroyed()) {
      this.quickAnswer.abortOwnedBy(win.webContents.id);
      win.setFocusable(false);
    }
    this.size = { ...DesktopCompanionSize.Toolbar };
    this.place();
    this.sendSelection();
    // Wait for the renderer to measure itself so the toolbar never flashes at the wrong size.
    this.pendingShow = true;
    clearTimeout(this.showTimer);
    this.showTimer = setTimeout(() => this.reveal(), SHOW_FALLBACK_MS);
  };

  private onMouseDown = (data: Point): void => {
    if (!this.selection || !this.window || this.window.isDestroyed() || !this.window.isVisible()) return;
    if (!valid(data)) return;
    if (rectContains(this.window.getBounds(), toDip(data))) return;
    if (this.selection.mode === DesktopCompanionSelectionMode.Toolbar || !this.selection.pinned) this.hide();
  };

  private onWheel = (): void => {
    if (this.selection?.mode === DesktopCompanionSelectionMode.Toolbar) this.hide();
  };

  private onKeyDown = (data: { uniKey?: string }): void => {
    if (this.selection?.mode !== DesktopCompanionSelectionMode.Toolbar) return;
    if (data?.uniKey && MODIFIER_KEYS.has(data.uniKey)) return;
    this.hide();
  };

  private reveal(): void {
    clearTimeout(this.showTimer);
    if (!this.pendingShow || !this.selection || !this.window || this.window.isDestroyed()) return;
    this.pendingShow = false;
    this.window.showInactive();
  }

  private place(): void {
    if (!this.window || this.window.isDestroyed() || !this.anchor) return;
    const display = screen.getDisplayNearestPoint({ x: Math.round(this.anchor.x), y: Math.round(this.anchor.bottom) });
    this.window.setBounds(resolveCompanionSelectionBounds(this.anchor, this.size, display.workArea));
  }

  private sendSelection(): void {
    const win = this.window;
    if (win && !win.isDestroyed()) win.webContents.send(DesktopCompanionIpc.Selection, this.selection);
  }
}
