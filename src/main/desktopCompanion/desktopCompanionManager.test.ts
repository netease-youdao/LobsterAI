import { BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  CompanionCapability,
  DesktopCompanionIpc,
  DesktopCompanionSnoozeMode,
  DesktopCompanionStageCommandType,
  DesktopCompanionStageKind,
  DesktopCompanionStoreKey,
} from '../../shared/desktopCompanion/constants';
import { CompanionHintRule } from '../../shared/desktopCompanion/hintPolicy';
import { LanguageTool, LanguageToolsIpc, SpeechStatus } from '../../shared/desktopCompanion/languageTools';
import { CompanionSelectionController } from './companionSelection';
import { DesktopCompanionManager } from './desktopCompanionManager';
import { FileDragEvent } from './fileDragMonitor';

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
    getBounds() { return this.bounds; }
    setBounds(value: any) { this.bounds = value; }
    setFocusable(value: boolean) { this.focusable = value; }
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; this.emit('hide'); }
    focus() {}
    setMenu() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    loadURL() { return Promise.resolve(); }
    loadFile() { return Promise.resolve(); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const workArea = { x: 0, y: 0, width: 1280, height: 900 };
  return {
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
    }),
    Menu: { buildFromTemplate: () => ({ popup: vi.fn() }) },
    clipboard: { writeText: vi.fn() },
    shell: { openExternal: vi.fn(() => Promise.resolve()) },
    systemPreferences: { isTrustedAccessibilityClient: vi.fn(() => true) },
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

let manager: DesktopCompanionManager;
let main: BrowserWindow;
let values: Map<string, unknown>;
let openMain: ReturnType<typeof vi.fn>;
let foreground: FakeMonitor;
let fileDrag: FakeMonitor;

function create() {
  main = new BrowserWindow();
  openMain = vi.fn();
  foreground = new FakeMonitor();
  fileDrag = new FakeMonitor();
  manager = new DesktopCompanionManager({
    store: {
      get: <T>(key: string) => values.get(key) as T | undefined,
      set: (key, value) => { values.set(key, value); },
    },
    preloadPath: '/preload.js',
    rendererDirectory: '/dist',
    getMainWindow: () => main,
    onPreferencesChanged: vi.fn(),
    openMain,
    services: { foreground: foreground as any, fileDrag: fileDrag as any, loadSelectionHook: () => null },
  });
}

function invoke(channel: string, value?: unknown, sender = main.webContents) {
  return mocks.handlers.get(channel)!({ sender, senderFrame: sender.mainFrame }, value);
}

/** The orb is the first companion window created after the main window. */
function orb() {
  return mocks.windows[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(globalShortcut.register).mockReturnValue(true);
  mocks.windows.length = 0;
  mocks.handlers.clear();
  values = new Map([[DesktopCompanionStoreKey.Greeted, true]]);
});
afterEach(() => {
  manager?.dispose();
  ipcMain.removeAllListeners();
  vi.useRealTimers();
});

