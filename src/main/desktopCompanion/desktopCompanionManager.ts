import { randomUUID } from 'crypto';
import {
  type BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  type Rectangle,
  screen,
  type WebContents,
} from 'electron';
import fs from 'fs';
import path from 'path';

import {
  CompanionAnalyticsAction as AnalyticsAction, CompanionAnalyticsInteraction as Interaction,
  CompanionAnalyticsOutcome as AnalyticsOutcome, CompanionAnalyticsSource as AnalyticsSource,
  CompanionAnalyticsTool, normalizeCompanionAnalyticsEvent,
} from '../../shared/desktopCompanion/analytics';
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
  DesktopCompanionMainPage,
  DesktopCompanionPanelPlacement,
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
  type CompanionComposerLayout,
  type CompanionPoint,
  companionStageOpensLeft,
  resolveCompanionBounds,
  resolveCompanionComposerLayout,
  resolveCompanionLoginLayout,
  snapCompanionOrbToEdge,
} from '../../shared/desktopCompanion/geometry';
import { companionHintCopyKeys, type CompanionHintTopic } from '../../shared/desktopCompanion/hintPolicy';
import { isSpeechActive, LanguageTool } from '../../shared/desktopCompanion/languageTools';
import type { CompanionTaskInfo } from '../../shared/desktopCompanion/results';
import { normalizeSelectionTaskContext } from '../../shared/desktopCompanion/selectionTaskContext';
import { normalizeCompanionToolbarOrder } from '../../shared/desktopCompanion/selectionToolbar';
import { COMPANION_SKINS, companionOrbSize, normalizeCompanionSkin } from '../../shared/desktopCompanion/skins';
import { t } from '../i18n';
import { CompanionAnalytics, type CompanionAnalyticsReporter } from './companionAnalytics';
import { copyCompanionText } from './companionClipboard';
import { CompanionHintsController } from './companionHints';
import { CompanionResultsController } from './companionResults';
import { CompanionScreenshotController } from './companionScreenshot';
import { CompanionSelectionController, type SelectionHookModule } from './companionSelection';
import { CompanionStageController } from './companionStage';
import { type CompanionWindowEnvironment, createCompanionWindow, dismissCompanionPanelOnBlur } from './companionWindow';
import { CompanionFileDragMonitor, FileDragEvent, type FileDragMonitor, type FileDragStart } from './fileDragMonitor';
import { CompanionFileDragProximity } from './fileDragProximity';
import { CompanionForegroundMonitor, type ForegroundAppMonitor } from './foregroundAppMonitor';
import type { CompanionLanguageClient } from './languageToolClient';
import { CompanionLanguageToolsController } from './languageToolsController';
import { CompanionQuickAnswerService } from './quickAnswerService';
import { getCompanionSelectionApps } from './selectionApps';

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
  getTaskInfo(sessionId: string): CompanionTaskInfo | null;
  openMain(sessionId?: string | null): void;
  openSettings?(): void;
  onPreferencesChanged(): void;
  reportAnalytics?: CompanionAnalyticsReporter;
  getAnalyticsOwner?: () => string | null;
  services?: DesktopCompanionServices;
}

