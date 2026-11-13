import { BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, type MenuItemConstructorOptions, screen, systemPreferences } from 'electron';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { CoworkSessionStatusValue } from '../../renderer/types/cowork';
import { CompanionAnalyticsAction as AnalyticsAction, CompanionAnalyticsInteraction as Interaction,
  CompanionAnalyticsSetting,
  CompanionAnalyticsSource as AnalyticsSource, CompanionAnalyticsStage as AnalyticsStage } from '../../shared/desktopCompanion/analytics';
import {
  COMPANION_COPY_MAX_BYTES,
  CompanionCapability,
  CompanionPermission,
  DEFAULT_COMPANION_SKIN,
  DEFAULT_DESKTOP_COMPANION_PREFERENCES,
  DesktopCompanionDragPhase,
  DesktopCompanionFileDragPhase,
  DesktopCompanionIpc,
  DesktopCompanionMainPage,
  DesktopCompanionPanelPlacement,
  DesktopCompanionSelectionCommandType,
  DesktopCompanionSelectionMode,
  DesktopCompanionSize,
  DesktopCompanionSnoozeMode,
  DesktopCompanionStageCommandType,
  DesktopCompanionStageKind,
  DesktopCompanionStoreKey,
  DesktopCompanionSurface,
  DesktopCompanionTiming,
} from '../../shared/desktopCompanion/constants';
import { CompanionContextMenuIpc, CompanionContextMenuSize } from '../../shared/desktopCompanion/contextMenu';
import { CompanionFileKind } from '../../shared/desktopCompanion/fileKinds';
import { CompanionHintRule } from '../../shared/desktopCompanion/hintPolicy';
import { LanguageTool, LanguageToolCode, LanguageToolsIpc, SpeechCommand, SpeechStatus, TranslationTarget } from '../../shared/desktopCompanion/languageTools';
import { CompanionLauncherAction } from '../../shared/desktopCompanion/launcher';
import {
  COMPANION_PERMISSION_GUIDE_SIZE,
  COMPANION_PERMISSION_INTRO_SIZE,
  CompanionPermissionGuideIpc,
} from '../../shared/desktopCompanion/permissionGuide';
import { COMPANION_RECENT_TASK_LIMIT, COMPANION_RECENT_TASKS_KEY, CompanionResultIpc, type CompanionTaskInfo } from '../../shared/desktopCompanion/results';
import { CompanionSelectionAction } from '../../shared/desktopCompanion/selectionActions';
import { CompanionToolbarItem, DEFAULT_COMPANION_TOOLBAR_ORDER } from '../../shared/desktopCompanion/selectionToolbar';
import { OpenClawEnginePhase } from '../../shared/openclawEngine/constants';
import { CompanionScreenPermissionError, CompanionScreenshotController } from './companionScreenshot';
import { CompanionSelectionController, type SelectionHookModule } from './companionSelection';
import { DesktopCompanionManager } from './desktopCompanionManager';
import { FileDragEvent } from './fileDragMonitor';
import type { CompanionLanguageClient } from './languageToolClient';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: any, value?: unknown) => any>(),
  windows: [] as any[],
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    id = mocks.windows.length + 1;
    destroyed = false;
    visible = false;
    focusable = true;
    focused = false;
    enabled = true;
    ignoreMouse = false;
    surface: string | undefined;
    bounds: any;
    webContents = Object.assign(new EventEmitter(), {
      id: this.id,
      mainFrame: {},
      send: vi.fn(),
      isDestroyed: () => this.destroyed,
      isLoadingMainFrame: () => false,
      setWindowOpenHandler: vi.fn(),
    });
    constructor(options: any = {}) { super(); this.bounds = options; mocks.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isFocused() { return this.focused; }
    isEnabled() { return this.enabled; }
    getChildWindows() { return []; }
    getBounds() { return this.bounds; }
    setBounds(value: any) { this.bounds = value; }
    setFocusable(value: boolean) { this.focusable = value; }
    setIgnoreMouseEvents(value: boolean) { this.ignoreMouse = value; }
    setOpacity() {}
    show() { if (!this.visible) { this.visible = true; this.emit('show'); } }
    showInactive() { this.show(); }
    hide() { this.visible = false; this.focused = false; this.emit('hide'); }
    focus() { this.focused = true; this.emit('focus'); }
    blur() { this.focused = false; this.emit('blur'); }
    setMenu() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    loadURL() { return Promise.resolve(); }
    loadFile(_file: string, options?: { query?: { surface?: string } }) { this.surface = options?.query?.surface; return Promise.resolve(); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const workArea = { x: 0, y: 0, width: 1280, height: 900 };
  return {
    app: Object.assign(new EventEmitter(), {
      getName: () => 'LobsterAI',
      getPath: () => '/Applications/LobsterAI.app/Contents/MacOS/LobsterAI',
    }),
    BrowserWindow: Window,
    ipcMain: Object.assign(new EventEmitter(), {
      handle: (channel: string, handler: any) => mocks.handlers.set(channel, handler),
      removeHandler: (channel: string) => mocks.handlers.delete(channel),
    }),
    globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
    screen: Object.assign(new EventEmitter(), {
      getCursorScreenPoint: () => ({ x: 100, y: 100 }),
      getDisplayNearestPoint: () => ({ workArea }),
      getDisplayMatching: () => ({ workArea }),
      screenToDipPoint: (point: unknown) => point,
    }),
    Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
    dialog: {
      showMessageBox: vi.fn(async () => ({ response: 0 })),
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
    },
    clipboard: { writeText: vi.fn() },
    shell: { openExternal: vi.fn(() => Promise.resolve()) },
    systemPreferences: { isTrustedAccessibilityClient: vi.fn(() => true), getMediaAccessStatus: vi.fn(() => 'granted') },
    nativeImage: { createFromDataURL: vi.fn() },
  };
});
vi.mock('../i18n', () => ({ t: (key: string) => key, getLanguage: () => 'zh' }));
vi.mock('./quickAnswerService', () => ({
  CompanionQuickAnswerService: class {
    start = vi.fn(() => ({ success: true }));
    abort = vi.fn();
    abortOwnedBy = vi.fn();
    dispose = vi.fn();
  },
}));

class FakeMonitor extends EventEmitter {
  capability: string = CompanionCapability.Ready;
  currentAppId = null;
  start = vi.fn();
  stop = vi.fn();
  isUserBusy = () => false;
}

class FakeSelectionHook extends EventEmitter {
  static FilterMode = { EXCLUDE_LIST: 2 };
  static PositionLevel = { SEL_FULL: 3 };
  static last: FakeSelectionHook | null = null;
  constructor() { super(); FakeSelectionHook.last = this; }
  start() { return true; }
  stop() { return true; }
  cleanup() {}
  setGlobalFilterMode() { return true; }
  getCurrentSelection() { return null; }
}

let manager: DesktopCompanionManager;
let main: BrowserWindow;
let values: Map<string, unknown>;
let openMain: ReturnType<typeof vi.fn>;
let openSettings: ReturnType<typeof vi.fn>;
let foreground: FakeMonitor;
let fileDrag: FakeMonitor;
let getTaskInfo: ReturnType<typeof vi.fn<(id: string) => CompanionTaskInfo | null>>;
let reportAnalytics: ReturnType<typeof vi.fn>;
let guideOpenSettings: ReturnType<typeof vi.fn>;
let requestScreenAccess: ReturnType<typeof vi.fn>;

function create(languageClient?: CompanionLanguageClient, enginePhase: OpenClawEnginePhase = OpenClawEnginePhase.Running,
  loadSelectionHook: () => SelectionHookModule | null = () => null) {
  reportAnalytics = vi.fn();
  guideOpenSettings = vi.fn(() => Promise.resolve());
  requestScreenAccess = vi.fn();
  main = new BrowserWindow();
  openMain = vi.fn();
  openSettings = vi.fn();
  foreground = new FakeMonitor();
  fileDrag = new FakeMonitor();
  getTaskInfo = vi.fn(id => ({ id, title: `Task ${id}`, status: 'completed', updatedAt: 1000 }));
  manager = new DesktopCompanionManager({
    enginePhase,
    reportAnalytics,
    store: {
      get: <T>(key: string) => values.get(key) as T | undefined,
      set: (key, value) => { values.set(key, value); },
    },
    preloadPath: '/preload.js',
    rendererDirectory: '/dist',
    getMainWindow: () => main,
    getTaskInfo,
    onPreferencesChanged: vi.fn(),
    openMain,
    openSettings,
    services: {
      foreground: foreground as any, fileDrag: fileDrag as any, loadSelectionHook, languageClient, requestScreenAccess,
      permissionGuide: {
        openSettings: guideOpenSettings, locateAppWindow: async () => ({ x: 400, y: 143, width: 715, height: 625 }),
        loadApp: async () => null, focusedWindow: () => null, onAppTerminated: () => () => undefined,
      },
    },
  });
}

function invoke(channel: string, value?: unknown, sender = main.webContents) {
  return mocks.handlers.get(channel)!({ sender, senderFrame: sender.mainFrame }, value);
}

/** The orb is the first companion window created after the main window. */
function orb() {
  return mocks.windows[1];
}

function emitDrag(phase: DesktopCompanionDragPhase, grab?: { x: number; y: number }) {
  ipcMain.emit(DesktopCompanionIpc.Drag, { sender: orb().webContents, senderFrame: orb().webContents.mainFrame }, { phase, grab });
}

function dragOverOrb(phase: DesktopCompanionFileDragPhase, kinds: CompanionFileKind[] = []) {
  ipcMain.emit(DesktopCompanionIpc.OrbFileDrag,
    { sender: orb().webContents, senderFrame: orb().webContents.mainFrame }, { phase, kinds });
}

/** The native menu other platforms pop up; macOS draws the same entries in a window of its own. */
function menu(): MenuItemConstructorOptions[] {
  const platform = vi.spyOn(process, 'platform', 'get');
  // Build the native menu while preserving the test's platform for its actions.
  platform.withImplementation(() => 'linux', () => {
    invoke(DesktopCompanionIpc.ContextMenu);
  });
  return vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)![0];
}

function clickMenu(label: string) {
  return menu().find(item => item.label === label)!.click!(null as never, undefined, {} as never);
}

function hoverOrb(hovering: boolean, sender = orb().webContents) {
  ipcMain.emit(DesktopCompanionIpc.OrbHover, { sender, senderFrame: sender.mainFrame }, hovering);
}

function stageWindow() {
  return mocks.windows.find(win => win.surface === DesktopCompanionSurface.Stage && !win.destroyed);
}

/** A fresh visit: the pointer arrives on the orb and stays as long as its launcher takes to open. */
function restOnOrb() {
  if (!orb().visible) orb().emit('ready-to-show');
  const { x, y, width, height } = orb().bounds;
  vi.spyOn(screen, 'getCursorScreenPoint').mockReturnValue({ x: x + width / 2, y: y + height / 2 });
  const faked = vi.isFakeTimers();
  if (!faked) vi.useFakeTimers();
  hoverOrb(false);
  hoverOrb(true);
  vi.advanceTimersByTime(DesktopCompanionTiming.LauncherOpenDelayMs);
  if (!faked) vi.useRealTimers();
}

/** Opens the hover launcher and picks one of its entries. */
function launch(action: CompanionLauncherAction) {
  restOnOrb();
  expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.Launcher);
  invoke(DesktopCompanionIpc.StageCommand, { type: DesktopCompanionStageCommandType.LauncherRun, action }, stageWindow().webContents);
}

function readyPanel(panel = mocks.windows.at(-1)) {
  return invoke(DesktopCompanionIpc.PanelReady, manager.getState().panelOpenRevision, panel.webContents);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(globalShortcut.register).mockReturnValue(true);
  mocks.windows.length = 0;
  mocks.handlers.clear();
  FakeSelectionHook.last = null;
  // Most lifecycle cases start with the orb explicitly disabled and open surfaces on demand.
  values = new Map<string, unknown>([
    [DesktopCompanionStoreKey.Greeted, true],
    [DesktopCompanionStoreKey.Preferences, { enabled: false }],
  ]);
});
afterEach(() => {
  manager?.dispose();
  vi.restoreAllMocks();
  ipcMain.removeAllListeners();
  vi.useRealTimers();
});

describe('gateway readiness', () => {
  test('keeps a sessionless answer open through a gateway restart and still honors disabling selection', () => {
    vi.useFakeTimers();
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create(undefined, OpenClawEnginePhase.Running, () => FakeSelectionHook);
    FakeSelectionHook.last!.emit('text-selection', {
      text: 'Selected project update', programName: 'chrome.exe', posLevel: 0, mousePosEnd: { x: 500, y: 400 },
    });
    vi.advanceTimersByTime(200);
    const selection = mocks.windows.at(-1);
    invoke(DesktopCompanionIpc.SelectionCommand, {
      type: DesktopCompanionSelectionCommandType.Run, action: CompanionSelectionAction.Summarize,
    }, selection.webContents);
    expect(selection.isVisible()).toBe(true);
    selection.webContents.send.mockClear();
    foreground.stop.mockClear();

    for (const phase of [OpenClawEnginePhase.Starting, OpenClawEnginePhase.Error, OpenClawEnginePhase.Running]) {
      manager.setEnginePhase(phase);
      expect(selection.isVisible()).toBe(true);
      expect(manager.getState().capabilities.selection).toBe(CompanionCapability.Ready);
      expect(selection.webContents.send).not.toHaveBeenCalledWith(DesktopCompanionIpc.Selection, null);
    }
    expect(foreground.stop).not.toHaveBeenCalled();
    manager.setPreferences({ selectionToolbar: false });
    expect(selection.isVisible()).toBe(false);
    expect(manager.getState().capabilities.selection).toBe(CompanionCapability.Off);
  });

  test('allows standalone selection tools before the gateway is ready while task entry stays deferred', () => {
    vi.useFakeTimers();
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create(undefined, OpenClawEnginePhase.Starting, () => FakeSelectionHook);
    expect(manager.getState().capabilities.selection).toBe(CompanionCapability.Ready);
    expect(foreground.start).toHaveBeenCalled();
    FakeSelectionHook.last!.emit('text-selection', {
      text: 'Selected text', programName: 'chrome.exe', posLevel: 0, mousePosEnd: { x: 500, y: 400 },
    });
    vi.advanceTimersByTime(200);
    const selection = mocks.windows.at(-1);
    expect(selection.isVisible()).toBe(true);
    expect(selection.webContents.send).toHaveBeenCalledWith(DesktopCompanionIpc.Selection,
      expect.objectContaining({ mode: DesktopCompanionSelectionMode.Toolbar, text: 'Selected text' }));
    manager.togglePanel(AnalyticsSource.Shortcut);
    expect(manager.getState().panelVisible).toBe(false);
    foreground.emit('change', 'notepad.exe');
    expect(selection.isVisible()).toBe(false);
    FakeSelectionHook.last!.emit('text-selection', {
      text: 'Another selection', programName: 'notepad.exe', posLevel: 0, mousePosEnd: { x: 500, y: 400 },
    });
    vi.advanceTimersByTime(200);
    expect(selection.isVisible()).toBe(true);
    manager.setPreferences({ enabled: false });
    expect(selection.isVisible()).toBe(false);
  });

  test.each(Object.values(OpenClawEnginePhase).filter(phase => phase !== OpenClawEnginePhase.Running))(
    'keeps the enabled companion hidden during %s until the gateway runs', phase => {
      values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
      create(undefined, phase);
      expect(mocks.windows).toHaveLength(1);
      expect(foreground.start).not.toHaveBeenCalled();
      expect(fileDrag.start).not.toHaveBeenCalled();
      manager.setPreferences({ enabled: true });
      manager.wake();
      expect(mocks.windows).toHaveLength(1);
      manager.setEnginePhase(OpenClawEnginePhase.Running);
      orb().emit('ready-to-show');
      expect(orb().isVisible()).toBe(true);
      expect(foreground.start).toHaveBeenCalledTimes(1);
      manager.setEnginePhase(OpenClawEnginePhase.Running);
      expect(mocks.windows).toHaveLength(2);
    },
  );

  test('defers a shortcut opening until ready, including when the orb is disabled', () => {
    create(undefined, OpenClawEnginePhase.Starting);
    manager.togglePanel(AnalyticsSource.Shortcut);
    expect(manager.getState().panelVisible).toBe(false);
    expect(mocks.windows).toHaveLength(1);
    manager.setEnginePhase(OpenClawEnginePhase.Running);
    expect(manager.getState().panelVisible).toBe(true);
    expect(readyPanel()).toBe(true);
    expect(reportAnalytics).toHaveBeenCalledWith(expect.objectContaining({ source: AnalyticsSource.Shortcut, surface: DesktopCompanionSurface.Panel }));
  });

  test('a second shortcut cancels a deferred opening', () => {
    create(undefined, OpenClawEnginePhase.Starting);
    manager.togglePanel(AnalyticsSource.Shortcut);
    manager.togglePanel(AnalyticsSource.Shortcut);
    manager.setEnginePhase(OpenClawEnginePhase.Running);
    expect(manager.getState().panelVisible).toBe(false);
    expect(mocks.windows).toHaveLength(1);
  });

  test('a restart hides the orb and panel, rejects late show events and retains the draft', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    const originalOrb = orb();
    manager.togglePanel();
    const panel = mocks.windows.at(-1);
    readyPanel(panel);
    invoke(DesktopCompanionIpc.SetDraft, { prompt: 'Keep this draft', attachments: [] });
    manager.setEnginePhase(OpenClawEnginePhase.Starting);
    expect(originalOrb.isDestroyed()).toBe(true);
    expect(panel.isVisible()).toBe(false);
    originalOrb.emit('ready-to-show');
    expect(readyPanel(panel)).toBe(false);
    expect(manager.getState().draft.prompt).toBe('Keep this draft');
    manager.setEnginePhase(OpenClawEnginePhase.Running);
    expect(mocks.windows.at(-1)).not.toBe(originalOrb);
    manager.togglePanel();
    expect(readyPanel(panel)).toBe(true);
    expect(manager.getState().draft.prompt).toBe('Keep this draft');
  });

  test('readiness does not override disabled or snoozed preferences', () => {
    create(undefined, OpenClawEnginePhase.Starting);
    manager.setEnginePhase(OpenClawEnginePhase.Running);
    expect(mocks.windows).toHaveLength(1);
    manager.setEnginePhase(OpenClawEnginePhase.Starting);
    manager.setPreferences({ enabled: true });
    manager.snoozeFor(DesktopCompanionSnoozeMode.Hidden);
    manager.setEnginePhase(OpenClawEnginePhase.Running);
    expect(mocks.windows).toHaveLength(1);
  });
});