describe('desktop companion lifecycle', () => {
  test('language cards open beside the selection, resize with content, and restore without a new request', () => {
    create();
    const anchor = vi.spyOn(CompanionSelectionController.prototype, 'selectionAnchor', 'get')
      .mockReturnValue({ x: 400, top: 200, bottom: 220 });
    try {
      invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Translate, text: 'Selected words' });
      const window = mocks.windows[1];
      expect(window.bounds.x).toBe(378);
      expect(window.bounds.y).toBeGreaterThan(190);
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

  test('pin keeps a card visible on blur; close stops it and prevents an empty page from reopening', () => {
    create();
    invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Tts });
    expect(mocks.windows).toHaveLength(1);
    invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Tts, text: 'Read this' });
    const window = mocks.windows[1];
    invoke(LanguageToolsIpc.Pin, true, window.webContents);
    window.emit('blur');
    expect(window.visible).toBe(true);
    invoke(LanguageToolsIpc.SpeechStatus, SpeechStatus.Playing, window.webContents);
    invoke(LanguageToolsIpc.Pin, false, window.webContents);
    window.emit('blur');
    expect(window.visible).toBe(false);
    expect(manager.getState().speechStatus).toBe(SpeechStatus.Playing);
    invoke(LanguageToolsIpc.Close, undefined, window.webContents);
    expect(manager.getState().speechStatus).toBe(SpeechStatus.Idle);
    expect(invoke(LanguageToolsIpc.GetInput, undefined, window.webContents)).toBeNull();
    invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Tts });
    window.emit('ready-to-show');
    expect(window.visible).toBe(false);
  });

  test('language tools retain their window and playback when hidden, but reset on account changes', () => {
    create();
    invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Tts, text: 'Read this' });
    const window = mocks.windows[1];
    expect(window.visible).toBe(true);
    invoke(LanguageToolsIpc.SpeechStatus, SpeechStatus.Playing, window.webContents);
    invoke(LanguageToolsIpc.Hide, undefined, window.webContents);
    expect(window.visible).toBe(false);
    expect(manager.getState().speechStatus).toBe(SpeechStatus.Playing);
    invoke(LanguageToolsIpc.Open, { tool: LanguageTool.Tts });
    expect(mocks.windows).toHaveLength(2);
    expect(window.visible).toBe(true);
    manager.resetLanguageTools();
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

  test('a new profile creates no floating window and opening a temporary panel does not opt in', () => {
    create();
    expect(manager.getState().preferences.enabled).toBe(false);
    expect(mocks.windows).toHaveLength(1);
    expect(foreground.start).not.toHaveBeenCalled();
    manager.togglePanel();
    expect(manager.getState().panelVisible).toBe(true);
    expect(manager.getState().preferences.enabled).toBe(false);
    expect(mocks.windows).toHaveLength(2);
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
    });
    // Without the native selection hook the toolbar reports itself unsupported instead of failing.
    expect(manager.getState().capabilities.selection).toBe(CompanionCapability.Unsupported);
  });

  test('rejects unknown skins and keeps a short, clean exclusion list', () => {
    create();
    manager.setPreferences({ skin: 'not-a-skin', selectionExcludedApps: [' com.google.Chrome ', '', 42 as unknown as string] });
    expect(manager.getState().preferences.skin).toBe('lobster');
    expect(manager.getState().preferences.selectionExcludedApps).toEqual(['com.google.Chrome']);
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

  test('a quiet day keeps the character but stops drag detection', () => {
    create();
    manager.setPreferences({ enabled: true });
    vi.mocked(fileDrag.stop).mockClear();
    manager.snoozeFor(DesktopCompanionSnoozeMode.Quiet);
    expect(orb().destroyed).toBe(false);
    expect(fileDrag.stop).toHaveBeenCalled();
    manager.wake();
    expect(manager.getState().snooze).toBeNull();
  });

  test('an expired snooze from a previous launch is dropped', () => {
    values.set(DesktopCompanionStoreKey.Snooze, { mode: DesktopCompanionSnoozeMode.Hidden, until: Date.now() - 1_000 });
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

  test('dragging a document opens the drop zone, and dropping on "ask" attaches it in the panel', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    fileDrag.emit(FileDragEvent.Start, { paths: ['/tmp/方案.docx'] });
    expect(manager.getState().fileDragActive).toBe(true);
    expect(manager.getState().stage).toMatchObject({
      kind: DesktopCompanionStageKind.Drop,
      files: [{ name: '方案.docx', kind: 'document' }],
      kinds: ['document'],
    });
    invoke(DesktopCompanionIpc.StageCommand, {
      type: DesktopCompanionStageCommandType.DropAsk,
      attachments: [{ path: '/tmp/方案.docx', name: '方案.docx' }, { path: '', name: 'bad' }],
    });
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
    expect(manager.getState().panelVisible).toBe(true);
    expect(manager.getState().draft.attachments).toEqual([{ path: '/tmp/方案.docx', name: '方案.docx', isImage: false, isDirectory: false }]);
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
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.Drop);
    fileDrag.emit(FileDragEvent.End);
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.Drop);
    vi.advanceTimersByTime(600);
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
  });

  test('a task started from the drop zone becomes the companion task', () => {
    values.set(DesktopCompanionStoreKey.Preferences, { enabled: true });
    create();
    fileDrag.emit(FileDragEvent.Start, { paths: ['/tmp/a.pdf'] });
    invoke(DesktopCompanionIpc.StageCommand, { type: DesktopCompanionStageCommandType.DropStarted, sessionId: 'session-9' });
    expect(manager.getState().sessionId).toBe('session-9');
    expect(manager.getState().stage.kind).toBe(DesktopCompanionStageKind.None);
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