export function normalizeCompanionPreferences(value: unknown): DesktopCompanionPreferences {
  const stored = (value && typeof value === 'object' ? value : {}) as Partial<DesktopCompanionPreferences>;
  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULT_DESKTOP_COMPANION_PREFERENCES.enabled,
    shortcut: typeof stored.shortcut === 'string' ? stored.shortcut : DEFAULT_DESKTOP_COMPANION_PREFERENCES.shortcut,
    skin: normalizeCompanionSkin(stored.skin),
    selectionToolbar: stored.selectionToolbar !== false,
    dragAssist: stored.dragAssist !== false,
    contextHints: stored.contextHints !== false,
    selectionToolbarOrder: normalizeCompanionToolbarOrder(stored.selectionToolbarOrder),
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
    selectionContext: normalizeSelectionTaskContext(draft?.selectionContext),
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
  private pendingMainPage: DesktopCompanionMainPage | null = null;
  private orb: BrowserWindow | null = null;
  private panel: BrowserWindow | null = null;
  private panelVisible = false;
  private panelShowRevision: number | null = null;
  private panelOpenRevision = 0;
  private panelJourneyId?: string;
  private orbPressVisible = false;
  private panelLoginVisible = false;
  /** Height of the composer card plus its shadow margin, as the panel last reported it. */
  private panelCardHeight: number = DesktopCompanionSize.PanelCompactHeight;
  private panelPlacement: DesktopCompanionPanelPlacement = DesktopCompanionPanelPlacement.Left;
  /** The display a panel opened without the orb stays on while it is open. */
  private panelWorkArea: Rectangle | null = null;
  private preferences: DesktopCompanionPreferences;
  private draft: DesktopCompanionDraft;
  private sessionId: string | null;
  private position: CompanionPoint | undefined;
  private snooze: DesktopCompanionSnooze | null;
  private revision = 0;
  private shortcutUnavailable = false;
  private registeredShortcut = '';
  private disposing = false;
  private capturing = false;
  private fileDragActive = false;
  private draggedFiles: DesktopCompanionDropFile[] = [];
  private foregroundAppId: string | null = null;
  private dragOrigin: { cursor: CompanionPoint; position: CompanionPoint } | null = null;
  private draftSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private snoozeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly env: CompanionWindowEnvironment;
  private readonly foreground: ForegroundAppMonitor;
  private readonly fileDrag: FileDragMonitor;
  private readonly dragProximity: CompanionFileDragProximity;
  private readonly quickAnswer: CompanionQuickAnswerService;
  private readonly stage: CompanionStageController;
  private readonly hints: CompanionHintsController;
  private readonly selection: CompanionSelectionController;
  private readonly languageTools: CompanionLanguageToolsController;
  private readonly screenshot: CompanionScreenshotController;
  private readonly results: CompanionResultsController;
  private readonly analytics: CompanionAnalytics;

  constructor(private readonly options: DesktopCompanionOptions) {
    this.analytics = new CompanionAnalytics(options.reportAnalytics, options.getAnalyticsOwner);
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
    this.screenshot = new CompanionScreenshotController(this.env);
    this.results = new CompanionResultsController({
      analytics: this.analytics,
      store,
      getTaskInfo: id => options.getTaskInfo(id),
      getOrbBounds: () => this.orbBounds(),
      createWindow: () => this.createWindow(DesktopCompanionSurface.Result, true),
      assertSender: id => this.assertSender(id),
      beforeOpen: () => { this.hidePanel(); this.stage.clear(); this.selection.hide(); },
      openMain: sessionId => this.options.openMain(sessionId),
      isCapturing: () => this.capturing,
      publish: () => this.publish(),
    }, this.sessionId);
    this.stage = new CompanionStageController({
      analytics: this.analytics,
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
    this.dragProximity = new CompanionFileDragProximity({
      getCursor: () => screen.getCursorScreenPoint(),
      getOrbBounds: () => this.orbBounds(),
      onEnter: () => this.stage.showDrop(DesktopCompanionDropSource.Orb, this.draggedFiles),
      onLeave: () => this.stage.releaseDrop(DesktopCompanionDropSource.Orb),
    });
    this.hints = new CompanionHintsController({
      store,
      isEnabled: () => this.preferences.enabled && this.preferences.contextHints && !this.snooze && !this.capturing,
      isQuiet: category => this.isBusy(category),
      showHint: (topic, variant) => this.showHint(topic, variant),
    });
    this.selection = new CompanionSelectionController({
      analytics: this.analytics,
      preferences: () => this.preferences,
      isAvailable: () => this.isPresent() && !this.capturing,
      createWindow: (surface, focusable) => this.createWindow(surface, focusable),
      setPreferences: patch => { this.setPreferences(patch, AnalyticsSource.Selection); },
      publish: () => this.publish(),
      openSettings: () => this.options.openSettings?.(),
    }, this.quickAnswer, services.loadSelectionHook);

    this.languageTools = new CompanionLanguageToolsController({
      analytics: this.analytics,
      createWindow: () => this.createWindow(DesktopCompanionSurface.LanguageTools, true),
      getSelectionAnchor: () => this.selection.selectionAnchor,
      getSelectionToolbarBounds: () => this.selection.selectionToolbarBounds,
      assertSender: id => this.assertSender(id),
      publish: () => this.publish(),
      hideSelection: () => this.selection.hide(),
      abortFollowUp: id => this.quickAnswer.abortOwnedBy(id),
      isCapturing: () => this.selection.capturing,
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

  isComposerWebContents(webContents: WebContents): boolean {
    return !!this.panel && !this.panel.isDestroyed() && this.panel.webContents === webContents;
  }

  getState(): DesktopCompanionState {
    const category = this.foregroundAppId ? categorizeCompanionApp(this.foregroundAppId) : null;
    return {
      result: this.results.state,
      revision: this.revision,
      speechStatus: this.languageTools.speechStatus,
      preferences: {
        ...this.preferences,
        selectionExcludedApps: [...this.preferences.selectionExcludedApps],
        selectionToolbarOrder: [...this.preferences.selectionToolbarOrder],
      },
      panelVisible: this.panelVisible,
      panelOpenRevision: this.panelOpenRevision,
      sessionId: this.sessionId,
      draft: { ...this.draft, attachments: [...this.draft.attachments] },
      shortcutUnavailable: this.shortcutUnavailable,
      snooze: this.snooze ? { ...this.snooze } : null,
      stage: this.stage.stage,
      stageSide: this.stageSide(),
      panelPlacement: this.panelPlacement,
      fileDragActive: this.fileDragActive,
      foreground: this.foregroundAppId && category ? { appId: this.foregroundAppId, category } : null,
      capabilities: {
        selection: this.selection.capability,
        foregroundApp: this.foreground.capability,
        globalDrag: this.fileDrag.capability,
      },
    };
  }

  setPreferences(patch: Partial<DesktopCompanionPreferences>, source: AnalyticsSource = AnalyticsSource.Settings): DesktopCompanionResult {
    const next = { ...this.preferences };
    if (typeof patch?.enabled === 'boolean') next.enabled = patch.enabled;
    if (typeof patch?.shortcut === 'string') next.shortcut = patch.shortcut.trim().slice(0, 100);
    if (typeof patch?.skin === 'string') next.skin = normalizeCompanionSkin(patch.skin);
    if (typeof patch?.selectionToolbar === 'boolean') next.selectionToolbar = patch.selectionToolbar;
    if (typeof patch?.dragAssist === 'boolean') next.dragAssist = patch.dragAssist;
    if (typeof patch?.contextHints === 'boolean') next.contextHints = patch.contextHints;
    if (Array.isArray(patch?.selectionToolbarOrder)) {
      next.selectionToolbarOrder = normalizeCompanionToolbarOrder(patch.selectionToolbarOrder);
    }
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
    const previousOrbSize = this.orbSize();
    const previous = this.preferences;
    this.preferences = next;
    this.resizeOrb(previousOrbSize);
    if (!next.enabled) this.languageTools.reset();
    this.options.store.set(DesktopCompanionStoreKey.Preferences, next);
    if (turningOn && this.snooze) this.wake(false);
    if (!next.contextHints && this.stage.stage.kind === DesktopCompanionStageKind.Hint) this.stage.clear();
    this.applyActivity();
    if (exclusionsChanged) this.selection.updateExclusions();
    this.publish();
    this.options.onPreferencesChanged();
    this.analytics.preferences(previous, next, source);
    return { success: true, state: this.getState() };
  }

  private toggleOrb(fromPointer: boolean): void {
    if (this.capturing) return;
    this.analytics.report({ action: AnalyticsAction.Action, source: AnalyticsSource.Orb, interactionType: Interaction.Click });
    const closeOnly = fromPointer && this.orbPressVisible;
    this.orbPressVisible = false;
    if (closeOnly || this.panelVisible || this.results.state.visible) {
      this.hidePanel();
      this.results.hide();
      return;
    }
    this.results.open();
    if (!this.results.state.visible) this.showPanel(AnalyticsSource.Orb);
  }

  togglePanel(source: AnalyticsSource = AnalyticsSource.Tray): void {
    if (this.capturing) return;
    if (this.panelVisible) this.hidePanel();
    else this.showPanel(source);
  }

  resetLanguageTools(): void { this.languageTools.reset(); this.clearTaskAnalytics(); }

  clearTaskAnalytics(): void { this.analytics.clearTasks(); this.panelJourneyId = undefined; }

  captureTaskAnalytics(senderId: number): ReturnType<CompanionAnalytics['captureTask']> { return this.analytics.captureTask(senderId); }

  hidePanel(): void {
    if (!this.panelVisible) return;
    this.panelVisible = false;
    this.panelShowRevision = null;
    this.panel?.hide();
    this.flushDraft();
    this.publish();
  }

  snoozeFor(mode: DesktopCompanionSnoozeMode): void {
    const now = Date.now();
    this.snooze = { mode, until: mode === DesktopCompanionSnoozeMode.Hidden ? now + DesktopCompanionTiming.SnoozeHourMs : endOfToday(now) };
    this.options.store.set(DesktopCompanionStoreKey.Snooze, this.snooze);
    this.analytics.report({ action: AnalyticsAction.Action, source: AnalyticsSource.ContextMenu,
      interactionType: Interaction.Pause, snoozeMode: mode });
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
    this.screenshot.dispose();
    this.flushDraft();
    if (this.registeredShortcut) globalShortcut.unregister(this.registeredShortcut);
    clearTimeout(this.snoozeTimer);
    screen.removeListener('display-removed', this.reposition);
    screen.removeListener('display-metrics-changed', this.reposition);
    for (const channel of [
      DesktopCompanionIpc.Drag, DesktopCompanionIpc.OrbFileDrag, DesktopCompanionIpc.ResizeSurface,
      DesktopCompanionIpc.TaskUpdated, DesktopCompanionIpc.PanelPassThrough, DesktopCompanionIpc.PanelLoginVisible,
    ]) ipcMain.removeAllListeners(channel);
    for (const channel of Object.values(DesktopCompanionIpc)) ipcMain.removeHandler(channel);
    this.foreground.removeListener('change', this.onForegroundChange);
    this.fileDrag.removeListener(FileDragEvent.Start, this.onGlobalDragStart);
    this.fileDrag.removeListener(FileDragEvent.End, this.onGlobalDragEnd);
    this.dragProximity.stop();
    this.foreground.stop();
    this.fileDrag.stop();
    this.hints.dispose();
    this.selection.dispose();
    this.stage.dispose();
    this.quickAnswer.dispose();
    this.languageTools.dispose();
    this.results.dispose();
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
    return this.preferences.enabled && !this.snooze;
  }

  private isBusy(category: CompanionAppCategory): boolean {
    return this.panelVisible
      || this.results.state.visible
      || this.stage.stage.kind !== DesktopCompanionStageKind.None
      || this.fileDragActive
      || isCompanionQuietCategory(category)
      || this.foreground.isUserBusy();
  }

  /** Reconciles windows and system monitors with preferences and snooze. */
  private applyActivity(): void {
    if (this.disposing || this.capturing) return;
    const present = this.isPresent();
    if (present) this.showOrb();
    else this.hideOrb();
    if (present) this.foreground.start();
    else this.foreground.stop();
    if (present && this.preferences.dragAssist && !this.snooze) this.fileDrag.start();
    else {
      this.fileDrag.stop();
      this.dragProximity.stop();
      this.fileDragActive = false;
      this.draggedFiles = [];
      if (this.stage.stage.kind === DesktopCompanionStageKind.Drop) this.stage.clear();
    }
    if (!present || this.snooze) { this.stage.clear(); this.results.hide(); }
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
    return resolveCompanionBounds(point, display.workArea, this.orbSize());
  }

  private orbSize(): { width: number; height: number } {
    return companionOrbSize(this.preferences.skin);
  }

  /** A skin with a different window size keeps the orb centered where it was. */
  private resizeOrb(previous: { width: number; height: number }): void {
    const size = this.orbSize();
    if (size.width === previous.width && size.height === previous.height) return;
    if (this.position && Number.isFinite(this.position.x) && Number.isFinite(this.position.y)) {
      this.savePosition({
        x: Math.round(this.position.x + (previous.width - size.width) / 2),
        y: Math.round(this.position.y + (previous.height - size.height) / 2),
      });
    }
    if (this.orb && !this.orb.isDestroyed()) this.reposition();
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
        const wasVisible = win.isVisible();
        win.showInactive();
        if (!wasVisible) this.analytics.report({ action: AnalyticsAction.Action, source: AnalyticsSource.System,
          interactionType: Interaction.Open, surface: DesktopCompanionSurface.Mascot, skin: this.preferences.skin });
        this.hints.scheduleWelcome();
      });
      this.orb = win;
    } else if (!this.orb.webContents.isLoadingMainFrame() && !this.orb.isVisible()) {
      this.orb.showInactive();
      this.analytics.report({ action: AnalyticsAction.Action, source: AnalyticsSource.System,
        interactionType: Interaction.Open, surface: DesktopCompanionSurface.Mascot, skin: this.preferences.skin });
    }
  }

  private hideOrb(): void {
    if (this.orb && !this.orb.isDestroyed()) this.orb.destroy();
    this.orb = null;
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
      // Capture before blur can hide the surface, using main-process state even during rapid clicks.
      this.orbPressVisible = this.panelVisible || this.results.state.visible;
      const start = this.orbBounds() ?? this.orb.getBounds();
      this.dragOrigin = { cursor, position: { x: start.x, y: start.y } };
      return;
    }
    if (!this.dragOrigin) return;
    const workArea = screen.getDisplayNearestPoint(cursor).workArea;
    const moved = clampCompanionBounds({
      ...this.orbSize(),
      x: this.dragOrigin.position.x + cursor.x - this.dragOrigin.cursor.x,
      y: this.dragOrigin.position.y + cursor.y - this.dragOrigin.cursor.y,
    }, workArea);
    // Follow the pointer freely; settle near the left or right edge only after release.
    const settled = phase === DesktopCompanionDragPhase.End ? snapCompanionOrbToEdge(moved, workArea) : moved;
    this.orb.setBounds(settled, settled.x !== moved.x);
    if (phase === DesktopCompanionDragPhase.End) {
      this.dragOrigin = null;
      this.savePosition(settled);
      this.publish();
    } else {
      this.position = { x: moved.x, y: moved.y };
    }
    this.stage.reposition();
    this.positionPanel();
    this.results.reposition();
  }

  private reposition = (): void => {
    if (this.orb && !this.orb.isDestroyed()) {
      const bounds = this.defaultOrbBounds();
      this.orb.setBounds(bounds);
      this.savePosition(bounds);
    }
    if (this.panelWorkArea && this.panel && !this.panel.isDestroyed()) {
      this.panelWorkArea = screen.getDisplayMatching(this.panel.getBounds()).workArea;
    }
    this.stage.reposition();
    this.positionPanel();
    this.results.reposition();
    this.publish();
  };

  // ── Panel ─────────────────────────────────────────────────

  private showPanel(source: AnalyticsSource = AnalyticsSource.System): void {
    const opening = !this.panelVisible || !this.panel || this.panel.isDestroyed();
    if (opening) this.panelJourneyId = randomUUID();
    this.results.hide();
    const stageKind = this.stage.stage.kind;
    if (stageKind === DesktopCompanionStageKind.Hint || stageKind === DesktopCompanionStageKind.Task) this.stage.clear();
    if (!this.panelVisible) {
      this.analytics.report({ action: AnalyticsAction.Action, source, interactionType: Interaction.Open,
        surface: DesktopCompanionSurface.Panel, enabled: this.preferences.enabled, journeyId: this.panelJourneyId });
      // Without the orb, the panel opens on the display in use and stays there while it is open.
      this.panelWorkArea = this.orbBounds() ? null : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    }
    if (!this.panel || this.panel.isDestroyed()) {
      this.panelLoginVisible = false;
      const win = this.createWindow(DesktopCompanionSurface.Panel, true, this.panelLayout().bounds);
      dismissCompanionPanelOnBlur(win, () => this.hidePanel());
      win.on('close', event => {
        if (this.disposing) return;
        event.preventDefault();
        this.hidePanel();
      });
      // A native hide notification can arrive after a rapid reopen.
      win.on('hide', () => { if (!win.isVisible() && this.panelShowRevision === null) this.hidePanel(); });
      win.on('closed', () => {
        if (this.panel !== win) return;
        this.panel = null;
        this.panelLoginVisible = false;
        this.panelShowRevision = null;
      });
      this.panel = win;
    }
    if (opening) {
      this.panelOpenRevision = this.revision + 1;
      this.panelShowRevision = this.panelOpenRevision;
    }
    this.panelVisible = true;
    // Clicks go through the empty room above the card only while the pointer is there.
    this.panel.setIgnoreMouseEvents(false);
    this.positionPanel();
    // The renderer prepares each opening before showing the window. Showing here
    // would expose the previous frame before the new fade-in starts.
    if (this.panel.isVisible()) this.panel.focus();
    this.publish();
  }

  private panelLayout(): CompanionComposerLayout {
    // Opens like the hint bubbles, beside the character. A shortcut pressed while the orb
    // is off or hidden has nothing to point at, so the card opens a little below mid-screen.
    const orb = this.orbBounds();
    const workArea = orb
      ? screen.getDisplayMatching(orb).workArea
      : this.panelWorkArea ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    if (this.panelLoginVisible) {
      return resolveCompanionLoginLayout(orb, workArea);
    }
    const card = { width: DesktopCompanionSize.Composer.width + DesktopCompanionSize.SurfacePad * 2, height: this.panelCardHeight };
    const room = { above: DesktopCompanionSize.ComposerMenuRoom, side: DesktopCompanionSize.ComposerSideRoom };
    return resolveCompanionComposerLayout(orb, card, room, workArea);
  }

  /** The panel reports its card size as the prompt grows. */
  private setPanelContentSize(size: CompanionSurfaceSize): void {
    const pad = DesktopCompanionSize.SurfacePad;
    const height = Math.max(pad * 4, Math.min(Math.ceil(size.height), DesktopCompanionSize.Composer.maxHeight + pad * 2));
    if (height === this.panelCardHeight) return;
    this.panelCardHeight = height;
    this.positionPanel();
  }

  /** Follow the task and show compact activity beside the pet. */
  private followTask(sessionId: string): void {
    this.results.record(sessionId);
    this.selectSession(sessionId);
    this.showTaskActivity();
  }

  markSessionViewed(sessionId: string): void { this.results.markSessionViewed(sessionId); }

  private showTaskActivity(): void {
    if (!this.isPresent() || this.snooze || this.capturing || this.panelVisible || this.stage.stage.kind === DesktopCompanionStageKind.Drop
      || this.selection.browserWindow?.isVisible() || this.languageTools.browserWindow?.isVisible()) return;
    this.results.notify();
  }

  /** The status strip opens the corresponding task in the main window. */
  private openTask(sessionId: string): void {
    this.results.open(sessionId);
  }

  private positionPanel(): void {
    if (!this.panel || this.panel.isDestroyed()) return;
    const { bounds, placement } = this.panelLayout();
    this.panel.setBounds(bounds);
    if (placement === this.panelPlacement) return;
    // The card moves to the other side of its window, and its corner points the other way.
    this.panelPlacement = placement;
    this.publish();
  }

  private acceptHint(topic: CompanionHintTopic): void {
    const prompt = companionHintCopyKeys(topic, 0).prompt;
    if (prompt && !this.draft.prompt.trim()) {
      this.setDraft({ ...this.draft, prompt: t(prompt) });
    }
    this.showPanel(AnalyticsSource.Hint);
  }

  private openPanelWithAttachments(attachments: DesktopCompanionAttachment[], source: AnalyticsSource = AnalyticsSource.FileDrop): void {
    const files = [...new Map([...this.draft.attachments, ...attachments].map(file => [file.path, file])).values()].slice(0, 20);
    this.setDraft({ ...this.draft, attachments: files });
    this.showPanel(source);
  }

  private async askScreenshot(): Promise<void> {
    if (this.capturing || this.disposing) return;
    if (this.draft.attachments.length >= 20) {
      await dialog.showMessageBox({ type: 'info', message: t('desktopCompanionScreenshotFull') });
      return;
    }
    const finish = this.analytics.tool({ source: AnalyticsSource.ContextMenu, tool: CompanionAnalyticsTool.Screenshot });
    this.capturing = true;
    const restorePanel = this.panelVisible;
    this.hidePanel();
    this.stage.clear();
    this.fileDrag.stop();
    this.dragProximity.stop();
    this.selection.sync();
    let attachment: DesktopCompanionAttachment | null = null;
    let failed = false;
    try {
      attachment = await this.screenshot.capture(this.companionWindows());
    } catch (error) {
      failed = true;
      console.error('[DesktopCompanion] Screenshot failed', error);
    } finally {
      finish(failed ? AnalyticsOutcome.Failed : attachment ? AnalyticsOutcome.Success : AnalyticsOutcome.Cancelled);
      this.capturing = false;
      if (!this.disposing) {
        this.applyActivity();
        if (attachment) this.openPanelWithAttachments([attachment], AnalyticsSource.ContextMenu);
        else if (restorePanel) this.showPanel();
      }
    }
    if (failed && !this.disposing) {
      await dialog.showMessageBox({ type: 'error', message: t('desktopCompanionScreenshotFailed') });
    }
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
    this.selection.onForegroundChange(appId);
    if (previous !== category) this.publish();
  };

  private onGlobalDragStart = (event: FileDragStart): void => {
    if (!this.isPresent() || !this.preferences.dragAssist || this.snooze || this.capturing) return;
    const files = describeDraggedPaths(event.paths);
    // macOS tells us what is being dragged; ignore apps, archives and other non-documents.
    if (files.length && !files.some(file => isCompanionDocumentKind(file.kind) || file.kind === FileKind.Folder)) return;
    this.fileDragActive = true;
    // Keep file metadata for an intentional hover; ordinary desktop drags stay quiet.
    this.draggedFiles = files;
    this.dragProximity.start();
    this.publish();
  };

  private onGlobalDragEnd = (): void => {
    if (!this.fileDragActive) return;
    this.fileDragActive = false;
    this.draggedFiles = [];
    this.dragProximity.stop();
    this.stage.releaseDrop();
    this.publish();
  };

  private onOrbFileDrag(phase: DesktopCompanionFileDragPhase, kinds: CompanionFileKind[]): void {
    if (!this.isPresent() || !this.preferences.dragAssist || this.snooze || this.capturing) return;
    if (phase === DesktopCompanionFileDragPhase.Enter) {
      const known = Array.isArray(kinds) ? kinds.filter(kind => Object.values(FileKind).includes(kind)).slice(0, 8) : [];
      this.stage.showDrop(DesktopCompanionDropSource.Orb, this.draggedFiles, known);
    } else if (phase === DesktopCompanionFileDragPhase.Leave) {
      if (!this.dragProximity.isActive) this.stage.releaseDrop(DesktopCompanionDropSource.Orb);
    } else {
      this.stage.clear();
    }
  }

  // ── Shortcut, menu, IPC ───────────────────────────────────

  private registerShortcut(shortcut: string): boolean {
    if (shortcut === this.registeredShortcut) return true;
    if (shortcut && !/(?:^|\+)(?:CommandOrControl|Command|Cmd|Control|Ctrl|Alt|Option)\+/i.test(shortcut)) return false;
    try {
      if (shortcut && !globalShortcut.register(shortcut, () => this.togglePanel(AnalyticsSource.Shortcut))) return false;
    } catch {
      return false;
    }
    if (this.registeredShortcut) globalShortcut.unregister(this.registeredShortcut);
    this.registeredShortcut = shortcut;
    return true;
  }

  private companionWindows(): Array<BrowserWindow | null> {
    return [this.orb, this.panel, this.stage.browserWindow, this.selection.browserWindow, this.languageTools.browserWindow, this.results.browserWindow];
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
      this.stage.webContentsId, this.selection.webContentsId, this.languageTools.webContentsId, this.results.webContentsId];
    if (!allowed.some(id => id !== undefined && id !== null && id === senderId)) throw new Error('Unknown desktop companion IPC sender');
  }

  private showContextMenu(): void {
    this.analytics.report({ action: AnalyticsAction.Action, source: AnalyticsSource.Orb, interactionType: Interaction.ContextMenu });
    const template: MenuItemConstructorOptions[] = [
      { label: t('desktopCompanionOpenApp'), click: () => {
        this.analytics.report({ action: AnalyticsAction.Action, source: AnalyticsSource.ContextMenu, interactionType: Interaction.OpenMain, hasSession: !!this.sessionId });
        this.hidePanel(); this.options.openMain(this.sessionId);
      } },
      { label: t('desktopCompanionOpenPanel'), click: () => this.showPanel(AnalyticsSource.ContextMenu) },
      ...(isSpeechActive(this.languageTools.speechStatus)
        ? [{ label: t('desktopToolsPlayback'), click: () => this.languageTools.open({ tool: LanguageTool.Tts }) }]
        : []),
      { type: 'separator' },
      { label: t('desktopCompanionScreenshot'), click: () => this.askScreenshot() },
      {
        label: t('desktopCompanionChangeSkin'),
        submenu: COMPANION_SKINS.map(skin => ({
          label: t(skin.nameKey), type: 'radio' as const, checked: this.preferences.skin === skin.id,
          click: () => this.setPreferences({ skin: skin.id }, AnalyticsSource.ContextMenu),
        })),
      },
      { type: 'separator' },
      this.snooze
        ? { label: t('desktopCompanionWake'), click: () => this.wake() }
        : { label: t('desktopCompanionSnoozeToday'), click: () => this.snoozeFor(DesktopCompanionSnoozeMode.Quiet) },
      ...(this.options.openSettings ? [{ label: t('desktopCompanionSettings'), click: () => {
        this.analytics.report({ action: AnalyticsAction.Action, source: AnalyticsSource.ContextMenu, interactionType: Interaction.OpenSettings });
        this.options.openSettings?.();
      } }] : []),
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
    handle(DesktopCompanionIpc.ReportAnalytics, (value, sender) => {
      const event = normalizeCompanionAnalyticsEvent(value);
      if (!event) return;
      const source = this.analyticsSource(sender.id);
      // Renderer-owned task/drop interactions only; native events have one owner.
      if (event.action === AnalyticsAction.Task && [AnalyticsSource.Panel, AnalyticsSource.FileDrop, AnalyticsSource.Result].some(item => item === source)) {
        this.analytics.task(event, sender.id, source,
          source === AnalyticsSource.Panel ? this.panelJourneyId : undefined);
      } else if (event.action === AnalyticsAction.FileDrop && source === AnalyticsSource.FileDrop) {
        this.analytics.report({ ...event, source });
      } else if (event.action === AnalyticsAction.Action && event.interactionType === Interaction.Stop && source === AnalyticsSource.Result) {
        this.analytics.report({ ...event, source });
      }
    });
    handle(DesktopCompanionIpc.GetState, () => this.getState());
    handle(DesktopCompanionIpc.SetPreferences, (value, sender) => this.setPreferences(value as Partial<DesktopCompanionPreferences>, this.analyticsSource(sender.id)));
    handle(DesktopCompanionIpc.GetSelectionExcludedApps, () => getCompanionSelectionApps(this.preferences.selectionExcludedApps));
    handle(DesktopCompanionIpc.SetDraft, value => { this.setDraft(value); return this.getState(); });
    handle(DesktopCompanionIpc.SelectSession, value => { this.selectSession(value); return this.getState(); });
    handle(DesktopCompanionIpc.TaskStarted, (value, sender) => {
      if (sender.id !== this.panel?.webContents.id) return;
      if (typeof value !== 'string' || !value) return;
      this.hidePanel();
      this.followTask(value.slice(0, 200));
    });
    handle(DesktopCompanionIpc.ToggleOrb, value => this.toggleOrb(value === true));
    handle(DesktopCompanionIpc.TogglePanel, (_value, sender) => this.togglePanel(this.analyticsSource(sender.id)));
    handle(DesktopCompanionIpc.HidePanel, () => this.hidePanel());
    handle(DesktopCompanionIpc.PanelReady, (value, sender) => {
      const win = this.panel;
      if (!win || win.isDestroyed() || this.disposing || sender.id !== win.webContents.id || !this.panelVisible
        || value !== this.panelOpenRevision) return false;
      // A renderer remount may prepare the same opening again; do not show or focus twice.
      if (this.panelShowRevision === null) return win.isVisible();
      this.panelShowRevision = null;
      win.show();
      win.focus();
      return true;
    });
    handle(DesktopCompanionIpc.OpenMain, (value, sender) => {
      this.analytics.report({ action: AnalyticsAction.Action, source: this.analyticsSource(sender.id), interactionType: Interaction.OpenMain, hasSession: typeof value === 'string' && !!value });
      if (sender.id === this.selection.webContentsId) this.selection.hide();
      if (sender.id === this.results.webContentsId) this.results.hide();
      this.hidePanel();
      this.options.openMain(typeof value === 'string' ? value : null);
    });
    handle(DesktopCompanionIpc.OpenMainPage, (value, sender) => {
      if (value !== DesktopCompanionMainPage.Kits && value !== DesktopCompanionMainPage.Skills) return;
      this.analytics.report({ action: AnalyticsAction.Action, source: this.analyticsSource(sender.id),
        interactionType: value === DesktopCompanionMainPage.Kits ? Interaction.OpenKits : Interaction.OpenSkills });
      // Keep the destination until the main renderer is ready, including window recreation.
      this.pendingMainPage = value;
      this.hidePanel();
      this.options.openMain(null);
      const main = this.options.getMainWindow();
      if (main && !main.isDestroyed()) main.webContents.send(DesktopCompanionIpc.MainPageRequested);
    });
    handle(DesktopCompanionIpc.ConsumeMainPage, (_value, sender) => {
      if (sender.id !== this.options.getMainWindow()?.webContents.id) return null;
      const page = this.pendingMainPage;
      this.pendingMainPage = null;
      return page;
    });
    handle(DesktopCompanionIpc.ContextMenu, () => this.showContextMenu());
    handle(DesktopCompanionIpc.StageCommand, value => this.stage.handleCommand(value as DesktopCompanionStageCommand));
    handle(DesktopCompanionIpc.SelectionCommand, value => this.selection.handleCommand(value as DesktopCompanionSelectionCommand));
    handle(DesktopCompanionIpc.QuickAnswerStart, (value, sender) => this.quickAnswer.start(sender, value as CompanionQuickAnswerRequest, this.analyticsSource(sender.id)));
    handle(DesktopCompanionIpc.QuickAnswerAbort, value => { if (typeof value === 'string') this.quickAnswer.abort(value); });
    handle(DesktopCompanionIpc.RequestPermission, value => {
      if (value === CompanionPermissionValue.Accessibility) {
        this.analytics.report({ action: AnalyticsAction.Action, source: AnalyticsSource.Settings, interactionType: Interaction.Permission });
        this.selection.requestPermission();
      }
      return this.getState();
    });
    handle(DesktopCompanionIpc.CopyText, (value, sender) => {
      const result = copyCompanionText(value);
      this.analytics.report({ action: AnalyticsAction.Action, source: this.analyticsSource(sender.id), interactionType: Interaction.Copy,
        outcome: result.success ? AnalyticsOutcome.Success : AnalyticsOutcome.Failed });
      return result;
    });

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
      if (this.sessionId) this.showTaskActivity();
    });
    on(DesktopCompanionIpc.PanelPassThrough, (value, senderId) => {
      if (!this.panel || this.panel.isDestroyed() || senderId !== this.panel.webContents.id) return;
      this.panel.setIgnoreMouseEvents(value === true, { forward: true });
    });
    on(DesktopCompanionIpc.PanelLoginVisible, (value, senderId) => {
      if (!this.panel || this.panel.isDestroyed() || senderId !== this.panel.webContents.id || typeof value !== 'boolean') return;
      if (this.panelLoginVisible === value) return;
      if (value) this.analytics.report({ action: AnalyticsAction.Action, source: AnalyticsSource.Panel, interactionType: Interaction.LoginShown });
      this.panelLoginVisible = value;
      this.positionPanel();
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
      else if (senderId === this.results.webContentsId) this.results.setContentSize(size);
    });
  }

  private analyticsSource(senderId: number): AnalyticsSource {
    if (senderId === this.orb?.webContents.id) return AnalyticsSource.Orb;
    if (senderId === this.panel?.webContents.id) return AnalyticsSource.Panel;
    if (senderId === this.stage.webContentsId) return AnalyticsSource.FileDrop;
    if (senderId === this.selection.webContentsId) return AnalyticsSource.Selection;
    if (senderId === this.languageTools.webContentsId) return AnalyticsSource.LanguageTools;
    if (senderId === this.results.webContentsId) return AnalyticsSource.Result;
    return AnalyticsSource.Settings;
  }
}