describe('orb edge snapping', () => {
  const rightEdge = 1280 - DesktopCompanionSize.BrandOrb.width;
  const drag = (phase: DesktopCompanionDragPhase, x: number, y = 330) => {
    vi.spyOn(screen, 'getCursorScreenPoint').mockReturnValue({ x, y });
    // Like the renderer, a press reports where it landed in the orb window.
    const { bounds } = orb();
    emitDrag(phase, phase === DesktopCompanionDragPhase.Start
      ? { x: (x - bounds.x) / bounds.width, y: (y - bounds.y) / bounds.height }
      : undefined);
  };

  beforeEach(() => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    values.set(DesktopCompanionStoreKey.Position, { x: 200, y: 300 });
  });

  test.each([
    { edgeX: 0, releaseX: 30, placement: DesktopCompanionPanelPlacement.Right },
    { edgeX: rightEdge, releaseX: rightEdge - 30, placement: DesktopCompanionPanelPlacement.Left },
  ])('snaps to x=$edgeX on release, aligns the panel and restores the saved position', ({ edgeX, releaseX, placement }) => {
    create();
    manager.togglePanel();
    const panel = mocks.windows.at(-1);
    drag(DesktopCompanionDragPhase.Start, 230);
    drag(DesktopCompanionDragPhase.Move, releaseX + 30);
    expect(orb().bounds).toMatchObject({ x: releaseX, y: 300 });
    expect(values.get(DesktopCompanionStoreKey.Position)).toEqual({ x: 200, y: 300 });
    drag(DesktopCompanionDragPhase.End, releaseX + 30);
    expect(orb().bounds).toMatchObject({ x: edgeX, y: 300 });
    expect(values.get(DesktopCompanionStoreKey.Position)).toEqual({ x: edgeX, y: 300 });
    expect(manager.getState().panelPlacement).toBe(placement);
    if (placement === DesktopCompanionPanelPlacement.Right) {
      expect(panel.bounds.x + DesktopCompanionSize.SurfacePad).toBe(edgeX + DesktopCompanionSize.BrandOrb.width);
    } else {
      expect(panel.bounds.x + panel.bounds.width - DesktopCompanionSize.SurfacePad).toBe(edgeX);
    }
    manager.dispose();
    mocks.windows.length = 0;
    create();
    expect(orb().bounds).toMatchObject({ x: edgeX, y: 300 });
  });

  test.each([0, rightEdge])('can drag directly away from the snapped edge at x=%i', edgeX => {
    values.set(DesktopCompanionStoreKey.Position, { x: edgeX, y: 300 });
    create();
    drag(DesktopCompanionDragPhase.Start, edgeX + 30);
    const distance = DesktopCompanionSize.OrbSnapDistance + 1;
    const x = edgeX === 0 ? distance : edgeX - distance;
    drag(DesktopCompanionDragPhase.Move, x + 30);
    drag(DesktopCompanionDragPhase.End, x + 30);
    expect(orb().bounds).toMatchObject({ x, y: 300 });
    expect(values.get(DesktopCompanionStoreKey.Position)).toEqual({ x, y: 300 });
  });

  test.each([30, rightEdge - 30])('a click near an edge at x=%i does not move the orb', x => {
    values.set(DesktopCompanionStoreKey.Position, { x, y: 300 });
    create();
    drag(DesktopCompanionDragPhase.Start, x + 30);
    drag(DesktopCompanionDragPhase.Cancel, x + 30);
    expect(orb().bounds).toMatchObject({ x, y: 300 });
    expect(values.get(DesktopCompanionStoreKey.Position)).toEqual({ x, y: 300 });
  });

  test('keeps the pressed point under the pointer when the press arrives after the cursor moved on', () => {
    create();
    // Pressed at the orb's center, but the cursor is 100px further by the time the press arrives.
    vi.spyOn(screen, 'getCursorScreenPoint').mockReturnValue({ x: 330, y: 330 });
    emitDrag(DesktopCompanionDragPhase.Start, { x: 0.5, y: 0.5 });
    drag(DesktopCompanionDragPhase.Move, 430);
    expect(orb().bounds).toMatchObject({ x: 400, y: 300 });
    drag(DesktopCompanionDragPhase.End, 430);
    expect(values.get(DesktopCompanionStoreKey.Position)).toEqual({ x: 400, y: 300 });
  });

  test('does not move the orb again for pointer events while the cursor stays still', () => {
    create();
    drag(DesktopCompanionDragPhase.Start, 230);
    drag(DesktopCompanionDragPhase.Move, 330);
    expect(orb().bounds).toMatchObject({ x: 300, y: 300 });
    // The window moves under the still cursor, which reports pointer events of its own.
    orb().bounds = { ...orb().bounds, x: 200 };
    const setBounds = vi.spyOn(orb(), 'setBounds');
    drag(DesktopCompanionDragPhase.Move, 330);
    expect(setBounds).not.toHaveBeenCalled();
    drag(DesktopCompanionDragPhase.Move, 340);
    expect(orb().bounds).toMatchObject({ x: 310, y: 300 });
  });

  test.each([
    { displayX: -1440, cursorX: -1380, edgeX: -1440 },
    { displayX: 1280, cursorX: 2660, edgeX: 2660 },
  ])('snaps to the display at x=$displayX under the cursor when crossing monitors', ({ displayX, cursorX, edgeX }) => {
    create();
    drag(DesktopCompanionDragPhase.Start, 230);
    vi.spyOn(screen, 'getDisplayNearestPoint').mockReturnValue({
      workArea: { x: displayX, y: 25, width: 1440, height: 875 },
    } as Electron.Display);
    drag(DesktopCompanionDragPhase.End, cursorX, 430);
    expect(orb().bounds).toMatchObject({ x: edgeX, y: 400 });
    expect(values.get(DesktopCompanionStoreKey.Position)).toEqual({ x: edgeX, y: 400 });
  });

  describe('task bubbles across displays', () => {
    const primary = { x: 0, y: 0, width: 1280, height: 900 };
    const externalDisplays = [
      { x: 1280, y: 25, width: 1920, height: 1055 },
      { x: -1920, y: 25, width: 1920, height: 1055 },
      { x: 0, y: -1080, width: 1920, height: 1080 },
      { x: 0, y: 900, width: 1920, height: 1080 },
    ];

    function connectDisplay(external: typeof primary) {
      const displayAt = ({ x, y }: { x: number; y: number }) => ({
        workArea: x >= external.x && x < external.x + external.width
          && y >= external.y && y < external.y + external.height ? external : primary,
      }) as Electron.Display;
      vi.spyOn(screen, 'getDisplayNearestPoint').mockImplementation(displayAt);
      vi.spyOn(screen, 'getDisplayMatching').mockImplementation(bounds => displayAt({
        x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2,
      }));
    }

    function openTaskBubble() {
      values.set(DesktopCompanionStoreKey.Position, { x: 1100, y: 300 });
      values.set(DesktopCompanionStoreKey.Session, 'task');
      create();
      ipcMain.emit(DesktopCompanionIpc.TaskUpdated, { sender: orb().webContents, senderFrame: orb().webContents.mainFrame });
      return mocks.windows.at(-1);
    }

    test.each(externalDisplays)('opens the shortcut composer to the left after dragging onto a display at $x, $y', external => {
      connectDisplay(external);
      create();
      const shortcut = vi.mocked(globalShortcut.register).mock.calls[0][1];
      // Start on the laptop, then reuse the same composer on the external display.
      shortcut();
      const panel = mocks.windows.at(-1);
      readyPanel(panel);
      shortcut();
      drag(DesktopCompanionDragPhase.Start, 230);
      const cursor = { x: external.x + 530, y: external.y + 430 };
      drag(DesktopCompanionDragPhase.Move, cursor.x, cursor.y);
      drag(DesktopCompanionDragPhase.End, cursor.x, cursor.y);
      shortcut();
      expect(mocks.windows.at(-1)).toBe(panel);
      expect(readyPanel(panel)).toBe(true);
      expect(panel.visible).toBe(true);
      expect(panel.focused).toBe(true);
      expect(manager.getState().panelPlacement).toBe(DesktopCompanionPanelPlacement.Left);
      expect(panel.bounds.x + panel.bounds.width - DesktopCompanionSize.SurfacePad).toBe(orb().bounds.x);
      expect(panel.bounds.x).toBeGreaterThanOrEqual(external.x);
      expect(panel.bounds.y).toBeGreaterThanOrEqual(external.y);
      expect(panel.bounds.y + panel.bounds.height).toBeLessThanOrEqual(external.y + external.height);
      shortcut();
      shortcut();
      expect(readyPanel(panel)).toBe(true);
      expect(manager.getState().panelPlacement).toBe(DesktopCompanionPanelPlacement.Left);
    });

    test.each(externalDisplays)('follows the orb live onto a display at $x, $y and keeps its left placement on reopen', external => {
      connectDisplay(external);
      const result = openTaskBubble();
      const pad = DesktopCompanionSize.SurfacePad;
      expect(result.bounds.x + result.bounds.width - pad).toBe(orb().bounds.x);
      drag(DesktopCompanionDragPhase.Start, 1130);
      // There is room to the left, even though the orb is on the external display's left half.
      const cursor = { x: external.x + 530, y: external.y + 430 };
      drag(DesktopCompanionDragPhase.Move, cursor.x, cursor.y);
      expect(result.bounds.x).toBeGreaterThanOrEqual(external.x);
      expect(result.bounds.y).toBeGreaterThanOrEqual(external.y);
      expect(result.bounds.y + result.bounds.height).toBeLessThanOrEqual(external.y + external.height);
      expect(result.bounds.x + result.bounds.width - pad).toBe(orb().bounds.x);
      expect(result.visible).toBe(true);
      drag(DesktopCompanionDragPhase.End, cursor.x, cursor.y);
      const bounds = { ...result.bounds };
      invoke(CompanionResultIpc.Hide, undefined, result.webContents);
      invoke(CompanionResultIpc.Open);
      expect(result.bounds).toEqual(bounds);
      // A resize after reopening must still use the orb's current display.
      ipcMain.emit(DesktopCompanionIpc.ResizeSurface,
        { sender: result.webContents, senderFrame: result.webContents.mainFrame }, { width: 374, height: 220 });
      expect(result.bounds.x + result.bounds.width - pad).toBe(orb().bounds.x);
      drag(DesktopCompanionDragPhase.Start, cursor.x, cursor.y);
      drag(DesktopCompanionDragPhase.Move, 1130);
      expect(result.bounds.x + result.bounds.width - pad).toBe(orb().bounds.x);
      expect(result.bounds.y).toBeGreaterThanOrEqual(primary.y);
      drag(DesktopCompanionDragPhase.End, 1130);
    });

    test('keeps a manually detached task bubble on its own display when the orb crosses screens', () => {
      connectDisplay(externalDisplays[0]);
      const result = openTaskBubble();
      result.emit('will-move');
      result.bounds = { ...result.bounds, x: 300, y: 200 };
      const bounds = { ...result.bounds };
      drag(DesktopCompanionDragPhase.Start, 1130);
      drag(DesktopCompanionDragPhase.Move, 1810, 455);
      drag(DesktopCompanionDragPhase.End, 1810, 455);
      expect(result.bounds).toEqual(bounds);
      expect(manager.getState().result.pinned).toBe(true);
    });

    test('keeps a bubble opened without an orb on its initial display when the cursor changes screens', () => {
      connectDisplay(externalDisplays[0]);
      values.set(DesktopCompanionStoreKey.Preferences, { enabled: false });
      values.set(DesktopCompanionStoreKey.Session, 'task');
      create();
      invoke(CompanionResultIpc.Open);
      const result = mocks.windows.at(-1);
      const bounds = { ...result.bounds };
      vi.spyOn(screen, 'getCursorScreenPoint').mockReturnValue({ x: 1810, y: 455 });
      screen.emit('display-metrics-changed');
      expect(result.bounds).toEqual(bounds);
    });
  });
});

