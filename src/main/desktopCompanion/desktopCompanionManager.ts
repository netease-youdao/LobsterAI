import {
  type BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  type Rectangle,
  screen,
} from 'electron';
import fs from 'fs';
import path from 'path';

import { categorizeCompanionApp, CompanionAppCategory, isCompanionQuietCategory } from '../../shared/desktopCompanion/appCategories';
import {
  CompanionPermission as CompanionPermissionValue,
  type CompanionQuickAnswerRequest,
  type CompanionSurfaceSize,
  DEFAULT_DESKTOP_COMPANION_PREFERENCES,
  type DesktopCompanionAttachment,
  type DesktopCompanionDraft,
  DesktopCompanionDragPhase,
  type DesktopCompanionDropFile,
  DesktopCompanionDropSource,
  DesktopCompanionFileDragPhase,
  DesktopCompanionIpc,
  type DesktopCompanionPreferences,
  type DesktopCompanionResult,
  type DesktopCompanionSelectionCommand,
  DesktopCompanionSize,
  type DesktopCompanionSnooze,
  DesktopCompanionSnoozeMode,
  type DesktopCompanionStageCommand,
  DesktopCompanionStageKind,
  DesktopCompanionStageSide,
  type DesktopCompanionState,
  DesktopCompanionStoreKey,
  DesktopCompanionSurface,
  DesktopCompanionTiming,
  EMPTY_DESKTOP_COMPANION_DRAFT,
} from '../../shared/desktopCompanion/constants';
import {
  type CompanionFileKind,
  CompanionFileKind as FileKind,
  companionFileKindFromName,
  isCompanionDocumentKind,
} from '../../shared/desktopCompanion/fileKinds';
import {
  clampCompanionBounds,
  companionGaze,
  type CompanionPoint,
  companionStageOpensLeft,
  resolveCompanionBounds,
  resolveCompanionComposerBounds,
} from '../../shared/desktopCompanion/geometry';
import { companionHintCopyKeys, type CompanionHintTopic } from '../../shared/desktopCompanion/hintPolicy';
import { isSpeechActive, SpeechCommand } from '../../shared/desktopCompanion/languageTools';
import { COMPANION_SKINS, normalizeCompanionSkin } from '../../shared/desktopCompanion/skins';
import { t } from '../i18n';
import { CompanionHintsController } from './companionHints';
import { CompanionSelectionController, type SelectionHookModule } from './companionSelection';
import { CompanionStageController } from './companionStage';
import { type CompanionWindowEnvironment, createCompanionWindow } from './companionWindow';
import { CompanionFileDragMonitor, FileDragEvent, type FileDragMonitor, type FileDragStart } from './fileDragMonitor';
import { CompanionForegroundMonitor, type ForegroundAppMonitor } from './foregroundAppMonitor';
import type { CompanionLanguageClient } from './languageToolClient';
import { CompanionLanguageToolsController } from './languageToolsController';
import { CompanionQuickAnswerService } from './quickAnswerService';

const MAX_SNOOZE_TIMER_MS = 24 * 60 * 60_000;

interface CompanionStore {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
}

export interface DesktopCompanionServices {
  languageClient?: CompanionLanguageClient;
  foreground?: ForegroundAppMonitor;
  fileDrag?: FileDragMonitor;
  quickAnswer?: CompanionQuickAnswerService;
  loadSelectionHook?: () => SelectionHookModule | null;
}

interface DesktopCompanionOptions {
  store: CompanionStore;
  preloadPath: string;
  rendererDirectory: string;
  devServerUrl?: string;
  getMainWindow(): BrowserWindow | null;
  openMain(sessionId?: string | null): void;
  openSettings?(): void;
  onPreferencesChanged(): void;
  services?: DesktopCompanionServices;
}

export function normalizeCompanionPreferences(value: unknown): DesktopCompanionPreferences {
  const stored = (value && typeof value === 'object' ? value : {}) as Partial<DesktopCompanionPreferences>;
  return {
    enabled: stored.enabled === true,
    shortcut: typeof stored.shortcut === 'string' ? stored.shortcut : DEFAULT_DESKTOP_COMPANION_PREFERENCES.shortcut,
    skin: normalizeCompanionSkin(stored.skin),
    selectionToolbar: stored.selectionToolbar !== false,
    dragAssist: stored.dragAssist !== false,
    contextHints: stored.contextHints !== false,
    selectionExcludedApps: Array.isArray(stored.selectionExcludedApps)
      ? stored.selectionExcludedApps.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map(item => item.trim().slice(0, 200)).slice(0, 100)
      : [],
  };
}