describe('desktop companion lifecycle', () => {
  test('counts saved setting changes once and excludes passive reads and pointer movement', () => {
    create();
    expect(reportAnalytics).not.toHaveBeenCalled();
    invoke(DesktopCompanionIpc.SetPreferences, { enabled: true });
    invoke(DesktopCompanionIpc.SetPreferences, { enabled: true });
    invoke(DesktopCompanionIpc.GetState);
    invoke(DesktopCompanionIpc.SetDraft, { prompt: 'secret', attachments: [] });
    emitDrag(DesktopCompanionDragPhase.Move);
    const changes = reportAnalytics.mock.calls.map(([event]) => event).filter(event => event.action === AnalyticsAction.SettingChanged);
    expect(changes).toEqual([{ action: AnalyticsAction.SettingChanged, source: AnalyticsSource.Settings, setting: CompanionAnalyticsSetting.Enabled, enabled: true }]);
    expect(JSON.stringify(reportAnalytics.mock.calls)).not.toContain('secret');
    const count = reportAnalytics.mock.calls.length;
    vi.mocked(globalShortcut.register).mockReturnValue(false);
    expect(invoke(DesktopCompanionIpc.SetPreferences, { shortcut: 'Alt+X' }).success).toBe(false);
    expect(reportAnalytics).toHaveBeenCalledTimes(count);
  });

  test('attributes panel openings to shortcut and orb without duplicate opens on readiness or resize', () => {
    create();
    const shortcut = vi.mocked(globalShortcut.register).mock.calls[0][1];
    shortcut();
    const panel = mocks.windows[1];
    expect(readyPanel(panel)).toBe(true);
    expect(readyPanel(panel)).toBe(true);
    ipcMain.emit(DesktopCompanionIpc.ResizeSurface, { sender: panel.webContents, senderFrame: panel.webContents.mainFrame }, { width: 380, height: 300 });
    shortcut();
    invoke(DesktopCompanionIpc.ToggleOrb);
    expect(readyPanel(panel)).toBe(true);
    const opens = reportAnalytics.mock.calls.map(([event]) => event).filter(event => event.interactionType === Interaction.Open);
    expect(opens).toEqual([
      expect.objectContaining({ source: AnalyticsSource.Shortcut, surface: DesktopCompanionSurface.Panel }),
      expect.objectContaining({ source: AnalyticsSource.Orb, surface: DesktopCompanionSurface.Panel }),
    ]);
    expect(opens[0].journeyId).toEqual(expect.any(String));
    expect(opens[1].journeyId).not.toBe(opens[0].journeyId);
    invoke(DesktopCompanionIpc.ReportAnalytics, { action: AnalyticsAction.Task, source: AnalyticsSource.Orb,
      stage: AnalyticsStage.Submit, callId: '11111111-1111-4111-8111-111111111111' }, panel.webContents);
    expect(reportAnalytics.mock.lastCall?.[0]).toMatchObject({ journeyId: opens[1].journeyId, source: AnalyticsSource.Panel });
  });

  test('validates analytics IPC sender, event family and payload before reporting', () => {
    create();
    manager.togglePanel();
    const panel = mocks.windows[1];
    reportAnalytics.mockClear();
    const event = { action: AnalyticsAction.Task, source: AnalyticsSource.Orb, stage: AnalyticsStage.Submit, prompt: 'secret', sessionId: 'private-session' };
    invoke(DesktopCompanionIpc.ReportAnalytics, event, panel.webContents);
    expect(reportAnalytics).toHaveBeenCalledExactlyOnceWith({ action: AnalyticsAction.Task, source: AnalyticsSource.Panel, stage: AnalyticsStage.Submit });
    invoke(DesktopCompanionIpc.ReportAnalytics, { ...event, action: AnalyticsAction.SettingChanged }, panel.webContents);
    invoke(DesktopCompanionIpc.ReportAnalytics, event);
    expect(reportAnalytics).toHaveBeenCalledTimes(1);
    const foreign = new BrowserWindow();
    expect(() => invoke(DesktopCompanionIpc.ReportAnalytics, event, foreign.webContents)).toThrow();
    expect(() => mocks.handlers.get(DesktopCompanionIpc.ReportAnalytics)!({ sender: panel.webContents, senderFrame: {} }, event)).toThrow();
  });

  test('selection task references survive panel dismissal and draft persistence until explicitly removed', () => {
    create();
    const selectionContext = {
      id: 'selection-task', action: CompanionSelectionAction.Summarize, sourceText: 'Selected report',
      turns: [{ role: 'assistant', content: 'Report summary' }],
    };
    invoke(DesktopCompanionIpc.SetDraft, {
      prompt: '', attachments: [], workingDirectory: '/tasks', selectionContext,
    });
    invoke(DesktopCompanionIpc.TogglePanel);
    invoke(DesktopCompanionIpc.HidePanel);
    expect(manager.getState().draft.selectionContext).toEqual(selectionContext);
    manager.dispose();
    create();
    expect(manager.getState().draft.selectionContext).toEqual(selectionContext);
    invoke(DesktopCompanionIpc.SetDraft, { ...manager.getState().draft, selectionContext: undefined });
    expect(manager.getState().draft.selectionContext).toBeUndefined();
  });

  test.each([LanguageTool.Translate, LanguageTool.Tts])('%s follows the current toolbar through resize, drag and reuse', tool => {
    create();
    const anchor = vi.spyOn(CompanionSelectionController.prototype, 'selectionAnchor', 'get')
      .mockReturnValue({ left: 360, right: 440, top: 200, bottom: 800, multiline: true });
    const toolbar = vi.spyOn(CompanionSelectionController.prototype, 'selectionToolbarBounds', 'get')
      .mockReturnValue({ x: 326, y: 136, width: 410, height: 80 });
    invoke(LanguageToolsIpc.Open, { tool, text: 'A long selected paragraph' });
    const window = mocks.windows[1];
    expect(window.bounds).toMatchObject({ x: 326, y: 136 });
    // Hiding the selection clears its public anchors, but the tool keeps its captured position.
    anchor.mockReturnValue(null);
    toolbar.mockReturnValue(null);
    const resize = (height: number) => ipcMain.emit(DesktopCompanionIpc.ResizeSurface,
      { sender: window.webContents, senderFrame: window.webContents.mainFrame }, { width: 444, height });
    resize(600);
    expect(window.bounds).toMatchObject({ x: 326, y: 136, height: 600 });
    resize(300);
    if (tool === LanguageTool.Translate) {
      invoke(LanguageToolsIpc.Hide, undefined, window.webContents);
      invoke(LanguageToolsIpc.Open, { tool });
      expect(window.bounds).toMatchObject({ x: 326, y: 136 });
    }
    window.bounds = { ...window.bounds, x: 100, y: 400 };
    window.emit('will-move');
    resize(350);
    expect(window.bounds).toMatchObject({ x: 100, y: 400, height: 350 });
    anchor.mockReturnValue({ left: 650, right: 700, top: 300, bottom: 700, multiline: true });
    toolbar.mockReturnValue({ x: 616, y: 236, width: 410, height: 80 });
    invoke(LanguageToolsIpc.Open, { tool, text: 'Another selection' });
    expect(window.bounds).toMatchObject({ x: 616, y: 236 });
    // An entry without a selection must not reuse the previous toolbar position.
    anchor.mockReturnValue(null);
    toolbar.mockReturnValue(null);
    invoke(LanguageToolsIpc.Open, { tool, text: 'Text from another entry' });
    expect(window.bounds.x).toBe(0);
    expect(window.bounds.y).toBeLessThan(120);
  });

  test('language cards open beside the selection, resize with content, and restore without a new request', () => {
    create();
    const anchor = vi.spyOn(CompanionSelectionController.prototype, 'selectionAnchor', 'get')
      .mockReturnValue({ left: 360, right: 440, top: 200, bottom: 220, multiline: false });
    try {
      invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Translate, text: 'Selected words' });
      const window = mocks.windows[1];
      // Centered under the selected words.
      expect(window.bounds.x + window.bounds.width / 2).toBe(400);
      expect(window.bounds.y + DesktopCompanionSize.SurfacePad).toBeGreaterThanOrEqual(220);
      expect(window.bounds.y).toBeLessThan(240);
      const firstInput = invoke(LanguageToolsIpc.GetInput, undefined, window.webContents);
      ipcMain.emit(DesktopCompanionIpc.ResizeSurface, { sender: window.webContents, senderFrame: window.webContents.mainFrame }, { width: 436, height: 260 });
      expect(window.bounds).toMatchObject({ width: 436, height: 260 });
      invoke(LanguageToolsIpc.Hide, undefined, window.webContents);
      invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Tts });
      expect(invoke(LanguageToolsIpc.GetInput, undefined, window.webContents)).toEqual(firstInput);
      expect(window.visible).toBe(true);
    } finally { anchor.mockRestore(); }
  });

  test('pin keeps a read-aloud card playing on blur; an unpinned card stops when it disappears', () => {
    create();
    invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Tts });
    expect(mocks.windows).toHaveLength(1);
    invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Tts, text: 'Read this' });
    const window = mocks.windows[1];
    invoke(LanguageToolsIpc.SpeechStatus, SpeechStatus.Playing, window.webContents);
    invoke(LanguageToolsIpc.Pin, true, window.webContents);
    window.emit('blur');
    expect(window.visible).toBe(true);
    expect(manager.getState().speechStatus).toBe(SpeechStatus.Playing);
    invoke(LanguageToolsIpc.Pin, false, window.webContents);
    window.emit('blur');
    expect(window.visible).toBe(false);
    expect(manager.getState().speechStatus).toBe(SpeechStatus.Idle);
    expect(window.webContents.send).toHaveBeenCalledWith(LanguageToolsIpc.Reset);
    expect(invoke(LanguageToolsIpc.GetInput, undefined, window.webContents)).toBeNull();
    invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Tts });
    window.emit('ready-to-show');
    expect(window.visible).toBe(false);
  });

  test.each([SpeechStatus.Loading, SpeechStatus.Playing, SpeechStatus.Paused])('hiding a %s read-aloud card cancels synthesis and cannot resume playback', status => {
    const client = { reset: vi.fn(), start: vi.fn(() => ({ success: true })) };
    create(client as unknown as CompanionLanguageClient);
    invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Tts, text: 'Read this' });
    const window = mocks.windows[1];
    invoke(LanguageToolsIpc.SpeechStatus, status, window.webContents);
    const request = { tool: LanguageTool.Tts, text: 'Read this', requestId: 'pending-speech' };
    expect(invoke(LanguageToolsIpc.Start, request, window.webContents)).toEqual({ success: true });
    window.webContents.send.mockClear();
    // Also cover native/system hiding, which does not use the close button.
    window.hide();
    expect(client.reset).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenCalledWith(LanguageToolsIpc.Reset);
    expect(manager.getState().speechStatus).toBe(SpeechStatus.Idle);
    expect(invoke(LanguageToolsIpc.GetInput, undefined, window.webContents)).toBeNull();
    expect(invoke(LanguageToolsIpc.Start, request, window.webContents)).toEqual({ success: false, code: LanguageToolCode.Unavailable });
    expect(client.start).toHaveBeenCalledOnce();
    invoke(LanguageToolsIpc.SpeechStatus, SpeechStatus.Playing, window.webContents);
    invoke(LanguageToolsIpc.SpeechCommand, SpeechCommand.Resume);
    expect(manager.getState().speechStatus).toBe(SpeechStatus.Idle);
    expect(window.webContents.send).not.toHaveBeenCalledWith(LanguageToolsIpc.SpeechCommand, SpeechCommand.Resume);
    invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Tts });
    expect(window.visible).toBe(false);
    expect(menu().some(item => item.label === 'desktopToolsPlayback')).toBe(false);
  });

  test('closing a read-aloud card and resetting an account both stop playback', () => {
    create();
    invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Tts, text: 'Read this' });
    const window = mocks.windows[1];
    expect(window.visible).toBe(true);
    invoke(LanguageToolsIpc.SpeechStatus, SpeechStatus.Playing, window.webContents);
    invoke(LanguageToolsIpc.Close, undefined, window.webContents);
    expect(window.visible).toBe(false);
    expect(manager.getState().speechStatus).toBe(SpeechStatus.Idle);
    expect(invoke(LanguageToolsIpc.GetInput, undefined, window.webContents)).toBeNull();
    invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Tts, text: 'Read a new selection' });
    expect(mocks.windows).toHaveLength(2);
    expect(window.visible).toBe(true);
    invoke(LanguageToolsIpc.SpeechStatus, SpeechStatus.Playing, window.webContents);
    manager.resetLanguageTools();
    expect(window.visible).toBe(false);
    expect(manager.getState().speechStatus).toBe(SpeechStatus.Idle);
    expect(window.webContents.send).toHaveBeenCalledWith(LanguageToolsIpc.Reset);
  });

  test('only the language window can start playback or publish its status', () => {
    create();
    expect(() => invoke(LanguageToolsIpc.Start, {})).toThrow('Invalid language tools IPC sender');
    expect(() => invoke(LanguageToolsIpc.SpeechStatus, SpeechStatus.Playing)).toThrow('Invalid language tools IPC sender');
    const unknown = new BrowserWindow();
    expect(() => invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Tts }, unknown.webContents)).toThrow('Unknown desktop companion IPC sender');
  });

  test('the orb menu focuses visible playback and hiding it removes the playback entry', () => {
    create();
    expect(menu().some(item => item.label === 'desktopToolsPlayback')).toBe(false);
    invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Tts, text: 'Keep reading this text' });
    const window = mocks.windows[1];
    const input = invoke(LanguageToolsIpc.GetInput, undefined, window.webContents);
    for (const status of [SpeechStatus.Loading, SpeechStatus.Playing, SpeechStatus.Paused]) {
      invoke(LanguageToolsIpc.SpeechStatus, status, window.webContents);
      clickMenu('desktopToolsPlayback');
      expect(window.visible).toBe(true);
      expect(mocks.windows).toHaveLength(2);
      expect(invoke(LanguageToolsIpc.GetInput, undefined, window.webContents)).toEqual(input);
      expect(manager.getState().speechStatus).toBe(status);
    }
    invoke(LanguageToolsIpc.Hide, undefined, window.webContents);
    expect(window.visible).toBe(false);
    expect(manager.getState().speechStatus).toBe(SpeechStatus.Idle);
    expect(menu().some(item => item.label === 'desktopToolsPlayback')).toBe(false);
  });

  test.each([undefined, {}, { shortcut: '' }])('starts with a visible orb when saved preferences omit enabled: %j', preferences => {
    values.set(DesktopCompanionStoreKey.Preferences, preferences);
    create();
    expect(manager.getState().preferences.enabled).toBe(true);
    expect(mocks.windows).toHaveLength(2);
    orb().emit('ready-to-show');
    expect(orb().visible).toBe(true);
    expect(foreground.start).toHaveBeenCalled();
    expect(fileDrag.start).toHaveBeenCalled();
    expect(manager.getState().panelVisible).toBe(false);
  });

  test('a disabled profile creates no floating window and opening a temporary panel does not opt in', () => {
    create();
    expect(manager.getState().preferences.enabled).toBe(false);
    expect(mocks.windows).toHaveLength(1);
    expect(foreground.start).not.toHaveBeenCalled();
    manager.togglePanel();
    expect(manager.getState().panelVisible).toBe(true);
    expect(manager.getState().preferences.enabled).toBe(false);
    expect(mocks.windows).toHaveLength(2);
    // With no orb to come out of, the card opens a little below the middle of the screen.
    expect(manager.getState().panelPlacement).toBe(DesktopCompanionPanelPlacement.Center);
    const panel = mocks.windows[1];
    const cardWidth = DesktopCompanionSize.Composer.width + DesktopCompanionSize.SurfacePad * 2;
    expect(panel.bounds.x + cardWidth / 2).toBe(640);
    expect(panel.bounds.y + panel.bounds.height).toBeGreaterThan(450 + DesktopCompanionSize.PanelCompactHeight / 2);
    manager.hidePanel();
    expect(mocks.windows[1].visible).toBe(false);
  });

  test('turning off persists across launches and does not lose a selected task', () => {
    create();
    manager.setPreferences({ enabled: true });
    expect(foreground.start).toHaveBeenCalled();
    expect(fileDrag.start).toHaveBeenCalled();
    invoke(DesktopCompanionIpc.SelectSession, 'running-task');
    manager.setPreferences({ enabled: false });
    expect(orb().destroyed).toBe(true);
    expect(fileDrag.stop).toHaveBeenCalled();
    manager.dispose();
    mocks.windows.length = 0;
    create();
    expect(manager.getState().preferences.enabled).toBe(false);
    expect(manager.getState().sessionId).toBe('running-task');
    expect(mocks.windows).toHaveLength(1);
  });

  test('v1 preferences keep working and pick up the new defaults', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true, showLabel: true, shortcut: '' });
    create();
    expect(manager.getState().preferences).toEqual({
      enabled: true,
      shortcut: '',
      skin: 'lobster',
      selectionToolbar: true,
      dragAssist: true,
      contextHints: true,
      selectionExcludedApps: [],
      selectionToolbarOrder: [...DEFAULT_COMPANION_TOOLBAR_ORDER],
    });
    // Without the native selection hook the toolbar reports itself unsupported instead of failing.
    expect(manager.getState().capabilities.selection).toBe(CompanionCapability.Unsupported);
    expect(globalShortcut.register).not.toHaveBeenCalled();
  });

  test('the default global shortcut opens and closes the panel while the orb is off', () => {
    create();
    expect(manager.getState().preferences.enabled).toBe(false);
    expect(globalShortcut.register).toHaveBeenCalledWith(DEFAULT_DESKTOP_COMPANION_PREFERENCES.shortcut, expect.any(Function));
    const toggle = vi.mocked(globalShortcut.register).mock.calls[0][1];
    toggle();
    expect(manager.getState().panelVisible).toBe(true);
    toggle();
    expect(manager.getState().panelVisible).toBe(false);
    expect(manager.getState().preferences.enabled).toBe(false);
  });

  test('a stored custom shortcut is registered instead of the default', () => {
    const shortcut = 'Control+Shift+J';
    values.set(DesktopCompanionStoreKey.Preferences, { shortcut });
    create();
    expect(manager.getState().preferences.shortcut).toBe(shortcut);
    expect(globalShortcut.register).toHaveBeenCalledExactlyOnceWith(shortcut, expect.any(Function));
  });

  test('clearing the default shortcut unregisters it and persists the disabled binding', () => {
    create();
    expect(manager.setPreferences({ shortcut: '' }).success).toBe(true);
    expect(globalShortcut.unregister).toHaveBeenCalledWith(DEFAULT_DESKTOP_COMPANION_PREFERENCES.shortcut);
    expect(values.get(DesktopCompanionStoreKey.Preferences)).toMatchObject({ shortcut: '' });
    manager.dispose();
    vi.mocked(globalShortcut.register).mockClear();
    create();
    expect(globalShortcut.register).not.toHaveBeenCalled();
    expect(manager.getState().preferences.shortcut).toBe('');
  });

  test('rejects unknown skins and keeps a short, clean exclusion list', () => {
    create();
    manager.setPreferences({ skin: 'not-a-skin', selectionExcludedApps: [' com.google.Chrome ', '', 42 as unknown as string] });
    expect(manager.getState().preferences.skin).toBe('lobster');
    expect(manager.getState().preferences.selectionExcludedApps).toEqual(['com.google.Chrome']);
  });

  test('saves toolbar order, repairs invalid entries and retains it on restart', () => {
    create();
    const result = manager.setPreferences({ selectionToolbarOrder: [CompanionToolbarItem.Ask, CompanionToolbarItem.Copy, CompanionToolbarItem.Ask] });
    const expected = [CompanionToolbarItem.Ask, CompanionToolbarItem.Copy, ...DEFAULT_COMPANION_TOOLBAR_ORDER.filter(item => item !== CompanionToolbarItem.Ask && item !== CompanionToolbarItem.Copy)];
    expect(result.success).toBe(true);
    expect(result.state.preferences.selectionToolbarOrder).toEqual(expected);
    expect(values.get(DesktopCompanionStoreKey.Preferences)).toMatchObject({ selectionToolbarOrder: expected });
    // Renderer snapshots must not be able to mutate the persisted order.
    result.state.preferences.selectionToolbarOrder.reverse();
    expect(manager.getState().preferences.selectionToolbarOrder).toEqual(expected);
    manager.dispose();
    create();
    expect(manager.getState().preferences.selectionToolbarOrder).toEqual(expected);
  });

  test('a saved retired skin falls back to the brand and is absent from the skin menu', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true, skin: 'qianqian', contextHints: false });
    create();
    expect(manager.getState().preferences).toMatchObject({ skin: DEFAULT_COMPANION_SKIN, contextHints: false });
    expect(orb().bounds).toMatchObject(DesktopCompanionSize.BrandOrb);
    const skins = menu().find(item => item.label === 'desktopCompanionChangeSkin')!.submenu as MenuItemConstructorOptions[];
    expect(skins.map(item => item.label)).toEqual([
      'desktopCompanionSkinLobster', 'desktopCompanionSkinRuanruanxia', 'desktopCompanionSkinXingxingxing',
      'desktopCompanionSkinShaee', 'desktopCompanionSkinZhangduoduo', 'desktopCompanionSkinJingyiming',
      'desktopCompanionSkinLiuliuyu', 'desktopCompanionSkinDanpapa', 'desktopCompanionSkinQingqingpiao',
    ]);
    expect(skins[0].checked).toBe(true);
  });

  test('the brand mark fits its orb, and switching skins keeps the orb centered', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    values.set(DesktopCompanionStoreKey.Position, { x: 600, y: 400 });
    create();
    const center = () => ({ x: orb().bounds.x + orb().bounds.width / 2, y: orb().bounds.y + orb().bounds.height / 2 });
    expect(orb().bounds).toMatchObject(DesktopCompanionSize.BrandOrb);
    expect(DesktopCompanionSize.BrandMark).toBe(40);
    expect(orb().bounds.width).toBeGreaterThan(DesktopCompanionSize.BrandMark + 8);
    const start = center();
    manager.setPreferences({ skin: 'ruanruanxia' });
    expect(orb().bounds).toMatchObject(DesktopCompanionSize.Orb);
    expect(center()).toEqual(start);
    manager.setPreferences({ skin: 'lobster' });
    expect(orb().bounds).toMatchObject(DesktopCompanionSize.BrandOrb);
    expect(center()).toEqual(start);
  });

  test('the context menu holds only what changes the companion itself; what it does is in the hover launcher', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    expect(menu().map(item => item.type === 'separator' ? '-' : item.label)).toEqual([
      'desktopCompanionChangeSkin', 'desktopCompanionSnoozeToday', '-', 'desktopCompanionSettings',
    ]);
    clickMenu('desktopCompanionSnoozeToday');
    expect(manager.getState().snooze?.mode).toBe(DesktopCompanionSnoozeMode.Quiet);
    expect(orb().destroyed).toBe(true);
    clickMenu('desktopCompanionWake');
    expect(manager.getState().snooze).toBeNull();
    clickMenu('desktopCompanionSettings');
    expect(openSettings).toHaveBeenCalledOnce();
  });

  test('a screenshot opens the panel with the crop and keeps the unsent prompt and attachments', async () => {
    const attachment = { path: '/tmp/screenshot.png', name: 'Screenshot.png', isImage: true };
    vi.spyOn(CompanionScreenshotController.prototype, 'capture').mockResolvedValue(attachment);
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    invoke(DesktopCompanionIpc.SetDraft, {
      prompt: 'Explain this', workingDirectory: '/tasks', attachments: [{ path: '/tasks/a.pdf', name: 'a.pdf' }],
    });
    launch(CompanionLauncherAction.Screenshot);
    await vi.waitFor(() => expect(manager.getState().panelVisible).toBe(true));
    expect(manager.getState()).toMatchObject({
      sessionId: null,
      draft: { prompt: 'Explain this', workingDirectory: '/tasks', attachments: [{ path: '/tasks/a.pdf' }, attachment] },
    });
    expect(openMain).not.toHaveBeenCalled();
    expect(reportAnalytics).toHaveBeenCalledWith(expect.objectContaining({
      action: AnalyticsAction.Tool, source: AnalyticsSource.Launcher, tool: 'screenshot', stage: AnalyticsStage.Result, outcome: 'success',
    }));
  });

  test('canceling capture keeps the draft, and nothing else can start or open while the screen is being captured', async () => {
    let finish!: (value: null) => void;
    const capture = vi.spyOn(CompanionScreenshotController.prototype, 'capture').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    invoke(DesktopCompanionIpc.SetDraft, { prompt: 'Keep this', attachments: [] });
    const draft = manager.getState().draft;
    launch(CompanionLauncherAction.Screenshot);
    restOnOrb();
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
    manager.togglePanel();
    expect(capture).toHaveBeenCalledOnce();
    expect(manager.getState().panelVisible).toBe(false);
    finish(null);
    await vi.waitFor(() => expect(reportAnalytics).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'screenshot', stage: AnalyticsStage.Result, outcome: 'cancelled',
    })));
    expect(manager.getState().draft).toEqual(draft);
    expect(manager.getState().panelVisible).toBe(false);
  });

  test('capture failure explains the failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(CompanionScreenshotController.prototype, 'capture').mockRejectedValue(new Error('Permission denied'));
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    launch(CompanionLauncherAction.Screenshot);
    await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalledWith({ type: 'error', message: 'desktopCompanionScreenshotFailed' }));
    expect(manager.getState().panelVisible).toBe(false);
  });

  test('explains Screen Recording before capturing; 去开启 lists LobsterAI and guides the user in System Settings', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValueOnce('denied');
    const capture = vi.spyOn(CompanionScreenshotController.prototype, 'capture');
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    launch(CompanionLauncherAction.Screenshot);
    expect(capture).not.toHaveBeenCalled();
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    const card = mocks.windows.at(-1);
    expect(card.isVisible()).toBe(true);
    expect(card.getBounds()).toMatchObject(COMPANION_PERMISSION_INTRO_SIZE);
    expect(guideOpenSettings).not.toHaveBeenCalled();

    await invoke(CompanionPermissionGuideIpc.Proceed, undefined, card.webContents);
    expect(requestScreenAccess).toHaveBeenCalledOnce();
    expect(guideOpenSettings).toHaveBeenCalledWith(expect.stringContaining('Privacy_ScreenCapture'));
  });

  test('closing the Screen Recording explanation leaves System Settings alone', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValueOnce('denied');
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    launch(CompanionLauncherAction.Screenshot);
    const card = mocks.windows.at(-1);
    await invoke(CompanionPermissionGuideIpc.Close, undefined, card.webContents);
    expect(card.isDestroyed()).toBe(true);
    expect(requestScreenAccess).not.toHaveBeenCalled();
    expect(guideOpenSettings).not.toHaveBeenCalled();
  });

  test('a capture refused for Screen Recording explains the permission instead of a generic failure', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(CompanionScreenshotController.prototype, 'capture').mockRejectedValue(new CompanionScreenPermissionError());
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    launch(CompanionLauncherAction.Screenshot);
    await vi.waitFor(() => expect(mocks.windows.at(-1).getBounds()).toMatchObject(COMPANION_PERMISSION_INTRO_SIZE));
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  test('a full draft does not start a screenshot that would silently lose an attachment', () => {
    const capture = vi.spyOn(CompanionScreenshotController.prototype, 'capture');
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    invoke(DesktopCompanionIpc.SetDraft, {
      attachments: Array.from({ length: 20 }, (_, index) => ({ path: `/tmp/${index}.png`, name: `${index}.png` })),
    });
    launch(CompanionLauncherAction.Screenshot);
    expect(capture).not.toHaveBeenCalled();
    expect(manager.getState().draft.attachments).toHaveLength(20);
    expect(dialog.showMessageBox).toHaveBeenCalledWith({ type: 'info', message: 'desktopCompanionScreenshotFull' });
  });

  test('identifies only the live composer web contents across window recreation', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    expect(manager.isComposerWebContents(main.webContents)).toBe(false);
    expect(manager.isComposerWebContents(orb().webContents)).toBe(false);

    manager.togglePanel();
    const panel = mocks.windows.at(-1)!;
    expect(manager.isComposerWebContents(panel.webContents)).toBe(true);
    expect(manager.isComposerWebContents(new BrowserWindow().webContents)).toBe(false);

    manager.hidePanel();
    panel.destroy();
    expect(manager.isComposerWebContents(panel.webContents)).toBe(false);
    manager.togglePanel();
    const recreated = mocks.windows.at(-1)!;
    expect(manager.isComposerWebContents(panel.webContents)).toBe(false);
    expect(manager.isComposerWebContents(recreated.webContents)).toBe(true);

    manager.dispose();
    expect(manager.isComposerWebContents(recreated.webContents)).toBe(false);
  });

  test('first open and reuse wait for the current composer frame instead of showing a cached frame', () => {
    create();
    manager.togglePanel();
    const panel = mocks.windows.at(-1);
    const show = vi.spyOn(panel, 'show');
    const focus = vi.spyOn(panel, 'focus');
    panel.emit('ready-to-show');
    expect(panel.visible).toBe(false);
    expect(readyPanel(panel)).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(readyPanel(panel)).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);

    manager.hidePanel();
    manager.togglePanel();
    expect(panel.visible).toBe(false);
    expect(readyPanel(panel)).toBe(true);
    expect(show).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalledTimes(2);
  });

  test('closing during preparation invalidates the old frame, including a rapid reopen', () => {
    create();
    manager.togglePanel();
    const panel = mocks.windows.at(-1);
    const previousOpening = manager.getState().panelOpenRevision;
    manager.hidePanel();
    expect(invoke(DesktopCompanionIpc.PanelReady, previousOpening, panel.webContents)).toBe(false);
    manager.togglePanel();
    expect(manager.getState().panelOpenRevision).toBeGreaterThan(previousOpening);
    expect(invoke(DesktopCompanionIpc.PanelReady, previousOpening, panel.webContents)).toBe(false);
    expect(panel.visible).toBe(false);
    // Delayed native notifications must not cancel the new preparation.
    panel.emit('hide');
    expect(manager.getState().panelVisible).toBe(true);
    expect(readyPanel(panel)).toBe(true);
  });

  test('only the current composer and opening can reveal the panel', () => {
    create();
    manager.togglePanel();
    const panel = mocks.windows.at(-1);
    const opening = manager.getState().panelOpenRevision;
    expect(invoke(DesktopCompanionIpc.PanelReady, opening, main.webContents)).toBe(false);
    for (const value of [null, undefined, true, String(opening), NaN, opening + 1]) {
      expect(invoke(DesktopCompanionIpc.PanelReady, value, panel.webContents)).toBe(false);
    }
    invoke(DesktopCompanionIpc.SetDraft, { prompt: 'Keep my draft', attachments: [] });
    expect(manager.getState().panelOpenRevision).toBe(opening);
    expect(panel.visible).toBe(false);
    expect(readyPanel(panel)).toBe(true);
  });

  test('hiding the panel flushes unsent materials and keeps the window alive', () => {
    create();
    manager.togglePanel();
    invoke(DesktopCompanionIpc.SetDraft, {
      prompt: 'Summarize this document',
      workingDirectory: '/tasks',
      attachments: [{ path: '/tasks/notes.pdf', name: 'notes.pdf' }],
    });
    manager.hidePanel();
    expect(values.get(DesktopCompanionStoreKey.Draft)).toMatchObject({
      prompt: 'Summarize this document', attachments: [{ path: '/tasks/notes.pdf' }],
    });
    expect(mocks.windows[1].destroyed).toBe(false);
  });

  test('clicking outside dismisses the panel and reopening reuses the draft and window', () => {
    vi.useFakeTimers();
    create();
    manager.togglePanel();
    const panel = mocks.windows[1];
    readyPanel(panel);
    invoke(DesktopCompanionIpc.SetDraft, { prompt: 'Keep my draft', attachments: [{ path: '/tmp/a.pdf', name: 'a.pdf' }] });
    panel.blur();
    vi.advanceTimersByTime(200);
    expect(manager.getState().panelVisible).toBe(false);
    expect(panel.visible).toBe(false);
    expect(values.get(DesktopCompanionStoreKey.Draft)).toMatchObject({ prompt: 'Keep my draft', attachments: [{ path: '/tmp/a.pdf' }] });
    manager.togglePanel();
    expect(mocks.windows).toHaveLength(2);
    readyPanel(panel);
    expect(panel.visible).toBe(true);
    expect(panel.focused).toBe(true);
  });

  test('a native file sheet keeps the panel open and outside dismissal resumes after it closes', () => {
    vi.useFakeTimers();
    create();
    manager.togglePanel();
    const panel = mocks.windows[1];
    readyPanel(panel);
    panel.blur();
    panel.emit('sheet-begin');
    vi.advanceTimersByTime(200);
    expect(manager.getState().panelVisible).toBe(true);
    panel.emit('sheet-end');
    panel.focus();
    panel.blur();
    vi.advanceTimersByTime(200);
    expect(manager.getState().panelVisible).toBe(false);
  });

  test('a native modal or a brief focus handoff does not dismiss the panel', () => {
    vi.useFakeTimers();
    create();
    manager.togglePanel();
    const panel = mocks.windows[1];
    readyPanel(panel);
    panel.enabled = false;
    panel.blur();
    vi.advanceTimersByTime(200);
    expect(manager.getState().panelVisible).toBe(true);
    panel.enabled = true;
    panel.focus();
    panel.blur();
    panel.focus();
    vi.advanceTimersByTime(200);
    expect(manager.getState().panelVisible).toBe(true);
    panel.blur();
    manager.hidePanel();
    manager.togglePanel();
    readyPanel(panel);
    vi.advanceTimersByTime(200);
    expect(manager.getState().panelVisible).toBe(true);
  });

  test('an occupied shortcut keeps the working shortcut and can still disable the companion', () => {
    create();
    manager.setPreferences({ enabled: true, shortcut: 'Alt+Space' });
    vi.mocked(globalShortcut.register).mockReturnValue(false);
    expect(manager.setPreferences({ shortcut: 'Control+J' }).success).toBe(false);
    expect(manager.getState().preferences.shortcut).toBe('Alt+Space');
    expect(globalShortcut.unregister).not.toHaveBeenCalled();
    expect(manager.setPreferences({ enabled: false }).success).toBe(true);
  });

  test('a shortcut occupied at startup does not prevent turning the companion off', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true, shortcut: 'Alt+Space' });
    vi.mocked(globalShortcut.register).mockReturnValue(false);
    create();
    expect(manager.getState().shortcutUnavailable).toBe(true);
    expect(manager.setPreferences({ enabled: false }).success).toBe(true);
    expect(manager.getState().preferences.enabled).toBe(false);
  });

  test('opening a result forwards the exact session and hides only the panel', () => {
    create();
    manager.togglePanel();
    invoke(DesktopCompanionIpc.OpenMain, 'task-123');
    expect(openMain).toHaveBeenCalledWith('task-123');
    expect(manager.getState().panelVisible).toBe(false);
  });

  test.each(Object.values(DesktopCompanionMainPage))('opening %s focuses the main window and queues its destination', page => {
    create();
    manager.togglePanel();
    const panel = mocks.windows.at(-1);
    invoke(DesktopCompanionIpc.OpenMainPage, page, panel.webContents);
    expect(openMain).toHaveBeenCalledWith(null);
    expect(manager.getState().panelVisible).toBe(false);
    expect(main.webContents.send).toHaveBeenCalledWith(DesktopCompanionIpc.MainPageRequested);
    // A companion window must not consume the main window's pending navigation.
    expect(invoke(DesktopCompanionIpc.ConsumeMainPage, undefined, panel.webContents)).toBeNull();
    expect(invoke(DesktopCompanionIpc.ConsumeMainPage)).toBe(page);
    expect(invoke(DesktopCompanionIpc.ConsumeMainPage)).toBeNull();
  });

  test('retains the latest page request until a recreated main renderer consumes it', () => {
    create();
    manager.togglePanel();
    const panel = mocks.windows.at(-1);
    main.destroy();
    invoke(DesktopCompanionIpc.OpenMainPage, DesktopCompanionMainPage.Skills, panel.webContents);
    invoke(DesktopCompanionIpc.OpenMainPage, DesktopCompanionMainPage.Kits, panel.webContents);
    main = new BrowserWindow();
    expect(invoke(DesktopCompanionIpc.ConsumeMainPage)).toBe(DesktopCompanionMainPage.Kits);
  });

  test.each([null, 42, 'unknown', { page: DesktopCompanionMainPage.Kits }])('ignores invalid page destination %j', value => {
    create();
    manager.togglePanel();
    invoke(DesktopCompanionIpc.OpenMainPage, value);
    expect(openMain).not.toHaveBeenCalled();
    expect(manager.getState().panelVisible).toBe(true);
    expect(invoke(DesktopCompanionIpc.ConsumeMainPage)).toBeNull();
  });

  test.each([33_890, 250_000])('copies all %i characters to the clipboard verbatim', length => {
    create();
    const prefix = ' \t\r\n完整内容 🦞';
    const suffix = '\r\n\t ';
    const text = prefix + 'x'.repeat(length - prefix.length - suffix.length) + suffix;
    expect(invoke(DesktopCompanionIpc.CopyText, text)).toEqual({ success: true });
    const copied = vi.mocked(clipboard.writeText).mock.calls.at(-1)?.[0];
    expect(copied?.length).toBe(length);
    expect(copied).toBe(text);
  });

  test('rejects oversized clipboard payloads without writing a truncated value', () => {
    create();
    const result = invoke(DesktopCompanionIpc.CopyText, '字'.repeat(Math.ceil(COMPANION_COPY_MAX_BYTES / 3)));
    expect(result).toEqual({ success: false, error: 'desktopCompanionCopyTooLarge' });
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  test.each([null, 42, { text: 'invalid' }])('rejects non-string clipboard payload %j', value => {
    create();
    expect(invoke(DesktopCompanionIpc.CopyText, value)).toEqual({ success: false, error: 'desktopCompanionCopyFailed' });
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  test('foreign windows and subframes cannot use companion channels', () => {
    create();
    for (const channel of [DesktopCompanionIpc.GetState, DesktopCompanionIpc.QuickAnswerStart, DesktopCompanionIpc.CopyText]) {
      const handler = mocks.handlers.get(channel)!;
      expect(() => handler({ sender: { id: -1 } })).toThrow();
      expect(() => handler({ sender: main.webContents, senderFrame: {} })).toThrow();
    }
  });

  test('shutdown unregisters only its own shortcut, listeners and monitors', () => {
    create();
    manager.setPreferences({ shortcut: 'Control+Shift+J' });
    manager.dispose();
    expect(globalShortcut.unregister).toHaveBeenCalledWith('Control+Shift+J');
    expect(screen.listenerCount('display-removed')).toBe(0);
    expect(foreground.listenerCount('change')).toBe(0);
    expect(fileDrag.listenerCount(FileDragEvent.Start)).toBe(0);
    expect(mocks.handlers.size).toBe(0);
  });
});

describe('orb surface toggle', () => {
  const press = () => emitDrag(DesktopCompanionDragPhase.Start, { x: 0.5, y: 0.5 });
  const release = () => {
    emitDrag(DesktopCompanionDragPhase.Cancel);
    invoke(DesktopCompanionIpc.ToggleOrb, true, orb().webContents);
  };

  test.each([null, CoworkSessionStatusValue.Running, CoworkSessionStatusValue.Completed])(
    'successive clicks open and close the right surface for %s tasks without changing read state', status => {
      values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
      if (status) values.set(COMPANION_RECENT_TASKS_KEY, [{ sessionId: 'task', viewedAt: 0 }]);
      create();
      if (status) getTaskInfo.mockImplementation(id => ({ id, title: 'Task', status, updatedAt: 1000 }));
      invoke(DesktopCompanionIpc.SetDraft, { prompt: 'Keep my draft', attachments: [] });

      for (let click = 0; click < 8; click += 1) {
        // No renderer state round trip between clicks, as with a rapid double-click.
        press();
        release();
        const visible = click % 2 === 0;
        expect(manager.getState()).toMatchObject({
          panelVisible: visible && !status,
          result: { visible: visible && !!status },
          draft: { prompt: 'Keep my draft' },
        });
        if (visible && !status) readyPanel();
        expect(mocks.windows.at(-1).visible).toBe(visible);
      }
      expect(manager.getState().result.recentTasks).toEqual(status ? [{ sessionId: 'task', viewedAt: 0 }] : []);
      expect(openMain).not.toHaveBeenCalled();
    },
  );

  test.each([false, true])('blur before release cannot reopen the surface (results: %s)', results => {
    vi.useFakeTimers();
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    if (results) values.set(COMPANION_RECENT_TASKS_KEY, [{ sessionId: 'task', viewedAt: 0 }]);
    create();
    invoke(DesktopCompanionIpc.ToggleOrb, undefined, orb().webContents);
    const surface = mocks.windows.at(-1);
    if (!results) readyPanel(surface);
    press();
    surface.blur();
    vi.advanceTimersByTime(200);
    // The pointer press began while the surface was open, before native blur dismissed it.
    release();
    expect(manager.getState()).toMatchObject({ panelVisible: false, result: { visible: false } });
    expect(surface.visible).toBe(false);
    invoke(DesktopCompanionIpc.ToggleOrb, undefined, orb().webContents);
    if (!results) readyPanel(surface);
    expect(surface.visible).toBe(true);
    press();
    surface.blur();
    release();
    invoke(DesktopCompanionIpc.ToggleOrb, undefined, orb().webContents);
    if (!results) readyPanel(surface);
    vi.advanceTimersByTime(200);
    expect(surface.visible).toBe(true);
  });

  test('a canceled pointer press cannot turn a later keyboard activation into a stale dismissal', () => {
    vi.useFakeTimers();
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    invoke(DesktopCompanionIpc.ToggleOrb, undefined, orb().webContents);
    readyPanel();
    press();
    emitDrag(DesktopCompanionDragPhase.Cancel);
    mocks.windows.at(-1).blur();
    vi.advanceTimersByTime(200);
    invoke(DesktopCompanionIpc.ToggleOrb, undefined, orb().webContents);
    expect(manager.getState().panelVisible).toBe(true);
  });

  test.each([false, true])('a delayed native hide event cannot dismiss a reopened surface (results: %s)', results => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    if (results) values.set(COMPANION_RECENT_TASKS_KEY, [{ sessionId: 'task', viewedAt: 0 }]);
    create();
    invoke(DesktopCompanionIpc.ToggleOrb, undefined, orb().webContents);
    const surface = mocks.windows.at(-1);
    press(); release();
    press(); release();
    surface.emit('hide');
    if (!results) readyPanel(surface);
    expect(surface.visible).toBe(true);
    expect(manager.getState()).toMatchObject({ panelVisible: !results, result: { visible: results } });
    surface.hide();
    expect(manager.getState()).toMatchObject({ panelVisible: false, result: { visible: false } });
  });

  test('closing takes priority over task changes and pinning', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    values.set(COMPANION_RECENT_TASKS_KEY, [{ sessionId: 'task', viewedAt: 1000 }]);
    create();
    invoke(DesktopCompanionIpc.ToggleOrb, undefined, orb().webContents);
    expect(manager.getState().panelVisible).toBe(true);
    getTaskInfo.mockImplementation(id => ({ id, title: 'Task', status: CoworkSessionStatusValue.Running, updatedAt: 2000 }));
    invoke(DesktopCompanionIpc.ToggleOrb, undefined, orb().webContents);
    expect(manager.getState()).toMatchObject({ panelVisible: false, result: { visible: false } });
    invoke(DesktopCompanionIpc.ToggleOrb, undefined, orb().webContents);
    const result = mocks.windows.at(-1);
    invoke(CompanionResultIpc.Pin, true, result.webContents);
    invoke(DesktopCompanionIpc.ToggleOrb, undefined, orb().webContents);
    expect(manager.getState().result.visible).toBe(false);
    expect(manager.getState().result.recentTasks).toEqual([{ sessionId: 'task', viewedAt: 1000 }]);
  });

  test('deleted or already read tasks fall back to the composer', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    values.set(COMPANION_RECENT_TASKS_KEY, [{ sessionId: 'deleted', viewedAt: 0 }, { sessionId: 'read', viewedAt: 1000 }]);
    create();
    getTaskInfo.mockImplementation(id => id === 'deleted' ? null : { id, title: 'Task', status: CoworkSessionStatusValue.Completed, updatedAt: 1000 });
    invoke(DesktopCompanionIpc.ToggleOrb, undefined, orb().webContents);
    expect(manager.getState()).toMatchObject({ panelVisible: true, result: { visible: false } });
  });

  test('orb toggle rejects foreign windows and child frames', () => {
    create();
    const foreign = new BrowserWindow();
    expect(() => invoke(DesktopCompanionIpc.ToggleOrb, undefined, foreign.webContents)).toThrow('Unknown desktop companion IPC sender');
    expect(() => mocks.handlers.get(DesktopCompanionIpc.ToggleOrb)!({ sender: main.webContents, senderFrame: {} }))
      .toThrow('Desktop companion IPC requires the main frame');
  });
});

describe('snoozing', () => {
  test('hiding for an hour removes the character and brings it back afterwards', () => {
    vi.useFakeTimers();
    create();
    manager.setPreferences({ enabled: true });
    manager.snoozeFor(DesktopCompanionSnoozeMode.Hidden);
    expect(orb().destroyed).toBe(true);
    expect(manager.getState().snooze?.mode).toBe(DesktopCompanionSnoozeMode.Hidden);
    expect(values.get(DesktopCompanionStoreKey.Snooze)).toMatchObject({ mode: DesktopCompanionSnoozeMode.Hidden });
    vi.advanceTimersByTime(60 * 60_000 + 1_000);
    expect(manager.getState().snooze).toBeNull();
    expect(mocks.windows.some(win => win !== main && !win.destroyed)).toBe(true);
  });

  test('a quiet day hides the character until the next local midnight', () => {
    vi.useFakeTimers();
    const start = new Date(2026, 9, 15, 10).getTime();
    const midnight = new Date(2026, 9, 16).getTime();
    vi.setSystemTime(start);
    create();
    manager.setPreferences({ enabled: true });
    orb().emit('ready-to-show');
    expect(orb().visible).toBe(true);
    const preferences = manager.getState().preferences;
    vi.mocked(foreground.stop).mockClear();
    vi.mocked(fileDrag.stop).mockClear();
    manager.snoozeFor(DesktopCompanionSnoozeMode.Quiet);
    expect(orb().destroyed).toBe(true);
    expect(manager.getState().preferences).toEqual(preferences);
    expect(manager.getState().snooze).toEqual({ mode: DesktopCompanionSnoozeMode.Quiet, until: midnight });
    expect(foreground.stop).toHaveBeenCalled();
    expect(fileDrag.stop).toHaveBeenCalled();
    vi.advanceTimersByTime(midnight - start - 1);
    expect(manager.getState().snooze).not.toBeNull();
    expect(mocks.windows.filter(win => win !== main && !win.destroyed)).toHaveLength(0);
    vi.advanceTimersByTime(1_001);
    expect(manager.getState().snooze).toBeNull();
    const restored = mocks.windows.at(-1);
    restored.emit('ready-to-show');
    expect(restored.visible).toBe(true);
  });

  test('a persisted quiet day stays hidden after relaunch and preference changes until woken', () => {
    const snooze = { mode: DesktopCompanionSnoozeMode.Quiet, until: Date.now() + DesktopCompanionTiming.SnoozeHourMs };
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    values.set(DesktopCompanionStoreKey.Snooze, snooze);
    create();
    expect(manager.getState().snooze).toEqual(snooze);
    expect(mocks.windows).toEqual([main]);
    manager.setPreferences({ skin: 'ruanruanxia' });
    expect(mocks.windows).toEqual([main]);
    manager.wake();
    expect(manager.getState().snooze).toBeNull();
    expect(values.get(DesktopCompanionStoreKey.Snooze)).toBeNull();
    expect(orb().destroyed).toBe(false);
  });

  test.each(Object.values(DesktopCompanionSnoozeMode))('an expired %s snooze from a previous launch is dropped', mode => {
    values.set(DesktopCompanionStoreKey.Snooze, { mode, until: Date.now() - 1_000 });
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    expect(manager.getState().snooze).toBeNull();
    expect(orb().destroyed).toBe(false);
  });
});