export function normalizeCompanionDraft(value: unknown): DesktopCompanionDraft {
  const draft = value as Partial<DesktopCompanionDraft> | null;
  return {
    prompt: typeof draft?.prompt === 'string' ? draft.prompt.slice(0, 64_000) : EMPTY_DESKTOP_COMPANION_DRAFT.prompt,
    workingDirectory: typeof draft?.workingDirectory === 'string' ? draft.workingDirectory.slice(0, 4096) : '',
    attachments: Array.isArray(draft?.attachments) ? draft.attachments.filter(file => (
      file && typeof file.path === 'string' && typeof file.name === 'string'
      && file.path.length > 0 && file.path.length <= 4096
    )).slice(0, 20).map(file => ({
      path: file.path, name: file.name.slice(0, 255), isImage: file.isImage === true, isDirectory: file.isDirectory === true,
    })) : [],
  };
}

function normalizeSnooze(value: unknown, now: number): DesktopCompanionSnooze | null {
  const snooze = value as Partial<DesktopCompanionSnooze> | null;
  if (!snooze || typeof snooze.until !== 'number' || snooze.until <= now) return null;
  if (snooze.mode !== DesktopCompanionSnoozeMode.Hidden && snooze.mode !== DesktopCompanionSnoozeMode.Quiet) return null;
  return { mode: snooze.mode, until: snooze.until };
}