describe('stage: hints and drops', () => {
  test('accepting a mail hint pre-fills the habit as a prompt and opens the panel', () => {
    vi.useFakeTimers();
    const start = new Date(2026, 9, 6, 9, 0).getTime();
    vi.setSystemTime(start);
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    orb().emit('ready-to-show');
    vi.setSystemTime(start + CompanionHintRule.LaunchQuietMs + 1_000);
    foreground.emit('change', 'com.apple.mail');
    vi.advanceTimersByTime(CompanionHintRule.DwellMs + 500);
    expect(manager.getState().stage).toMatchObject({ kind: DesktopCompanionStageKind.Hint, topic: 'mail' });
    expect(manager.getState().foreground).toEqual({ appId: 'com.apple.mail', category: 'mail' });
    invoke(DesktopCompanionIpc.StageCommand, { type: DesktopCompanionStageCommandType.HintAccept });
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
    expect(manager.getState().panelVisible).toBe(true);
    expect(manager.getState().draft.prompt).toBe('desktopCompanionPromptMail');
    expect(values.get(DesktopCompanionStoreKey.HintLedger)).toMatchObject({ categories: { mail: { acceptedAt: expect.any(Number) } } });
  });

  test('ordinary desktop drags never open a window or replace the current task', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    manager.selectSession('current-task');
    const windowCount = mocks.windows.length;
    fileDrag.emit(FileDragEvent.Start, { paths: ['/tmp/方案.docx'] });
    expect(manager.getState().fileDragActive).toBe(true);
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
    expect(manager.getState().sessionId).toBe('current-task');
    expect(mocks.windows).toHaveLength(windowCount);
    fileDrag.emit(FileDragEvent.End);
    expect(manager.getState().fileDragActive).toBe(false);
    expect(mocks.windows).toHaveLength(windowCount);
  });

  test('hovering over the orb opens file actions, and dropping on "ask" attaches it in the panel', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    fileDrag.emit(FileDragEvent.Start, { paths: ['/tmp/方案.docx'] });
    expect(manager.getState().fileDragActive).toBe(true);
    dragOverOrb(DesktopCompanionFileDragPhase.Enter);
    expect(manager.getState().stage).toMatchObject({
      kind: DesktopCompanionStageKind.Drop,
      files: [{ name: '方案.docx', kind: CompanionFileKind.Document }],
      kinds: [CompanionFileKind.Document],
    });
    invoke(DesktopCompanionIpc.StageCommand, {
      type: DesktopCompanionStageCommandType.DropAsk,
      attachments: [{ path: '/tmp/方案.docx', name: '方案.docx' }, { path: '', name: 'bad' }],
    });
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
    expect(manager.getState().panelVisible).toBe(true);
    expect(manager.getState().draft.attachments).toEqual([{ path: '/tmp/方案.docx', name: '方案.docx', isImage: false, isDirectory: false }]);
  });

  test('a nearby file drag opens actions without enlarging the orb or needing its drag-enter event', () => {
    vi.useFakeTimers();
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    const bounds = { ...orb().bounds };
    vi.spyOn(screen, 'getCursorScreenPoint').mockReturnValue({ x: bounds.x - 40, y: bounds.y + bounds.height / 2 });
    fileDrag.emit(FileDragEvent.Start, { paths: ['/tmp/a.pdf'] });
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
    vi.advanceTimersByTime(DesktopCompanionTiming.DropExpandDelayMs + DesktopCompanionTiming.DropProximityPollMs);
    expect(manager.getState().stage).toMatchObject({ kind: DesktopCompanionStageKind.Drop, kinds: [CompanionFileKind.Pdf] });
    expect(orb().bounds).toEqual(bounds);
    // Leaving the small native window should not dismiss the larger proximity area.
    dragOverOrb(DesktopCompanionFileDragPhase.Leave);
    vi.advanceTimersByTime(DesktopCompanionTiming.DropLingerMs + 1);
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.Drop);
    vi.mocked(screen.getCursorScreenPoint).mockReturnValue({ x: bounds.x - 200, y: bounds.y });
    vi.advanceTimersByTime(DesktopCompanionTiming.DropProximityPollMs + DesktopCompanionTiming.DropLingerMs + 1);
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
  });

  test('a file released nearby before dwelling does not open actions later', () => {
    vi.useFakeTimers();
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    const bounds = orb().bounds;
    vi.spyOn(screen, 'getCursorScreenPoint').mockReturnValue({ x: bounds.x - 40, y: bounds.y + bounds.height / 2 });
    fileDrag.emit(FileDragEvent.Start, { paths: ['/tmp/a.pdf'] });
    fileDrag.emit(FileDragEvent.End);
    vi.advanceTimersByTime(DesktopCompanionTiming.DropExpandDelayMs * 3);
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
  });

  test('ignores drags of things that are not documents', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    fileDrag.emit(FileDragEvent.Start, { paths: ['/tmp/does-not-exist/archive.zip'] });
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
    expect(manager.getState().fileDragActive).toBe(false);
  });

  test('a drag that ends elsewhere closes the drop zone after a short linger', () => {
    vi.useFakeTimers();
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    fileDrag.emit(FileDragEvent.Start, { paths: [] });
    dragOverOrb(DesktopCompanionFileDragPhase.Enter);
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.Drop);
    fileDrag.emit(FileDragEvent.End);
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.Drop);
    vi.advanceTimersByTime(DesktopCompanionTiming.DropLingerMs + 1);
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
  });

  test('leaving the orb dismisses actions while a desktop drag is still in progress', () => {
    vi.useFakeTimers();
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    fileDrag.emit(FileDragEvent.Start, { paths: ['/tmp/a.pdf'] });
    dragOverOrb(DesktopCompanionFileDragPhase.Enter);
    dragOverOrb(DesktopCompanionFileDragPhase.Leave);
    vi.advanceTimersByTime(DesktopCompanionTiming.DropLingerMs + 1);
    expect(manager.getState().fileDragActive).toBe(true);
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
  });

  test('moving from the orb to an action keeps the strip in place until the pointer leaves', () => {
    vi.useFakeTimers();
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    dragOverOrb(DesktopCompanionFileDragPhase.Enter, [CompanionFileKind.Image]);
    const stage = manager.getState().stage;
    const bounds = { ...mocks.windows.at(-1).bounds };
    dragOverOrb(DesktopCompanionFileDragPhase.Leave);
    invoke(DesktopCompanionIpc.StageCommand, { type: DesktopCompanionStageCommandType.StageHover, hovering: true });
    vi.advanceTimersByTime(DesktopCompanionTiming.DropLingerMs + 1);
    expect(manager.getState().stage).toEqual(stage);
    expect(mocks.windows.at(-1).bounds).toEqual(bounds);
    invoke(DesktopCompanionIpc.StageCommand, { type: DesktopCompanionStageCommandType.StageHover, hovering: false });
    vi.advanceTimersByTime(DesktopCompanionTiming.DropLingerMs + 1);
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
  });

  test('a later drag without native paths uses hover types and does not reuse the previous filename', () => {
    vi.useFakeTimers();
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    fileDrag.emit(FileDragEvent.Start, { paths: ['/tmp/a.pdf'] });
    dragOverOrb(DesktopCompanionFileDragPhase.Enter);
    fileDrag.emit(FileDragEvent.End);
    vi.advanceTimersByTime(DesktopCompanionTiming.DropLingerMs + 1);
    dragOverOrb(DesktopCompanionFileDragPhase.Enter, [CompanionFileKind.Image]);
    expect(manager.getState().stage).toMatchObject({ files: [], kinds: [CompanionFileKind.Image] });
  });

  test('turning off drag assistance immediately dismisses an open strip', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    fileDrag.emit(FileDragEvent.Start, { paths: ['/tmp/a.pdf'] });
    dragOverOrb(DesktopCompanionFileDragPhase.Enter);
    manager.setPreferences({ dragAssist: false });
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
    expect(manager.getState().fileDragActive).toBe(false);
    dragOverOrb(DesktopCompanionFileDragPhase.Enter);
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
  });

  test('quiet mode keeps file hovers from opening actions', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    manager.snoozeFor(DesktopCompanionSnoozeMode.Quiet);
    dragOverOrb(DesktopCompanionFileDragPhase.Enter);
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
  });

  test('a task started from the drop zone becomes the companion task', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    fileDrag.emit(FileDragEvent.Start, { paths: ['/tmp/a.pdf'] });
    dragOverOrb(DesktopCompanionFileDragPhase.Enter);
    invoke(DesktopCompanionIpc.StageCommand, { type: DesktopCompanionStageCommandType.DropStarted, sessionId: 'session-9' });
    expect(manager.getState().sessionId).toBe('session-9');
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
    expect(manager.getState().result).toMatchObject({ visible: true });
    expect(manager.getState().result.recentTasks[0].sessionId).toBe('session-9');
  });

  test('a task sent from the composer shows an inactive bubble which opens its task in the main window', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    values.set(DesktopCompanionStoreKey.Position, { x: 1200, y: 750 });
    create();
    manager.togglePanel();
    const panel = mocks.windows.at(-1);
    // The composer keeps room above its card for menus, and its bottom stays put as the card grows.
    expect(panel.bounds.height).toBe(DesktopCompanionSize.PanelCompactHeight + DesktopCompanionSize.ComposerMenuRoom);
    const bottom = panel.bounds.y + panel.bounds.height;
    const cardWidth = DesktopCompanionSize.Composer.width + DesktopCompanionSize.SurfacePad * 2;
    ipcMain.emit(DesktopCompanionIpc.ResizeSurface, { sender: panel.webContents, senderFrame: panel.webContents.mainFrame }, { width: cardWidth, height: 250 });
    expect(panel.bounds.height).toBe(250 + DesktopCompanionSize.ComposerMenuRoom);
    expect(panel.bounds.y + panel.bounds.height).toBe(bottom);
    // Only the composer can hand over a task.
    invoke(DesktopCompanionIpc.TaskStarted, 'session-7');
    expect(manager.getState().sessionId).toBeNull();
    invoke(DesktopCompanionIpc.TaskStarted, 'session-7', panel.webContents);
    expect(manager.getState().panelVisible).toBe(false);
    expect(manager.getState().sessionId).toBe('session-7');
    const result = mocks.windows.at(-1);
    expect(manager.getState().result).toMatchObject({ visible: true });
    expect(result.focused).toBe(false);
    expect(result.focusable).toBe(false);
    const windowCount = mocks.windows.length;
    invoke(CompanionResultIpc.Open, 'session-7', result.webContents);
    expect(openMain).toHaveBeenCalledExactlyOnceWith('session-7');
    expect(manager.getState().sessionId).toBe('session-7');
    expect(manager.getState().result.visible).toBe(false);
    expect(manager.getState().result.recentTasks).toEqual([{ sessionId: 'session-7', viewedAt: 0 }]);
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
    expect(result.visible).toBe(false);
    expect(result.focused).toBe(false);
    expect(result.focusable).toBe(false);
    invoke(CompanionResultIpc.Open, undefined, result.webContents);
    expect(manager.getState().result).toMatchObject({ visible: true });
    expect(result.focusable).toBe(true);
    expect(result.focused).toBe(true);
    expect(mocks.windows).toHaveLength(windowCount);
  });

  test('the login dialog keeps its own size and closing it restores the current composer size', () => {
    create();
    manager.togglePanel();
    const panel = mocks.windows.at(-1);
    const event = { sender: panel.webContents, senderFrame: panel.webContents.mainFrame };
    const cardWidth = DesktopCompanionSize.Composer.width + DesktopCompanionSize.SurfacePad * 2;
    ipcMain.emit(DesktopCompanionIpc.PanelLoginVisible, event, true);
    expect(panel.bounds).toMatchObject(DesktopCompanionSize.ComposerLogin);
    ipcMain.emit(DesktopCompanionIpc.ResizeSurface, event, { width: cardWidth, height: 144 });
    expect(panel.bounds).toMatchObject(DesktopCompanionSize.ComposerLogin);
    manager.hidePanel();
    manager.togglePanel();
    expect(panel.bounds).toMatchObject(DesktopCompanionSize.ComposerLogin);
    ipcMain.emit(DesktopCompanionIpc.PanelLoginVisible, event, false);
    expect(panel.bounds.height).toBe(144 + DesktopCompanionSize.ComposerMenuRoom);
    expect(panel.bounds.width).toBe(cardWidth + DesktopCompanionSize.ComposerSideRoom);
  });

  test.each([{ x: 0, y: 0 }, { x: 1196, y: 0 }, { x: 1196, y: 816 }, { x: 600, y: 0 }, { x: 600, y: 816 }])(
    'the login dialog preserves its spacing at screen edge $x, $y', position => {
      values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
      values.set(DesktopCompanionStoreKey.Position, position);
      create();
      manager.togglePanel();
      const panel = mocks.windows.at(-1);
      ipcMain.emit(DesktopCompanionIpc.PanelLoginVisible,
        { sender: panel.webContents, senderFrame: panel.webContents.mainFrame }, true);
      expect(panel.bounds).toMatchObject(DesktopCompanionSize.ComposerLogin);
      expect(panel.bounds.x).toBeGreaterThanOrEqual(0);
      expect(panel.bounds.y).toBeGreaterThanOrEqual(0);
      expect(panel.bounds.x + panel.bounds.width).toBeLessThanOrEqual(1280);
      expect(panel.bounds.y + panel.bounds.height).toBeLessThanOrEqual(900);
      const anchor = orb().getBounds();
      const bounds = panel.getBounds();
      const gap = DesktopCompanionSize.Gap;
      expect(bounds.x + bounds.width <= anchor.x - gap
        || bounds.x >= anchor.x + anchor.width + gap
        || bounds.y + bounds.height <= anchor.y - gap
        || bounds.y >= anchor.y + anchor.height + gap).toBe(true);
    },
  );

  test('only a valid login visibility update from the panel changes its size', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    manager.togglePanel();
    const panel = mocks.windows.at(-1);
    const initialBounds = { ...panel.bounds };
    const event = { sender: panel.webContents, senderFrame: panel.webContents.mainFrame };
    ipcMain.emit(DesktopCompanionIpc.PanelLoginVisible,
      { sender: orb().webContents, senderFrame: orb().webContents.mainFrame }, true);
    ipcMain.emit(DesktopCompanionIpc.PanelLoginVisible, { ...event, senderFrame: {} }, true);
    ipcMain.emit(DesktopCompanionIpc.PanelLoginVisible, event, 'true');
    expect(panel.bounds).toEqual(initialBounds);
    ipcMain.emit(DesktopCompanionIpc.PanelLoginVisible, event, true);
    expect(panel.bounds).toMatchObject(DesktopCompanionSize.ComposerLogin);
    panel.destroy();
    manager.hidePanel();
    manager.togglePanel();
    expect(mocks.windows.at(-1).bounds).toEqual(initialBounds);
  });

  test('recent tasks survive reopening and manager restart without enabling the orb', () => {
    create();
    manager.togglePanel();
    const panel = mocks.windows.at(-1);
    invoke(DesktopCompanionIpc.TaskStarted, 'first', panel.webContents);
    invoke(DesktopCompanionIpc.TaskStarted, 'second', panel.webContents);
    invoke(CompanionResultIpc.Open, 'first');
    expect(manager.getState().preferences.enabled).toBe(false);
    expect(openMain).toHaveBeenCalledExactlyOnceWith('first');
    manager.markSessionViewed('first');
    manager.dispose();
    create();
    expect(manager.getState().result.recentTasks).toEqual([
      { sessionId: 'second', viewedAt: 0 }, { sessionId: 'first', viewedAt: 1000 },
    ]);
    invoke(CompanionResultIpc.Open);
    expect(manager.getState().result).toMatchObject({ visible: true });
    expect(invoke(CompanionResultIpc.Recent).map((task: CompanionTaskInfo) => task.id)).toEqual(['second']);
  });

  test('opening a task waits for the main-window read before dismissing its unread result permanently', () => {
    values.set(DesktopCompanionStoreKey.Session, 'task');
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    invoke(CompanionResultIpc.Open);
    const result = mocks.windows.at(-1);
    invoke(CompanionResultIpc.Open, 'task', result.webContents);
    expect(openMain).toHaveBeenCalledExactlyOnceWith('task');
    expect(manager.getState().result.visible).toBe(false);
    expect(invoke(CompanionResultIpc.Recent)).toHaveLength(1);

    manager.markSessionViewed('task');
    expect(invoke(CompanionResultIpc.Recent)).toEqual([]);
    ipcMain.emit(DesktopCompanionIpc.TaskUpdated, { sender: orb().webContents, senderFrame: orb().webContents.mainFrame });
    expect(manager.getState().result.visible).toBe(false);
    manager.dispose();
    create();
    invoke(CompanionResultIpc.Open);
    expect(manager.getState().result.visible).toBe(false);
    expect(invoke(CompanionResultIpc.Recent)).toEqual([]);
  });

  test.each([CoworkSessionStatusValue.Running, CoworkSessionStatusValue.Completed])('closing a %s card removes only its floating record and keeps other cards open', status => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    values.set(DesktopCompanionStoreKey.Session, 'closed');
    values.set(COMPANION_RECENT_TASKS_KEY, [{ sessionId: 'closed', viewedAt: 0 }, { sessionId: 'keep', viewedAt: 0 }]);
    create();
    getTaskInfo.mockImplementation(id => ({ id, title: id, status, updatedAt: 1000 }));
    invoke(CompanionResultIpc.Open);
    const result = mocks.windows.at(-1);
    invoke(CompanionResultIpc.Dismiss, 'closed', result.webContents);

    expect(invoke(CompanionResultIpc.Recent).map((task: CompanionTaskInfo) => task.id)).toEqual(['keep']);
    expect(values.get(COMPANION_RECENT_TASKS_KEY)).toEqual([{ sessionId: 'keep', viewedAt: 0 }]);
    expect(manager.getState().result.visible).toBe(true);
    expect(result.visible).toBe(true);
    expect(manager.getState().sessionId).toBe('closed');
    expect(getTaskInfo('closed')?.status).toBe(status);
    expect(openMain).not.toHaveBeenCalled();

    // Later task updates, reopening the list and restarting must not restore the closed card.
    ipcMain.emit(DesktopCompanionIpc.TaskUpdated, { sender: orb().webContents, senderFrame: orb().webContents.mainFrame });
    invoke(CompanionResultIpc.Hide, undefined, result.webContents);
    invoke(CompanionResultIpc.Open);
    expect(invoke(CompanionResultIpc.Recent).map((task: CompanionTaskInfo) => task.id)).toEqual(['keep']);
    manager.dispose();
    create();
    expect(manager.getState().result.recentTasks).toEqual([{ sessionId: 'keep', viewedAt: 0 }]);
  });

  test('closing the last card hides the empty surface without migrating the old task back after restart', () => {
    values.set(DesktopCompanionStoreKey.Session, 'last');
    create();
    invoke(CompanionResultIpc.Open);
    const result = mocks.windows.at(-1);
    invoke(CompanionResultIpc.Dismiss, 'last', result.webContents);
    expect(manager.getState().result).toMatchObject({ visible: false, recentTasks: [] });
    expect(values.get(COMPANION_RECENT_TASKS_KEY)).toEqual([]);
    expect(result.visible).toBe(false);
    expect(getTaskInfo('last')).not.toBeNull();
    manager.dispose();
    create();
    invoke(CompanionResultIpc.Open);
    expect(manager.getState().result).toMatchObject({ visible: false, recentTasks: [] });
  });

  test('invalid or repeated dismissals leave the other floating records unchanged', () => {
    values.set(COMPANION_RECENT_TASKS_KEY, [{ sessionId: 'keep', viewedAt: 0 }]);
    create();
    invoke(CompanionResultIpc.Open);
    const result = mocks.windows.at(-1);
    for (const id of ['already-closed', '', null, 42, {}]) invoke(CompanionResultIpc.Dismiss, id, result.webContents);
    expect(manager.getState().result).toMatchObject({ visible: true, recentTasks: [{ sessionId: 'keep', viewedAt: 0 }] });
  });

  test('a newly running turn and its unread completion reappear after an earlier result was read', () => {
    values.set(COMPANION_RECENT_TASKS_KEY, [{ sessionId: 'task', viewedAt: 1000 }]);
    create();
    expect(invoke(CompanionResultIpc.Recent)).toEqual([]);
    getTaskInfo.mockReturnValue({ id: 'task', title: 'Task', status: CoworkSessionStatusValue.Running, updatedAt: 1000 });
    expect(invoke(CompanionResultIpc.Recent)).toHaveLength(1);
    getTaskInfo.mockReturnValue({ id: 'task', title: 'Task', status: CoworkSessionStatusValue.Completed, updatedAt: 2000 });
    expect(invoke(CompanionResultIpc.Recent)).toMatchObject([{ id: 'task', viewedAt: 1000, updatedAt: 2000 }]);
  });

  test('reading in the main window removes the result and hides an empty activity card', () => {
    values.set(COMPANION_RECENT_TASKS_KEY, [{ sessionId: 'task', viewedAt: 0 }, { sessionId: 'running', viewedAt: 0 }]);
    create();
    getTaskInfo.mockImplementation(id => ({ id, title: id, updatedAt: 1000,
      status: id === 'running' ? CoworkSessionStatusValue.Running : CoworkSessionStatusValue.Completed }));
    invoke(CompanionResultIpc.Open);
    manager.markSessionViewed('task');
    manager.markSessionViewed('running');
    expect(invoke(CompanionResultIpc.Recent).map((task: CompanionTaskInfo) => task.id)).toEqual(['running']);
    expect(manager.getState().result.visible).toBe(true);
    getTaskInfo.mockImplementation(id => ({ id, title: id, updatedAt: 2000, status: CoworkSessionStatusValue.Completed }));
    manager.markSessionViewed('task');
    manager.markSessionViewed('running');
    expect(manager.getState().result.visible).toBe(false);
    expect(invoke(CompanionResultIpc.Recent)).toEqual([]);
  });

  test('keeps the activity list compact when a task opens in the main window', () => {
    values.set(COMPANION_RECENT_TASKS_KEY, [{ sessionId: 'first', viewedAt: 0 }, { sessionId: 'second', viewedAt: 0 }]);
    create();
    invoke(CompanionResultIpc.Open);
    const result = mocks.windows.at(-1);
    expect(result.bounds.width).toBe(DesktopCompanionSize.ResultCompactWidth);
    invoke(CompanionResultIpc.Open, 'first', result.webContents);
    expect(openMain).toHaveBeenCalledExactlyOnceWith('first');
    expect(result.visible).toBe(false);
    expect(result.bounds.width).toBe(DesktopCompanionSize.ResultCompactWidth);
    manager.markSessionViewed('first');
    invoke(CompanionResultIpc.Open, undefined, result.webContents);
    expect(result.bounds.width).toBe(DesktopCompanionSize.ResultCompactWidth);
    expect(invoke(CompanionResultIpc.Recent).map((task: CompanionTaskInfo) => task.id)).toEqual(['second']);
    ipcMain.emit(DesktopCompanionIpc.ResizeSurface, { sender: result.webContents, senderFrame: result.webContents.mainFrame }, { width: 900, height: 170 });
    expect(result.bounds.width).toBe(DesktopCompanionSize.ResultCompactWidth);
  });

  test('recent tasks are bounded, deduplicated, and remove deleted sessions', () => {
    create();
    manager.togglePanel();
    const panel = mocks.windows.at(-1);
    for (let index = 0; index < COMPANION_RECENT_TASK_LIMIT + 2; index++) {
      invoke(DesktopCompanionIpc.TaskStarted, `session-${index}`, panel.webContents);
    }
    invoke(DesktopCompanionIpc.TaskStarted, 'session-5', panel.webContents);
    expect(manager.getState().result.recentTasks).toHaveLength(COMPANION_RECENT_TASK_LIMIT);
    expect(manager.getState().result.recentTasks[0].sessionId).toBe('session-5');
    getTaskInfo.mockImplementation(id => id === 'session-5' ? null : { id, title: id, status: 'completed', updatedAt: 1000 });
    expect(invoke(CompanionResultIpc.Recent)).toHaveLength(COMPANION_RECENT_TASK_LIMIT - 1);
    expect(values.get(COMPANION_RECENT_TASKS_KEY)).not.toContainEqual({ sessionId: 'session-5', viewedAt: 0 });
    invoke(CompanionResultIpc.Open, 'not-recorded');
    expect(manager.getState().result.visible).toBe(false);
  });

  test('migrates the previously followed task and keeps new results unread until the main window reads them', () => {
    values.set(DesktopCompanionStoreKey.Session, 'previous');
    create();
    expect(manager.getState().result.recentTasks).toEqual([{ sessionId: 'previous', viewedAt: 0 }]);
    invoke(CompanionResultIpc.Open, 'previous');
    expect(manager.getState().result.recentTasks[0].viewedAt).toBe(0);
    manager.markSessionViewed('previous');
    expect(manager.getState().result.recentTasks[0].viewedAt).toBe(1000);
    getTaskInfo.mockReturnValue({ id: 'previous', title: 'Previous', status: CoworkSessionStatusValue.Completed, updatedAt: 2000 });
    invoke(CompanionResultIpc.Open, 'previous');
    manager.markSessionViewed('another');
    expect(invoke(CompanionResultIpc.Recent)).toMatchObject([{ id: 'previous', viewedAt: 1000, updatedAt: 2000 }]);
    manager.markSessionViewed('previous');
    expect(manager.getState().result.recentTasks[0].viewedAt).toBe(2000);
  });

  test.each(Object.values(CoworkSessionStatusValue))('opens the clicked %s task instead of the currently followed task', status => {
    values.set(DesktopCompanionStoreKey.Session, 'latest');
    values.set(COMPANION_RECENT_TASKS_KEY, [{ sessionId: 'latest', viewedAt: 0 }, { sessionId: 'clicked', viewedAt: 0 }]);
    create();
    getTaskInfo.mockImplementation(id => ({ id, title: id, status, updatedAt: 1000 }));
    manager.togglePanel();
    const panel = mocks.windows.at(-1);
    invoke(CompanionResultIpc.Open);
    const result = mocks.windows.at(-1);
    const windowCount = mocks.windows.length;
    invoke(CompanionResultIpc.Open, 'clicked', result.webContents);
    expect(openMain).toHaveBeenCalledExactlyOnceWith('clicked');
    expect(manager.getState().sessionId).toBe('latest');
    expect(manager.getState().result.visible).toBe(false);
    expect(panel.visible).toBe(false);
    expect(result.visible).toBe(false);
    expect(mocks.windows).toHaveLength(windowCount);
    expect(manager.getState().result.recentTasks).toHaveLength(2);
  });

  test('another task finishing keeps the compact task list without opening the main window', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    values.set(COMPANION_RECENT_TASKS_KEY, [{ sessionId: 'first', viewedAt: 0 }, { sessionId: 'second', viewedAt: 0 }]);
    values.set(DesktopCompanionStoreKey.Session, 'second');
    create();
    invoke(CompanionResultIpc.Open);
    const result = mocks.windows.at(-1);
    invoke(CompanionResultIpc.Pin, true, result.webContents);
    ipcMain.emit(DesktopCompanionIpc.TaskUpdated, { sender: orb().webContents, senderFrame: orb().webContents.mainFrame });
    expect(manager.getState().result).toMatchObject({ visible: true, pinned: true });
    expect(openMain).not.toHaveBeenCalled();
  });

  test('task news stays quiet when the pet is snoozed', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    values.set(DesktopCompanionStoreKey.Session, 'task');
    create();
    clickMenu('desktopCompanionSnoozeToday');
    ipcMain.emit(DesktopCompanionIpc.TaskUpdated, { sender: orb().webContents, senderFrame: orb().webContents.mainFrame });
    expect(manager.getState().result.visible).toBe(false);
    expect(manager.getState().result.recentTasks).toEqual([{ sessionId: 'task', viewedAt: 0 }]);
  });

  test('result pin, click-through and window bounds remain usable on repeated opens', () => {
    vi.useFakeTimers();
    values.set(DesktopCompanionStoreKey.Session, 'task');
    create();
    invoke(CompanionResultIpc.Open);
    const result = mocks.windows.at(-1);
    expect(result.ignoreMouse).toBe(false);
    invoke(CompanionResultIpc.PassThrough, false, result.webContents);
    invoke(CompanionResultIpc.Open);
    expect(result.ignoreMouse).toBe(false);
    invoke(CompanionResultIpc.Pin, true, result.webContents);
    result.blur();
    vi.advanceTimersByTime(150);
    expect(manager.getState().result.visible).toBe(true);
    ipcMain.emit(DesktopCompanionIpc.ResizeSurface, { sender: result.webContents, senderFrame: result.webContents.mainFrame }, { width: 9999, height: 9999 });
    expect(result.bounds.width).toBe(DesktopCompanionSize.ResultCompactWidth);
    expect(result.bounds.height).toBe(DesktopCompanionSize.Result.height);
    expect(result.bounds.x).toBeGreaterThanOrEqual(0);
    expect(result.bounds.y + result.bounds.height).toBeLessThanOrEqual(900);
    invoke(CompanionResultIpc.Pin, false, result.webContents);
    result.blur();
    vi.advanceTimersByTime(150);
    expect(manager.getState().result.visible).toBe(false);
    invoke(CompanionResultIpc.Open);
    expect(result.ignoreMouse).toBe(false);
    result.emit('will-move');
    expect(manager.getState().result.pinned).toBe(true);
    expect(mocks.windows.at(-1)).toBe(result);
  });

  test('ignores invalid or deleted task shortcuts without opening a window', () => {
    values.set(COMPANION_RECENT_TASKS_KEY, [{ sessionId: 'deleted', viewedAt: 0 }]);
    create();
    getTaskInfo.mockReturnValue(null);
    const windowCount = mocks.windows.length;
    for (const id of ['deleted', 'not-recorded', '', null, 42, {}]) invoke(CompanionResultIpc.Open, id);
    expect(openMain).not.toHaveBeenCalled();
    expect(manager.getState().result.visible).toBe(false);
    expect(manager.getState().result.recentTasks).toEqual([]);
    expect(mocks.windows).toHaveLength(windowCount);
  });

  test('result IPC rejects foreign windows, child frames, and result-only commands from main', () => {
    create();
    const unknown = new BrowserWindow();
    expect(() => invoke(CompanionResultIpc.Open, undefined, unknown.webContents)).toThrow('Unknown desktop companion IPC sender');
    expect(() => invoke(CompanionResultIpc.Pin, true)).toThrow('Invalid companion result IPC sender');
    expect(() => invoke(CompanionResultIpc.Dismiss, 'task')).toThrow('Invalid companion result IPC sender');
    expect(() => invoke(CompanionResultIpc.Dismiss, 'task', unknown.webContents)).toThrow('Unknown desktop companion IPC sender');
    expect(() => mocks.handlers.get(CompanionResultIpc.Recent)!({ sender: main.webContents, senderFrame: {} })).toThrow('Invalid companion result IPC sender');
  });

  test('the composer card sits beside the orb and moves to its other side when the orb crosses the screen', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    manager.togglePanel();
    const panel = mocks.windows.at(-1);
    const pad = DesktopCompanionSize.SurfacePad;
    const cardWidth = DesktopCompanionSize.Composer.width + pad * 2;
    // The orb starts in the lower right, so the card opens to its left, with room further left for submenus.
    expect(manager.getState().panelPlacement).toBe(DesktopCompanionPanelPlacement.Left);
    expect(panel.bounds.x + panel.bounds.width - pad).toBe(orb().bounds.x);
    expect(panel.bounds.width).toBe(cardWidth + DesktopCompanionSize.ComposerSideRoom);
    const drag = (phase: DesktopCompanionDragPhase, x: number) => {
      vi.spyOn(screen, 'getCursorScreenPoint').mockReturnValue({ x, y: 800 });
      emitDrag(phase);
    };
    drag(DesktopCompanionDragPhase.Start, 1200);
    drag(DesktopCompanionDragPhase.Move, 200);
    // Mid-drag the composer hears about the flip, since its card moves within the window.
    expect(manager.getState().panelPlacement).toBe(DesktopCompanionPanelPlacement.Right);
    expect(main.webContents.send).toHaveBeenLastCalledWith(
      DesktopCompanionIpc.Changed,
      expect.objectContaining({ panelPlacement: DesktopCompanionPanelPlacement.Right }),
    );
    expect(panel.bounds.x + pad).toBe(orb().bounds.x + orb().bounds.width);
    drag(DesktopCompanionDragPhase.End, 200);
    vi.mocked(screen.getCursorScreenPoint).mockRestore();
  });

  test('task news restores compact bubbles without taking focus or covering the composer', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    manager.togglePanel();
    const panel = mocks.windows.at(-1);
    invoke(DesktopCompanionIpc.TaskStarted, 'session-8', panel.webContents);
    const result = mocks.windows.at(-1);
    invoke(CompanionResultIpc.Hide, undefined, result.webContents);
    expect(manager.getState().result.visible).toBe(false);
    ipcMain.emit(DesktopCompanionIpc.TaskUpdated, { sender: orb().webContents, senderFrame: orb().webContents.mainFrame });
    expect(manager.getState().result).toMatchObject({ visible: true });
    expect(result.focused).toBe(false);
    ipcMain.emit(DesktopCompanionIpc.PanelPassThrough, { sender: orb().webContents, senderFrame: orb().webContents.mainFrame }, true);
    expect(panel.ignoreMouse).toBe(false);
    ipcMain.emit(DesktopCompanionIpc.PanelPassThrough, { sender: panel.webContents, senderFrame: panel.webContents.mainFrame }, true);
    expect(panel.ignoreMouse).toBe(true);
    // Opening the composer again starts fully clickable, and its strip steps aside.
    manager.togglePanel();
    expect(panel.ignoreMouse).toBe(false);
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
    expect(manager.getState().result.visible).toBe(false);
    ipcMain.emit(DesktopCompanionIpc.TaskUpdated, { sender: orb().webContents, senderFrame: orb().webContents.mainFrame });
    expect(manager.getState().panelVisible).toBe(true);
    expect(manager.getState().result.visible).toBe(false);
  });

  test('macOS task bubbles stay visible after submission and reappear on completion without focus', () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    getTaskInfo.mockReturnValue({ id: 'task', title: 'Task', status: CoworkSessionStatusValue.Running, updatedAt: 1000 });
    manager.togglePanel();
    const panel = mocks.windows.at(-1);
    readyPanel(panel);
    invoke(DesktopCompanionIpc.TaskStarted, 'task', panel.webContents);
    const result = mocks.windows.at(-1);
    vi.advanceTimersByTime(5_000);
    expect(manager.getState()).toMatchObject({ panelVisible: false, result: { visible: true } });
    expect(result).toMatchObject({ visible: true, focused: false, focusable: false });

    // Open a follow-up, then close it by clicking outside before the task finishes.
    invoke(CompanionResultIpc.Open, undefined, result.webContents);
    expect(result.focused).toBe(true);
    result.blur();
    vi.advanceTimersByTime(300);
    expect(manager.getState().result.visible).toBe(false);
    getTaskInfo.mockReturnValue({ id: 'task', title: 'Task', status: CoworkSessionStatusValue.Completed, updatedAt: 2000 });
    ipcMain.emit(DesktopCompanionIpc.TaskUpdated, { sender: orb().webContents, senderFrame: orb().webContents.mainFrame });
    vi.advanceTimersByTime(5_000);
    expect(manager.getState().result.visible).toBe(true);
    expect(result).toMatchObject({ visible: true, focused: false, focusable: false });
    expect(invoke(CompanionResultIpc.Recent)).toMatchObject([{ id: 'task', status: CoworkSessionStatusValue.Completed }]);
    expect(openMain).not.toHaveBeenCalled();
  });

  test('LobsterAI itself coming to the front keeps the context of the app the user came from', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    foreground.emit('change', 'com.microsoft.Excel');
    foreground.emit('change', 'com.lobsterai.app');
    expect(manager.getState().foreground).toEqual({ appId: 'com.microsoft.Excel', category: 'spreadsheet' });
  });

  test('drag detection and drops stay off when the drop zone is disabled', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true, dragAssist: false });
    create();
    expect(fileDrag.start).not.toHaveBeenCalled();
    fileDrag.emit(FileDragEvent.Start, { paths: ['/tmp/a.pdf'] });
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
  });
});

describe('sign-in from a companion card', () => {
  const journeyId = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const events = (interactionType: string) => reportAnalytics.mock.calls.map(([event]) => event)
    .filter(event => event.interactionType === interactionType);

  function openTranslation() {
    invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Translate, text: 'Selected words' });
    const window = mocks.windows[1];
    window.focus();
    return window;
  }

  test('a translation card stays through the browser, survives the login reset and reopens with its follow-up', () => {
    create();
    const window = openTranslation();
    const firstInput = invoke(LanguageToolsIpc.GetInput, undefined, window.webContents);
    reportAnalytics.mockClear();
    invoke(DesktopCompanionIpc.LoginStart, { tool: 'ask', journeyId,
      resume: { question: '  Which tense is this?  ', targetLanguage: TranslationTarget.English } }, window.webContents);
    expect(window.webContents.send).toHaveBeenCalledWith(LanguageToolsIpc.Pinned, true);
    expect(events(Interaction.LoginClick)).toEqual([expect.objectContaining({
      action: AnalyticsAction.Action, source: AnalyticsSource.LanguageTools, tool: 'ask', journeyId,
    })]);
    // The browser takes focus; the pinned card stays.
    window.blur();
    expect(window.visible).toBe(true);
    // The exchange resets language tools before the companion hears about the login.
    manager.resetLanguageTools();
    expect(window.visible).toBe(false);
    manager.handleLoginSucceeded();
    expect(window.visible).toBe(true);
    expect(window.focused).toBe(false);
    const sent = window.webContents.send.mock.calls.filter(([channel]: [string]) => channel === LanguageToolsIpc.Input).at(-1)[1];
    expect(sent).toMatchObject({
      tool: LanguageTool.Translate, text: 'Selected words', pinned: true, resume: { question: 'Which tense is this?' },
      targetLanguage: TranslationTarget.English,
    });
    expect(sent.id).not.toBe(firstInput.id);
    // The question is delivered once; a renderer that reloads reads the card without it.
    const input = invoke(LanguageToolsIpc.GetInput, undefined, window.webContents);
    expect(input).toMatchObject({ id: sent.id, pinned: true, targetLanguage: TranslationTarget.English });
    expect(input.resume).toBeUndefined();
    expect(events(Interaction.LoginSuccess)).toEqual([expect.objectContaining({
      source: AnalyticsSource.LanguageTools, tool: 'ask', journeyId, durationMs: expect.any(Number),
    })]);
    // Continuing is not a new use of the tool.
    expect(events(Interaction.Run)).toEqual([]);
    window.blur();
    expect(window.visible).toBe(true);
    // A later login does not bring it back again.
    manager.resetLanguageTools();
    manager.handleLoginSucceeded();
    expect(window.visible).toBe(false);
  });

  test('closing the card, a new request or a stale sign-in drops the continuation', () => {
    vi.useFakeTimers();
    create();
    let window = openTranslation();
    invoke(DesktopCompanionIpc.LoginStart, { tool: 'ask', resume: { question: 'Why?' } }, window.webContents);
    invoke(LanguageToolsIpc.Close, undefined, window.webContents);
    manager.resetLanguageTools();
    manager.handleLoginSucceeded();
    expect(window.visible).toBe(false);
    // The sign-in still came from the prompt.
    expect(events(Interaction.LoginSuccess)).toHaveLength(1);

    window = openTranslation();
    invoke(DesktopCompanionIpc.LoginStart, { tool: 'tts' }, window.webContents);
    invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Tts, text: 'Something else' });
    manager.resetLanguageTools();
    manager.handleLoginSucceeded();
    expect(window.visible).toBe(false);

    window = openTranslation();
    invoke(DesktopCompanionIpc.LoginStart, { tool: 'translate' }, window.webContents);
    vi.advanceTimersByTime(31 * 60_000);
    manager.resetLanguageTools();
    manager.handleLoginSucceeded();
    expect(window.visible).toBe(false);
    expect(events(Interaction.LoginSuccess)).toHaveLength(2);
  });

  test('only selection and language tools cards report the prompt or start a sign-in', () => {
    create();
    const selectionWindow = new BrowserWindow();
    const selectionId = vi.spyOn(CompanionSelectionController.prototype, 'webContentsId', 'get')
      .mockReturnValue(selectionWindow.webContents.id);
    const hold = vi.spyOn(CompanionSelectionController.prototype, 'holdForLogin');
    try {
      const shown = { action: AnalyticsAction.Action, source: AnalyticsSource.Panel, interactionType: Interaction.LoginShown, tool: 'explain', journeyId };
      invoke(DesktopCompanionIpc.ReportAnalytics, shown, selectionWindow.webContents);
      invoke(DesktopCompanionIpc.ReportAnalytics, shown);
      expect(events(Interaction.LoginShown)).toEqual([expect.objectContaining({ source: AnalyticsSource.Selection, tool: 'explain', journeyId })]);

      invoke(DesktopCompanionIpc.LoginStart, { tool: 'explain' });
      invoke(DesktopCompanionIpc.LoginStart, { tool: 'shell' }, selectionWindow.webContents);
      expect(hold).not.toHaveBeenCalled();
      invoke(DesktopCompanionIpc.LoginStart, { tool: 'explain', journeyId }, selectionWindow.webContents);
      expect(hold).toHaveBeenCalledTimes(1);
      expect(events(Interaction.LoginClick)).toEqual([expect.objectContaining({ source: AnalyticsSource.Selection, tool: 'explain', journeyId })]);
    } finally {
      selectionId.mockRestore();
      hold.mockRestore();
    }
  });
});