function endOfToday(now: number): number {
  const date = new Date(now);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

/** Lists dropped paths with their kinds; folders are recognised so they can be organised. */
function describeDraggedPaths(paths: string[]): DesktopCompanionDropFile[] {
  return paths.slice(0, 20).map(filePath => {
    const name = path.basename(filePath);
    let kind: CompanionFileKind = companionFileKindFromName(name);
    if (kind === FileKind.Other) {
      try { if (fs.statSync(filePath).isDirectory()) kind = FileKind.Folder; } catch { /* vanished mid-drag */ }
    }
    return { name, kind };
  });
}

export class DesktopCompanionManager {
  private orb: BrowserWindow | null = null;
  private panel: BrowserWindow | null = null;
  private panelVisible = false;
  /** Height of the composer card plus its shadow margin, as the panel last reported it. */
  private panelCardHeight: number = DesktopCompanionSize.PanelCompactHeight;
  private preferences: DesktopCompanionPreferences;
  private draft: DesktopCompanionDraft;
  private sessionId: string | null;
  private position: CompanionPoint | undefined;
  private snooze: DesktopCompanionSnooze | null;
  private revision = 0;
  private shortcutUnavailable = false;
  private registeredShortcut = '';
  private disposing = false;
  private fileDragActive = false;
  private foregroundAppId: string | null = null;
  private dragOrigin: { cursor: CompanionPoint; position: CompanionPoint } | null = null;
  private draftSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private snoozeTimer: ReturnType<typeof setTimeout> | undefined;
  private gazeTimer: ReturnType<typeof setInterval> | undefined;
  private lastGaze = '';
  private readonly env: CompanionWindowEnvironment;
  private readonly foreground: ForegroundAppMonitor;
  private readonly fileDrag: FileDragMonitor;
  private readonly quickAnswer: CompanionQuickAnswerService;
  private readonly stage: CompanionStageController;
  private readonly hints: CompanionHintsController;
  private readonly selection: CompanionSelectionController;
  private readonly languageTools: CompanionLanguageToolsController;

  constructor(private readonly options: DesktopCompanionOptions) {
    const { store } = options;
    this.preferences = normalizeCompanionPreferences(store.get(DesktopCompanionStoreKey.Preferences));
    this.draft = normalizeCompanionDraft(store.get(DesktopCompanionStoreKey.Draft));
    const sessionId = store.get(DesktopCompanionStoreKey.Session);
    this.sessionId = typeof sessionId === 'string' ? sessionId : null;
    this.position = store.get<CompanionPoint>(DesktopCompanionStoreKey.Position);
    this.snooze = normalizeSnooze(store.get(DesktopCompanionStoreKey.Snooze), Date.now());
    this.env = {
      preloadPath: options.preloadPath,
      rendererDirectory: options.rendererDirectory,
      devServerUrl: options.devServerUrl,
      title: t('desktopCompanionTitle'),
    };
    const services = options.services ?? {};
    this.foreground = services.foreground ?? new CompanionForegroundMonitor();
    this.fileDrag = services.fileDrag ?? new CompanionFileDragMonitor();
    this.quickAnswer = services.quickAnswer ?? new CompanionQuickAnswerService();
    this.stage = new CompanionStageController({
      getOrbBounds: () => this.orbBounds(),
      createWindow: (surface, focusable) => this.createWindow(surface, focusable),
      publish: () => this.publish(),
    }, {
      onHintOutcome: (topic, outcome) => this.hints.recordOutcome(topic, outcome),
      onHintAccept: topic => this.acceptHint(topic),
      onDropAsk: attachments => this.openPanelWithAttachments(attachments),
      onDropStarted: id => this.followTask(id),
      onTaskOpen: id => this.openTask(id),
    });
    this.hints = new CompanionHintsController({
      store,
      isEnabled: () => this.preferences.enabled && this.preferences.contextHints && !this.snooze,
      isQuiet: category => this.isBusy(category),
      showHint: (topic, variant) => this.showHint(topic, variant),
    });
    this.selection = new CompanionSelectionController({
      preferences: () => this.preferences,
      isAvailable: () => this.isPresent(),
      createWindow: (surface, focusable) => this.createWindow(surface, focusable),
      setPreferences: patch => { this.setPreferences(patch); },
      publish: () => this.publish(),
      openSettings: () => this.options.openSettings?.(),
    }, this.quickAnswer, services.loadSelectionHook);

    this.languageTools = new CompanionLanguageToolsController({
      createWindow: () => this.createWindow(DesktopCompanionSurface.LanguageTools, true),
      getSelectionAnchor: () => this.selection.selectionAnchor,
      assertSender: id => this.assertSender(id),
      publish: () => this.publish(),
      hideSelection: () => this.selection.hide(),
      abortFollowUp: id => this.quickAnswer.abortOwnedBy(id),
    }, services.languageClient);

    this.foreground.on('change', this.onForegroundChange);
    this.fileDrag.on(FileDragEvent.Start, this.onGlobalDragStart);
    this.fileDrag.on(FileDragEvent.End, this.onGlobalDragEnd);
    this.registerIpc();
    screen.on('display-removed', this.reposition);
    screen.on('display-metrics-changed', this.reposition);
    this.shortcutUnavailable = !this.registerShortcut(this.preferences.shortcut);
    this.scheduleSnoozeWake();
    this.applyActivity();
  }

  getState(): DesktopCompanionState {
    const category = this.foregroundAppId ? categorizeCompanionApp(this.foregroundAppId) : null;
    return {
      revision: this.revision,
      speechStatus: this.languageTools.speechStatus,
      preferences: { ...this.preferences, selectionExcludedApps: [...this.preferences.selectionExcludedApps] },
      panelVisible: this.panelVisible,
      sessionId: this.sessionId,
      draft: { ...this.draft, attachments: [...this.draft.attachments] },
      shortcutUnavailable: this.shortcutUnavailable,
      snooze: this.snooze ? { ...this.snooze } : null,
      stage: this.stage.stage,
      stageSide: this.stageSide(),
      fileDragActive: this.fileDragActive,
      foreground: this.foregroundAppId && category ? { appId: this.foregroundAppId, category } : null,
      capabilities: {
        selection: this.selection.capability,
        foregroundApp: this.foreground.capability,
        globalDrag: this.fileDrag.capability,
      },
    };
  }

  setPreferences(patch: Partial<DesktopCompanionPreferences>): DesktopCompanionResult {
    const next = { ...this.preferences };
    if (typeof patch?.enabled === 'boolean') next.enabled = patch.enabled;
    if (typeof patch?.shortcut === 'string') next.shortcut = patch.shortcut.trim().slice(0, 100);
    if (typeof patch?.skin === 'string') next.skin = normalizeCompanionSkin(patch.skin);
    if (typeof patch?.selectionToolbar === 'boolean') next.selectionToolbar = patch.selectionToolbar;
    if (typeof patch?.dragAssist === 'boolean') next.dragAssist = patch.dragAssist;
    if (typeof patch?.contextHints === 'boolean') next.contextHints = patch.contextHints;
    if (Array.isArray(patch?.selectionExcludedApps)) {
      next.selectionExcludedApps = normalizeCompanionPreferences({ selectionExcludedApps: patch.selectionExcludedApps }).selectionExcludedApps;
    }
    const updatingShortcut = typeof patch?.shortcut === 'string';
    if (updatingShortcut && !this.registerShortcut(next.shortcut)) {
      return { success: false, state: this.getState(), error: t('desktopCompanionShortcutConflict') };
    }
    if (updatingShortcut) this.shortcutUnavailable = false;
    const turningOn = next.enabled && !this.preferences.enabled;
    const exclusionsChanged = next.selectionExcludedApps.join('\n') !== this.preferences.selectionExcludedApps.join('\n');
    this.preferences = next;
    if (!next.enabled) this.languageTools.reset();
    this.options.store.set(DesktopCompanionStoreKey.Preferences, next);
    if (turningOn && this.snooze) this.wake(false);
    if (!next.contextHints && this.stage.stage.kind === DesktopCompanionStageKind.Hint) this.stage.clear();
    this.applyActivity();
    if (exclusionsChanged) this.selection.updateExclusions();
    this.publish();
    this.options.onPreferencesChanged();
    return { success: true, state: this.getState() };
  }

  togglePanel(): void {
    if (this.panelVisible) this.hidePanel();
    else this.showPanel();
  }

  resetLanguageTools(): void { this.languageTools.reset(); }

  hidePanel(): void {
    if (!this.panelVisible) return;
    this.panelVisible = false;
    this.panel?.hide();
    this.flushDraft();
    this.publish();
  }

  snoozeFor(mode: DesktopCompanionSnoozeMode): void {
    const now = Date.now();
    this.snooze = { mode, until: mode === DesktopCompanionSnoozeMode.Hidden ? now + DesktopCompanionTiming.SnoozeHourMs : endOfToday(now) };
    this.options.store.set(DesktopCompanionStoreKey.Snooze, this.snooze);
    this.stage.clear();
    this.scheduleSnoozeWake();
    this.applyActivity();
    this.publish();
  }

  wake(apply = true): void {
    clearTimeout(this.snoozeTimer);
    this.snooze = null;
    this.options.store.set(DesktopCompanionStoreKey.Snooze, null);
    if (!apply) return;
    this.applyActivity();
    this.publish();
  }

  dispose(): void {
    this.disposing = true;
    this.flushDraft();
    if (this.registeredShortcut) globalShortcut.unregister(this.registeredShortcut);
    clearTimeout(this.snoozeTimer);
    this.stopGaze();
    screen.removeListener('display-removed', this.reposition);
    screen.removeListener('display-metrics-changed', this.reposition);
    for (const channel of [
      DesktopCompanionIpc.Drag, DesktopCompanionIpc.OrbFileDrag, DesktopCompanionIpc.ResizeSurface,
      DesktopCompanionIpc.TaskUpdated, DesktopCompanionIpc.PanelPassThrough,
    ]) ipcMain.removeAllListeners(channel);
    for (const channel of Object.values(DesktopCompanionIpc)) ipcMain.removeHandler(channel);
    this.foreground.removeListener('change', this.onForegroundChange);
    this.fileDrag.removeListener(FileDragEvent.Start, this.onGlobalDragStart);
    this.fileDrag.removeListener(FileDragEvent.End, this.onGlobalDragEnd);
    this.foreground.stop();
    this.fileDrag.stop();
    this.hints.dispose();
    this.selection.dispose();
    this.stage.dispose();
    this.quickAnswer.dispose();
    this.languageTools.dispose();
    this.orb?.destroy();
    this.panel?.destroy();
    this.orb = null;
    this.panel = null;
  }

  private stageSide(): DesktopCompanionStageSide {
    const orb = this.orbBounds() ?? this.defaultOrbBounds();
    return companionStageOpensLeft(orb, screen.getDisplayMatching(orb).workArea)
      ? DesktopCompanionStageSide.Left
      : DesktopCompanionStageSide.Right;
  }

  // ── Activity ──────────────────────────────────────────────

  /** Present on screen: enabled and not hidden by a snooze. */
  private isPresent(): boolean {
    return this.preferences.enabled && this.snooze?.mode !== DesktopCompanionSnoozeMode.Hidden;
  }

  private isBusy(category: CompanionAppCategory): boolean {
    return this.panelVisible
      || this.stage.stage.kind !== DesktopCompanionStageKind.None
      || this.fileDragActive
      || isCompanionQuietCategory(category)
      || this.foreground.isUserBusy();
  }

  /** Reconciles windows and system monitors with preferences and snooze. */
  private applyActivity(): void {
    if (this.disposing) return;
    const present = this.isPresent();
    if (present) this.showOrb();
    else this.hideOrb();
    if (present) this.foreground.start();
    else this.foreground.stop();
    if (present && this.preferences.dragAssist && !this.snooze) this.fileDrag.start();
    else this.fileDrag.stop();
    if (!present || this.snooze) this.stage.clear();
    this.selection.sync();
  }

  private scheduleSnoozeWake(): void {
    clearTimeout(this.snoozeTimer);
    if (!this.snooze) return;
    const delay = Math.max(0, Math.min(this.snooze.until - Date.now(), MAX_SNOOZE_TIMER_MS));
    this.snoozeTimer = setTimeout(() => {
      if (this.snooze && Date.now() >= this.snooze.until) this.wake();
      else this.scheduleSnoozeWake();
    }, delay + 500);
  }

  // ── Orb ───────────────────────────────────────────────────

  private createWindow(surface: DesktopCompanionSurface, focusable: boolean, bounds?: Rectangle): BrowserWindow {
    const anchor = bounds ?? this.orbBounds() ?? this.defaultOrbBounds();
    return createCompanionWindow(this.env, { surface, focusable, bounds: { ...anchor } });
  }

  private defaultOrbBounds(): Rectangle {
    const point = this.position;
    const display = point && Number.isFinite(point.x) && Number.isFinite(point.y)
      ? screen.getDisplayNearestPoint(point)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    return resolveCompanionBounds(point, display.workArea);
  }

  /** Where the orb sits, or null when it is not on screen. */
  private orbBounds(): Rectangle | null {
    if (!this.orb || this.orb.isDestroyed()) return null;
    return this.defaultOrbBounds();
  }

  private showOrb(): void {
    if (!this.orb || this.orb.isDestroyed()) {
      const bounds = this.defaultOrbBounds();
      const win = this.createWindow(DesktopCompanionSurface.Mascot, false, bounds);
      win.on('closed', () => { if (this.orb === win) this.orb = null; });
      win.once('ready-to-show', () => {
        if (this.disposing || win.isDestroyed() || !this.isPresent()) return;
        win.showInactive();
        this.hints.scheduleWelcome();
      });
      this.orb = win;
    } else if (!this.orb.webContents.isLoadingMainFrame() && !this.orb.isVisible()) {
      this.orb.showInactive();
    }
    this.startGaze();
  }

  private hideOrb(): void {
    this.stopGaze();
    if (this.orb && !this.orb.isDestroyed()) this.orb.destroy();
    this.orb = null;
  }

  private startGaze(): void {
    if (this.gazeTimer) return;
    this.gazeTimer = setInterval(() => {
      const bounds = this.orbBounds();
      if (!bounds || !this.orb || this.orb.isDestroyed() || !this.orb.isVisible()) return;
      const gaze = companionGaze(bounds, screen.getCursorScreenPoint());
      const key = `${gaze.x},${gaze.y}`;
      if (key === this.lastGaze) return;
      this.lastGaze = key;
      this.orb.webContents.send(DesktopCompanionIpc.Gaze, gaze);
    }, DesktopCompanionTiming.GazeIntervalMs);
  }

  private stopGaze(): void {
    clearInterval(this.gazeTimer);
    this.gazeTimer = undefined;
    this.lastGaze = '';
  }

  private savePosition(point: CompanionPoint): void {
    this.position = { x: point.x, y: point.y };
    this.options.store.set(DesktopCompanionStoreKey.Position, this.position);
  }

  private move(phase: DesktopCompanionDragPhase): void {
    if (!this.orb || this.orb.isDestroyed()) return;
    if (phase === DesktopCompanionDragPhase.Cancel) { this.dragOrigin = null; return; }
    const cursor = screen.getCursorScreenPoint();
    if (phase === DesktopCompanionDragPhase.Start) {
      const start = this.orbBounds() ?? this.orb.getBounds();
      this.dragOrigin = { cursor, position: { x: start.x, y: start.y } };
      return;
    }
    if (!this.dragOrigin) return;
    const workArea = screen.getDisplayNearestPoint(cursor).workArea;
    const moved = clampCompanionBounds({
      ...DesktopCompanionSize.Orb,
      x: this.dragOrigin.position.x + cursor.x - this.dragOrigin.cursor.x,
      y: this.dragOrigin.position.y + cursor.y - this.dragOrigin.cursor.y,
    }, workArea);
    // Stays where it is dropped, wholly on the display under the cursor: no edge snapping or tucking.
    this.orb.setBounds(moved);
    if (phase === DesktopCompanionDragPhase.End) {
      this.dragOrigin = null;
      this.savePosition(moved);
      this.publish();
    } else {
      this.position = { x: moved.x, y: moved.y };
    }
    this.stage.reposition();
    this.positionPanel();
  }

  private reposition = (): void => {
    if (this.orb && !this.orb.isDestroyed()) {
      const bounds = this.defaultOrbBounds();
      this.orb.setBounds(bounds);
      this.savePosition(bounds);
    }
    this.stage.reposition();
    this.positionPanel();
  };

  // ── Panel ─────────────────────────────────────────────────

  private showPanel(): void {
    const stageKind = this.stage.stage.kind;
    if (stageKind === DesktopCompanionStageKind.Hint || stageKind === DesktopCompanionStageKind.Task) this.stage.clear();
    if (!this.panel || this.panel.isDestroyed()) {
      const win = this.createWindow(DesktopCompanionSurface.Panel, true, this.panelBounds());
      win.on('close', event => {
        if (this.disposing) return;
        event.preventDefault();
        this.hidePanel();
      });
      win.on('hide', () => this.hidePanel());
      win.on('closed', () => { if (this.panel === win) this.panel = null; });
      win.once('ready-to-show', () => {
        if (this.disposing || win.isDestroyed() || !this.panelVisible) return;
        win.show();
        win.focus();
      });
      this.panel = win;
    }
    this.panelVisible = true;
    // Clicks go through the empty room above the card only while the pointer is there.
    this.panel.setIgnoreMouseEvents(false);
    this.positionPanel();
    if (!this.panel.webContents.isLoadingMainFrame()) {
      this.panel.show();
      this.panel.focus();
    }
    this.publish();
  }

  private panelBounds(): Rectangle {
    const anchor = this.orbBounds() ?? this.defaultOrbBounds();
    const card = { width: DesktopCompanionSize.Composer.width + DesktopCompanionSize.SurfacePad * 2, height: this.panelCardHeight };
    // Opens like the hint bubbles, beside the character, with room above for the composer's menus.
    return resolveCompanionComposerBounds(anchor, card, DesktopCompanionSize.ComposerMenuRoom, screen.getDisplayMatching(anchor).workArea);
  }

  /** The panel reports its card size as the prompt grows. */
  private setPanelContentSize(size: CompanionSurfaceSize): void {
    const pad = DesktopCompanionSize.SurfacePad;
    const height = Math.max(pad * 4, Math.min(Math.ceil(size.height), DesktopCompanionSize.Composer.maxHeight + pad * 2));
    if (height === this.panelCardHeight) return;
    this.panelCardHeight = height;
    this.positionPanel();
  }

  /** The orb follows a task it just started, and its status strip comes out unless the composer is open. */
  private followTask(sessionId: string): void {
    this.selectSession(sessionId);
    if (!this.panelVisible) this.stage.showTask(sessionId);
  }

  /** Results are read in the main window; the orb stops following the task once it is opened there. */
  private openTask(sessionId: string): void {
    this.selectSession(null);
    this.options.openMain(sessionId);
  }

  private positionPanel(): void {
    if (!this.panel || this.panel.isDestroyed()) return;
    this.panel.setBounds(this.panelBounds());
  }

  private acceptHint(topic: CompanionHintTopic): void {
    const prompt = companionHintCopyKeys(topic, 0).prompt;
    if (prompt && !this.draft.prompt.trim()) {
      this.setDraft({ ...this.draft, prompt: t(prompt) });
    }
    this.showPanel();
  }

  private openPanelWithAttachments(attachments: DesktopCompanionAttachment[]): void {
    const files = [...new Map([...this.draft.attachments, ...attachments].map(file => [file.path, file])).values()].slice(0, 20);
    this.setDraft({ ...this.draft, attachments: files });
    this.showPanel();
  }

  private setDraft(value: unknown): void {
    this.draft = normalizeCompanionDraft(value);
    clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = setTimeout(() => this.flushDraft(), 300);
    this.publish();
  }

  private selectSession(value: unknown): void {
    this.sessionId = typeof value === 'string' ? value.slice(0, 200) : null;
    this.options.store.set(DesktopCompanionStoreKey.Session, this.sessionId);
    this.publish();
  }

  private flushDraft(): void {
    clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = undefined;
    this.options.store.set(DesktopCompanionStoreKey.Draft, this.draft);
  }

  // ── Stage & monitors ──────────────────────────────────────

  private showHint(topic: CompanionHintTopic, variant: number): boolean {
    if (!this.orb || this.orb.isDestroyed() || !this.orb.isVisible()) return false;
    return this.stage.showHint(topic, variant);
  }

  private onForegroundChange = (appId: string): void => {
    this.hints.onForegroundChange(appId);
    // Clicking a companion surface can activate LobsterAI itself. That must not
    // dismiss the toolbar mid-click or forget which app the user came from.
    const category = categorizeCompanionApp(appId);
    if (category === CompanionAppCategory.Self) return;
    const previous = this.foregroundAppId ? categorizeCompanionApp(this.foregroundAppId) : null;
    this.foregroundAppId = appId;
    this.selection.onForegroundChange();
    if (previous !== category) this.publish();
  };

  private onGlobalDragStart = (event: FileDragStart): void => {
    if (!this.isPresent() || !this.preferences.dragAssist || this.snooze) return;
    const files = describeDraggedPaths(event.paths);
    // macOS tells us what is being dragged; ignore apps, archives and other non-documents.
    if (files.length && !files.some(file => isCompanionDocumentKind(file.kind) || file.kind === FileKind.Folder)) return;
    this.fileDragActive = true;
    this.stage.showDrop(DesktopCompanionDropSource.Global, files);
    this.publish();
  };

  private onGlobalDragEnd = (): void => {
    if (!this.fileDragActive) return;
    this.fileDragActive = false;
    this.stage.releaseDrop(DesktopCompanionDropSource.Global);
    this.publish();
  };

  private onOrbFileDrag(phase: DesktopCompanionFileDragPhase, kinds: CompanionFileKind[]): void {
    if (!this.preferences.dragAssist) return;
    if (phase === DesktopCompanionFileDragPhase.Enter) {
      const known = Array.isArray(kinds) ? kinds.filter(kind => Object.values(FileKind).includes(kind)).slice(0, 8) : [];
      this.stage.showDrop(DesktopCompanionDropSource.Orb, [], known);
    } else if (phase === DesktopCompanionFileDragPhase.Leave) {
      this.stage.releaseDrop(DesktopCompanionDropSource.Orb);
    } else {
      this.stage.clear();
    }
  }

  // ── Shortcut, menu, IPC ───────────────────────────────────

  private registerShortcut(shortcut: string): boolean {
    if (shortcut === this.registeredShortcut) return true;
    if (shortcut && !/(?:^|\+)(?:CommandOrControl|Command|Cmd|Control|Ctrl|Alt|Option)\+/i.test(shortcut)) return false;
    try {
      if (shortcut && !globalShortcut.register(shortcut, () => this.togglePanel())) return false;
    } catch {
      return false;
    }
    if (this.registeredShortcut) globalShortcut.unregister(this.registeredShortcut);
    this.registeredShortcut = shortcut;
    return true;
  }

  private companionWindows(): Array<BrowserWindow | null> {
    return [this.orb, this.panel, this.stage.browserWindow, this.selection.browserWindow, this.languageTools.browserWindow];
  }

  private publish(): void {
    this.revision += 1;
    const state = this.getState();
    for (const win of [this.options.getMainWindow(), ...this.companionWindows()]) {
      if (win && !win.isDestroyed()) win.webContents.send(DesktopCompanionIpc.Changed, state);
    }
  }

  private assertSender(senderId: number): void {
    const allowed = [this.options.getMainWindow()?.webContents.id, this.orb?.webContents.id, this.panel?.webContents.id,
      this.stage.webContentsId, this.selection.webContentsId, this.languageTools.webContentsId];
    if (!allowed.some(id => id !== undefined && id !== null && id === senderId)) throw new Error('Unknown desktop companion IPC sender');
  }

  private showContextMenu(): void {
    const toggle = (label: string, key: 'selectionToolbar' | 'dragAssist' | 'contextHints'): MenuItemConstructorOptions => ({
      label, type: 'checkbox', checked: this.preferences[key], click: () => this.setPreferences({ [key]: !this.preferences[key] }),
    });
    const template: MenuItemConstructorOptions[] = [
      { label: t('desktopCompanionOpenPanel'), click: () => this.showPanel() },
      ...(isSpeechActive(this.languageTools.speechStatus) ? [
        { label: t('desktopToolsStop'), click: () => this.languageTools.command(SpeechCommand.Stop) },
      ] : []),
      { label: t('desktopCompanionOpenApp'), click: () => { this.hidePanel(); this.options.openMain(this.sessionId); } },
      { type: 'separator' },
      {
        label: t('desktopCompanionChangeSkin'),
        submenu: COMPANION_SKINS.map(skin => ({
          label: t(skin.nameKey), type: 'radio' as const, checked: this.preferences.skin === skin.id,
          click: () => this.setPreferences({ skin: skin.id }),
        })),
      },
      toggle(t('desktopCompanionSelection'), 'selectionToolbar'),
      toggle(t('desktopCompanionDragAssist'), 'dragAssist'),
      toggle(t('desktopCompanionHints'), 'contextHints'),
      { type: 'separator' },
      this.snooze
        ? { label: t('desktopCompanionWake'), click: () => this.wake() }
        : { label: t('desktopCompanionSnoozeToday'), click: () => this.snoozeFor(DesktopCompanionSnoozeMode.Quiet) },
      { label: t('desktopCompanionSnoozeHour'), click: () => this.snoozeFor(DesktopCompanionSnoozeMode.Hidden) },
      ...(this.options.openSettings ? [{ label: t('desktopCompanionSettings'), click: () => this.options.openSettings?.() }] : []),
      { type: 'separator' },
      { label: t('desktopCompanionDisable'), click: () => this.setPreferences({ enabled: false }) },
    ];
    Menu.buildFromTemplate(template).popup({ window: this.panelVisible ? this.panel ?? undefined : this.orb ?? undefined });
  }

  private registerIpc(): void {
    const handle = (channel: string, callback: (value: unknown, sender: Electron.WebContents) => unknown) => {
      ipcMain.handle(channel, (event, value: unknown) => {
        this.assertSender(event.sender.id);
        if (event.senderFrame !== event.sender.mainFrame) throw new Error('Desktop companion IPC requires the main frame');
        return callback(value, event.sender);
      });
    };
    handle(DesktopCompanionIpc.GetState, () => this.getState());
    handle(DesktopCompanionIpc.SetPreferences, value => this.setPreferences(value as Partial<DesktopCompanionPreferences>));
    handle(DesktopCompanionIpc.SetDraft, value => { this.setDraft(value); return this.getState(); });
    handle(DesktopCompanionIpc.SelectSession, value => { this.selectSession(value); return this.getState(); });
    handle(DesktopCompanionIpc.TaskStarted, (value, sender) => {
      if (!this.panel || this.panel.isDestroyed() || sender.id !== this.panel.webContents.id) return;
      if (typeof value !== 'string' || !value) return;
      this.hidePanel();
      this.followTask(value.slice(0, 200));
    });
    handle(DesktopCompanionIpc.TogglePanel, () => this.togglePanel());
    handle(DesktopCompanionIpc.HidePanel, () => this.hidePanel());
    handle(DesktopCompanionIpc.OpenMain, (value, sender) => {
      if (sender.id === this.selection.webContentsId) this.selection.hide();
      this.hidePanel();
      this.options.openMain(typeof value === 'string' ? value : null);
    });
    handle(DesktopCompanionIpc.ContextMenu, () => this.showContextMenu());
    handle(DesktopCompanionIpc.StageCommand, value => this.stage.handleCommand(value as DesktopCompanionStageCommand));
    handle(DesktopCompanionIpc.SelectionCommand, value => this.selection.handleCommand(value as DesktopCompanionSelectionCommand));
    handle(DesktopCompanionIpc.QuickAnswerStart, (value, sender) => this.quickAnswer.start(sender, value as CompanionQuickAnswerRequest));
    handle(DesktopCompanionIpc.QuickAnswerAbort, value => { if (typeof value === 'string') this.quickAnswer.abort(value); });
    handle(DesktopCompanionIpc.RequestPermission, value => {
      if (value === CompanionPermissionValue.Accessibility) this.selection.requestPermission();
      return this.getState();
    });
    handle(DesktopCompanionIpc.CopyText, value => { if (typeof value === 'string') clipboard.writeText(value.slice(0, 200_000)); });

    const on = (channel: string, callback: (value: unknown, senderId: number) => void) => {
      ipcMain.on(channel, (event, value: unknown) => {
        if (event.senderFrame !== event.sender.mainFrame) return;
        try { this.assertSender(event.sender.id); } catch { return; }
        callback(value, event.sender.id);
      });
    };
    on(DesktopCompanionIpc.Drag, (value, senderId) => {
      if (senderId !== this.orb?.webContents.id) return;
      if (Object.values(DesktopCompanionDragPhase).includes(value as DesktopCompanionDragPhase)) this.move(value as DesktopCompanionDragPhase);
    });
    on(DesktopCompanionIpc.TaskUpdated, (_value, senderId) => {
      if (senderId !== this.orb?.webContents.id) return;
      if (this.sessionId && !this.panelVisible) this.stage.showTask(this.sessionId);
    });
    on(DesktopCompanionIpc.PanelPassThrough, (value, senderId) => {
      if (!this.panel || this.panel.isDestroyed() || senderId !== this.panel.webContents.id) return;
      this.panel.setIgnoreMouseEvents(value === true, { forward: true });
    });
    on(DesktopCompanionIpc.OrbFileDrag, (value, senderId) => {
      if (senderId !== this.orb?.webContents.id) return;
      const payload = value as { phase?: DesktopCompanionFileDragPhase; kinds?: CompanionFileKind[] } | null;
      if (payload?.phase && Object.values(DesktopCompanionFileDragPhase).includes(payload.phase)) {
        this.onOrbFileDrag(payload.phase, payload.kinds ?? []);
      }
    });
    on(DesktopCompanionIpc.ResizeSurface, (value, senderId) => {
      const size = value as CompanionSurfaceSize | null;
      if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
      if (this.panel && !this.panel.isDestroyed() && senderId === this.panel.webContents.id) this.setPanelContentSize(size);
      else if (senderId === this.stage.webContentsId) this.stage.setContentSize(size);
      else if (senderId === this.selection.webContentsId) this.selection.setContentSize(size);
      else if (senderId === this.languageTools.webContentsId) this.languageTools.setContentSize(size);
    });
  }
}