describe('accessibility permission', () => {
  test('asks for Accessibility, guides the user through System Settings, and starts the toolbar once granted', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const trusted = vi.mocked(systemPreferences.isTrustedAccessibilityClient);
    trusted.mockReturnValue(false);
    try {
      values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
      create(undefined, OpenClawEnginePhase.Running, () => FakeSelectionHook);
      expect(manager.getState().capabilities.selection).toBe(CompanionCapability.NeedsPermission);
      const windowCount = mocks.windows.length;

      invoke(DesktopCompanionIpc.RequestPermission, CompanionPermission.Accessibility);
      expect(trusted).toHaveBeenCalledWith(true);
      expect(guideOpenSettings).toHaveBeenCalledWith(expect.stringContaining('Privacy_Accessibility'));

      foreground.emit('change', 'com.apple.systempreferences');
      await vi.advanceTimersByTimeAsync(0);
      const guide = mocks.windows.at(-1);
      expect(mocks.windows).toHaveLength(windowCount + 1);
      expect(guide.isVisible()).toBe(true);
      expect(guide.getBounds()).toMatchObject(COMPANION_PERMISSION_GUIDE_SIZE);
      // The guide renders from the same state and is a known sender.
      expect(() => invoke(DesktopCompanionIpc.GetState, undefined, guide.webContents)).not.toThrow();

      trusted.mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(guide.isDestroyed()).toBe(true);
      expect(manager.getState().capabilities.selection).toBe(CompanionCapability.Ready);
    } finally {
      trusted.mockReturnValue(true);
    }
  });

  test('does not guide when Accessibility is already granted', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create(undefined, OpenClawEnginePhase.Running, () => FakeSelectionHook);
    invoke(DesktopCompanionIpc.RequestPermission, CompanionPermission.Accessibility);
    expect(guideOpenSettings).not.toHaveBeenCalled();
  });
});

describe('orb menu on macOS', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
  });

  function openMenu() {
    invoke(DesktopCompanionIpc.ContextMenu);
    const window = mocks.windows.find(win => win.surface === DesktopCompanionSurface.Menu && !win.destroyed);
    const state = manager.getState().contextMenu!;
    return {
      window,
      state,
      ready: (id = state.id) => invoke(CompanionContextMenuIpc.Ready, id, window.webContents),
      run: (id: string) => invoke(CompanionContextMenuIpc.Run, id, window.webContents),
    };
  }

  test('draws the menu in its own panel, which floats over full-screen apps, and shows it once painted', () => {
    values.set(DesktopCompanionStoreKey.Position, { x: 1200, y: 750 });
    create();
    const { window, state, ready } = openMenu();
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled();
    expect(window).not.toBe(orb());
    expect(state.items.map(item => item.label)).toEqual([
      'desktopCompanionChangeSkin', 'desktopCompanionSnoozeToday', 'desktopCompanionSettings',
    ]);
    expect(state.items.filter(item => item.divided).map(item => item.label)).toEqual(['desktopCompanionSettings']);
    expect(state.items[0].submenu!.map(item => item.checked)).toEqual([true, false, false, false, false, false, false, false, false]);
    expect(state.cards).toEqual({ root: expect.any(Object), [state.items[0].id]: expect.any(Object) });
    // Beside the orb in the lower right, rising from its middle, wherever the pointer is.
    const menuHeight = CompanionContextMenuSize.Chrome * 2 + CompanionContextMenuSize.Item * 3 + CompanionContextMenuSize.Divider;
    expect(window.bounds.x + state.cards.root.x + CompanionContextMenuSize.Width).toBe(orb().bounds.x);
    expect(window.bounds.y + state.cards.root.y + menuHeight).toBe(orb().bounds.y + orb().bounds.height / 2);
    expect(window.visible).toBe(false);
    expect(ready()).toBe(true);
    expect(window).toMatchObject({ visible: true, focused: true });

    // Opening again hides the previous menu until the new one has painted.
    const again = openMenu();
    expect(again.window).toBe(window);
    expect(window.visible).toBe(false);
    expect(again.ready(state.id)).toBe(false);
    expect(again.ready()).toBe(true);
    expect(window.visible).toBe(true);
  });

  test('a chosen item closes the menu before it runs, and a closed menu runs nothing', () => {
    create();
    const first = openMenu();
    first.ready();
    first.run(first.state.items[2].id);
    expect(manager.getState().contextMenu).toBeNull();
    expect(first.window.visible).toBe(false);
    expect(openSettings).toHaveBeenCalledOnce();

    const second = openMenu();
    second.ready();
    second.run(second.state.items[0].submenu![1].id);
    expect(manager.getState().preferences.skin).toBe('ruanruanxia');
    expect(orb().bounds).toMatchObject(DesktopCompanionSize.Orb);
    second.run(second.state.items[1].id);
    expect(manager.getState().snooze).toBeNull();
  });

  test('only the menu window can run or dismiss its items', () => {
    create();
    const { state } = openMenu();
    expect(() => invoke(CompanionContextMenuIpc.Run, state.items[0].id)).toThrow('Invalid companion context menu IPC sender');
    expect(() => invoke(CompanionContextMenuIpc.Dismiss, undefined, orb().webContents)).toThrow('Invalid companion context menu IPC sender');
    expect(openMain).not.toHaveBeenCalled();
    expect(manager.getState().contextMenu).not.toBeNull();
  });

  test('the quick panel stays open behind the menu and gets focus back, but a click elsewhere closes both', () => {
    vi.useFakeTimers();
    create();
    manager.togglePanel();
    const panel = mocks.windows.at(-1);
    readyPanel(panel);
    expect(panel.focused).toBe(true);

    const first = openMenu();
    first.ready();
    // The menu takes key focus, which a native menu would not.
    panel.blur();
    vi.advanceTimersByTime(500);
    expect(manager.getState().panelVisible).toBe(true);
    invoke(CompanionContextMenuIpc.Dismiss, undefined, first.window.webContents);
    expect(manager.getState().contextMenu).toBeNull();
    expect(panel.focused).toBe(true);
    vi.advanceTimersByTime(500);
    expect(manager.getState().panelVisible).toBe(true);

    const second = openMenu();
    second.ready();
    panel.blur();
    second.window.blur();
    vi.advanceTimersByTime(500);
    expect(manager.getState().contextMenu).toBeNull();
    expect(manager.getState().panelVisible).toBe(false);
  });
});

describe('hover launcher', () => {
  const { LauncherOpenDelayMs, LauncherCloseDelayMs, LauncherPollMs } = DesktopCompanionTiming;
  const stageKind = () => manager.getState().stage.kind;
  const emitFromStage = (channel: string, value: unknown) => {
    const { webContents } = stageWindow();
    ipcMain.emit(channel, { sender: webContents, senderFrame: webContents.mainFrame }, value);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
  });

  test('resting on the orb opens the launcher beside it; a pointer passing over does not', () => {
    create();
    orb().emit('ready-to-show');
    const { x, y, width, height } = orb().bounds;
    vi.spyOn(screen, 'getCursorScreenPoint').mockReturnValue({ x: x + width / 2, y: y + height / 2 });
    hoverOrb(true);
    vi.advanceTimersByTime(LauncherOpenDelayMs - 1);
    hoverOrb(false);
    vi.advanceTimersByTime(LauncherOpenDelayMs * 2);
    expect(stageKind()).toBe(DesktopCompanionStageKind.None);
    expect(stageWindow()).toBeUndefined();

    restOnOrb();
    expect(stageKind()).toBe(DesktopCompanionStageKind.Launcher);
    const stage = stageWindow();
    emitFromStage(DesktopCompanionIpc.ResizeSurface, { width: 276, height: 223 });
    expect(stage.visible).toBe(true);
    expect(stage.focused).toBe(false);
    // Toward the middle of the screen, the card's edge on the orb's, its last row level with the orb.
    expect(stage.bounds).toMatchObject({ width: 276, height: 223 });
    expect(stage.bounds.x + stage.bounds.width - DesktopCompanionSize.SurfacePad).toBe(x);
    expect(stage.bounds.y + stage.bounds.height).toBe(y + height + DesktopCompanionSize.SurfacePad / 2);
    expect(reportAnalytics).toHaveBeenCalledWith(expect.objectContaining({
      action: AnalyticsAction.Action, source: AnalyticsSource.Launcher, interactionType: Interaction.Open, stage: AnalyticsStage.Shown,
    }));
  });

  test('stays while the pointer is on the orb or the card and closes once it has left both', () => {
    create();
    restOnOrb();
    const stage = stageWindow();
    emitFromStage(DesktopCompanionIpc.ResizeSurface, { width: 276, height: 223 });
    hoverOrb(false);
    vi.mocked(screen.getCursorScreenPoint).mockReturnValue({ x: stage.bounds.x + 60, y: stage.bounds.y + 60 });
    vi.advanceTimersByTime(LauncherCloseDelayMs * 5);
    expect(stageKind()).toBe(DesktopCompanionStageKind.Launcher);

    vi.mocked(screen.getCursorScreenPoint).mockReturnValue({ x: 100, y: 100 });
    vi.advanceTimersByTime(LauncherPollMs);
    expect(stageKind()).toBe(DesktopCompanionStageKind.Launcher);
    vi.advanceTimersByTime(LauncherCloseDelayMs + LauncherPollMs);
    expect(stageKind()).toBe(DesktopCompanionStageKind.None);
    expect(stage.visible).toBe(false);
  });

  test('its window takes the mouse only over its cards, and only for the launcher', () => {
    create();
    restOnOrb();
    const stage = stageWindow();
    // Opens under a pointer that is still on the orb.
    expect(stage.ignoreMouse).toBe(true);
    emitFromStage(DesktopCompanionIpc.StagePassThrough, false);
    expect(stage.ignoreMouse).toBe(false);
    ipcMain.emit(DesktopCompanionIpc.StagePassThrough, { sender: orb().webContents, senderFrame: orb().webContents.mainFrame }, true);
    emitFromStage(DesktopCompanionIpc.StagePassThrough, 'yes');
    expect(stage.ignoreMouse).toBe(false);
    emitFromStage(DesktopCompanionIpc.StagePassThrough, true);
    expect(stage.ignoreMouse).toBe(true);

    // A file brought to the orb replaces the launcher, and the drop zone must receive the drop.
    dragOverOrb(DesktopCompanionFileDragPhase.Enter, [CompanionFileKind.Pdf]);
    expect(stageKind()).toBe(DesktopCompanionStageKind.Drop);
    expect(stage.ignoreMouse).toBe(false);
    emitFromStage(DesktopCompanionIpc.StagePassThrough, true);
    expect(stage.ignoreMouse).toBe(false);
  });

  test('does not open over the quick panel, during a file drag or while the orb is being moved', () => {
    create();
    manager.togglePanel();
    restOnOrb();
    expect(stageKind()).toBe(DesktopCompanionStageKind.None);
    manager.hidePanel();

    fileDrag.emit(FileDragEvent.Start, { paths: ['/tmp/a.pdf'] });
    hoverOrb(false);
    hoverOrb(true);
    vi.advanceTimersByTime(LauncherOpenDelayMs);
    expect(stageKind()).not.toBe(DesktopCompanionStageKind.Launcher);
    fileDrag.emit(FileDragEvent.End);
    vi.advanceTimersByTime(DesktopCompanionTiming.DropLingerMs + 1);
    expect(stageKind()).toBe(DesktopCompanionStageKind.None);

    hoverOrb(false);
    hoverOrb(true);
    emitDrag(DesktopCompanionDragPhase.Start, { x: 0.5, y: 0.5 });
    emitDrag(DesktopCompanionDragPhase.Move);
    vi.advanceTimersByTime(LauncherOpenDelayMs);
    expect(stageKind()).toBe(DesktopCompanionStageKind.None);
    emitDrag(DesktopCompanionDragPhase.End);

    restOnOrb();
    expect(stageKind()).toBe(DesktopCompanionStageKind.Launcher);
  });

  test('pressing or right-clicking the orb closes it until the pointer leaves and comes back', () => {
    create();
    restOnOrb();
    emitDrag(DesktopCompanionDragPhase.Start, { x: 0.5, y: 0.5 });
    expect(stageKind()).toBe(DesktopCompanionStageKind.None);
    emitDrag(DesktopCompanionDragPhase.Cancel);
    invoke(DesktopCompanionIpc.ToggleOrb, true, orb().webContents);
    expect(manager.getState().panelVisible).toBe(true);
    manager.hidePanel();
    // Still on the orb after the click: the user asked for the panel, not the launcher.
    hoverOrb(true);
    vi.advanceTimersByTime(LauncherOpenDelayMs * 2);
    expect(stageKind()).toBe(DesktopCompanionStageKind.None);

    restOnOrb();
    expect(stageKind()).toBe(DesktopCompanionStageKind.Launcher);
    menu();
    expect(stageKind()).toBe(DesktopCompanionStageKind.None);
  });

  test('task news takes its place, and it waits while task bubbles are showing', () => {
    values.set(COMPANION_RECENT_TASKS_KEY, [{ sessionId: 'task', viewedAt: 0 }]);
    create();
    invoke(DesktopCompanionIpc.SelectSession, 'task');
    restOnOrb();
    expect(stageKind()).toBe(DesktopCompanionStageKind.Launcher);
    ipcMain.emit(DesktopCompanionIpc.TaskUpdated, { sender: orb().webContents, senderFrame: orb().webContents.mainFrame });
    expect(stageKind()).toBe(DesktopCompanionStageKind.None);
    expect(manager.getState().result.visible).toBe(true);
    restOnOrb();
    expect(stageKind()).toBe(DesktopCompanionStageKind.None);
  });

  test('the input-shaped button opens the quick panel and the last row opens the app', () => {
    create();
    launch(CompanionLauncherAction.Ask);
    expect(stageKind()).toBe(DesktopCompanionStageKind.None);
    expect(manager.getState().panelVisible).toBe(true);
    expect(reportAnalytics).toHaveBeenCalledWith(expect.objectContaining({
      source: AnalyticsSource.Launcher, interactionType: Interaction.Open, surface: DesktopCompanionSurface.Panel,
    }));
    manager.hidePanel();

    launch(CompanionLauncherAction.OpenApp);
    expect(stageKind()).toBe(DesktopCompanionStageKind.None);
    expect(openMain).toHaveBeenCalledWith(null);
    expect(reportAnalytics).toHaveBeenCalledWith(expect.objectContaining({
      source: AnalyticsSource.Launcher, interactionType: Interaction.OpenMain, hasSession: false,
    }));
  });

  test('chosen files are attached in the quick panel; canceling the dialog opens nothing', async () => {
    create();
    launch(CompanionLauncherAction.Files);
    await vi.waitFor(() => expect(reportAnalytics).toHaveBeenCalledWith(expect.objectContaining({
      source: AnalyticsSource.Launcher, interactionType: Interaction.AttachFiles, outcome: 'cancelled', attachmentCount: 0,
    })));
    expect(dialog.showOpenDialog).toHaveBeenCalledWith({
      title: 'desktopCompanionLauncherFilesTitle', properties: ['openFile', 'multiSelections'],
    });
    expect(manager.getState().panelVisible).toBe(false);

    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/report.pdf', '/tmp/shot.PNG'] });
    launch(CompanionLauncherAction.Files);
    await vi.waitFor(() => expect(manager.getState().panelVisible).toBe(true));
    expect(manager.getState().draft.attachments).toEqual([
      { path: '/tmp/report.pdf', name: 'report.pdf', isImage: false, isDirectory: false },
      { path: '/tmp/shot.PNG', name: 'shot.PNG', isImage: true, isDirectory: false },
    ]);
    expect(reportAnalytics).toHaveBeenCalledWith(expect.objectContaining({
      interactionType: Interaction.AttachFiles, outcome: 'success', attachmentCount: 2,
    }));
  });

  test('a full draft explains itself instead of opening a file dialog', () => {
    create();
    invoke(DesktopCompanionIpc.SetDraft, {
      attachments: Array.from({ length: 20 }, (_, index) => ({ path: `/tmp/${index}.pdf`, name: `${index}.pdf` })),
    });
    launch(CompanionLauncherAction.Files);
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(dialog.showMessageBox).toHaveBeenCalledWith({ type: 'info', message: 'desktopCompanionLauncherFilesFull' });
  });

  test('only the orb reports hovering, and only a showing launcher runs known entries', () => {
    create();
    orb().emit('ready-to-show');
    const { x, y, width, height } = orb().bounds;
    vi.spyOn(screen, 'getCursorScreenPoint').mockReturnValue({ x: x + width / 2, y: y + height / 2 });
    hoverOrb(true, main.webContents);
    vi.advanceTimersByTime(LauncherOpenDelayMs);
    expect(stageKind()).toBe(DesktopCompanionStageKind.None);
    invoke(DesktopCompanionIpc.StageCommand, { type: DesktopCompanionStageCommandType.LauncherRun, action: CompanionLauncherAction.Ask });
    expect(manager.getState().panelVisible).toBe(false);

    restOnOrb();
    invoke(DesktopCompanionIpc.StageCommand, { type: DesktopCompanionStageCommandType.LauncherRun, action: 'settings' }, stageWindow().webContents);
    expect(stageKind()).toBe(DesktopCompanionStageKind.Launcher);
    expect(openSettings).not.toHaveBeenCalled();
  });

  test('turning the companion off closes the launcher and forgets the hover', () => {
    create();
    restOnOrb();
    invoke(DesktopCompanionIpc.SetPreferences, { enabled: false });
    expect(stageKind()).toBe(DesktopCompanionStageKind.None);
    vi.advanceTimersByTime(LauncherOpenDelayMs + LauncherCloseDelayMs * 2);
    expect(stageKind()).toBe(DesktopCompanionStageKind.None);
  });
});
