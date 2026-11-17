import type { BrowserWindow } from 'electron';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { CompanionPermission } from '../../shared/desktopCompanion/constants';
import {
  COMPANION_PERMISSION_GUIDE_RELAUNCH_SIZE,
  COMPANION_PERMISSION_GUIDE_SIZE,
  COMPANION_PERMISSION_INTRO_SIZE,
  CompanionPermissionGuideIpc,
  CompanionPermissionGuideStage,
  resolvePermissionIntroBounds,
} from '../../shared/desktopCompanion/permissionGuide';
import {
  companionAppBundlePath,
  type CompanionGuideApp,
  CompanionPermissionGuideController,
  MAC_SYSTEM_SETTINGS_APP_ID,
} from './companionPermissionGuide';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value?: unknown) => unknown>(),
  listeners: new Map<string, (event: unknown, value?: unknown) => void>(),
  app: null as unknown as EventEmitter,
}));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  mocks.app = Object.assign(new Emitter(), { getName: () => 'LobsterAI', getPath: () => '/Applications/LobsterAI.app/Contents/MacOS/LobsterAI' });
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };
  return {
    app: mocks.app,
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, value?: unknown) => unknown) => mocks.handlers.set(channel, handler),
      removeHandler: (channel: string) => mocks.handlers.delete(channel),
      on: (channel: string, listener: (event: unknown, value?: unknown) => void) => mocks.listeners.set(channel, listener),
      removeAllListeners: (channel: string) => mocks.listeners.delete(channel),
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      getDisplayNearestPoint: () => ({ workArea }),
      getDisplayMatching: () => ({ workArea }),
    },
    shell: { openExternal: vi.fn(() => Promise.resolve()) },
    systemPreferences: { isTrustedAccessibilityClient: vi.fn(() => false) },
    nativeImage: { createFromDataURL: vi.fn() },
  };
});
vi.mock('../shellApps', () => ({ extractIcon: vi.fn(async () => null) }));

const WORK_AREA = { x: 0, y: 0, width: 1440, height: 900 };

class GuideWindow extends EventEmitter {
  visible = false;
  destroyed = false;
  focusedNow = false;
  opacity = 1;
  bounds: unknown = null;
  webContents = Object.assign(new EventEmitter(), { id: 41, mainFrame: {}, isLoadingMainFrame: () => false, startDrag: vi.fn() });
  isDestroyed = () => this.destroyed;
  isVisible = () => this.visible;
  isFocused = () => this.focusedNow;
  isEnabled = () => true;
  getChildWindows = () => [];
  setBounds(value: unknown) { this.bounds = value; }
  setOpacity(value: number) { this.opacity = value; }
  show() { this.visible = true; this.emit('show'); }
  showInactive() { this.visible = true; this.emit('show'); }
  focus() { if (!this.visible) return; this.focusedNow = true; this.emit('focus'); }
  blur() { this.focusedNow = false; this.emit('blur'); }
  hide() { this.visible = false; this.focusedNow = false; this.emit('hide'); }
  destroy() { this.destroyed = true; this.emit('closed'); }
}

const guideApp: CompanionGuideApp = {
  name: 'LobsterAI', path: '/Applications/LobsterAI.app', icon: 'data:image/png;base64,AA==',
  dragIcon: { isEmpty: () => false } as unknown as CompanionGuideApp['dragIcon'],
};

let granted: boolean;
let focused: unknown;
let windows: GuideWindow[];
let onGranted: ReturnType<typeof vi.fn>;
let relaunch: ReturnType<typeof vi.fn>;
let requestAccess: ReturnType<typeof vi.fn>;
let openSettings: ReturnType<typeof vi.fn>;
let locateAppWindow: ReturnType<typeof vi.fn>;
let appTerminated: ((appId: string) => void) | null;
let unsubscribeTerminated: ReturnType<typeof vi.fn>;
let guide: CompanionPermissionGuideController;

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
const guideEvent = () => ({ sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  granted = false;
  focused = null;
  windows = [];
  onGranted = vi.fn();
  relaunch = vi.fn();
  requestAccess = vi.fn();
  openSettings = vi.fn(() => Promise.resolve());
  locateAppWindow = vi.fn(async () => ({ x: 360, y: 80, width: 715, height: 500 }));
  appTerminated = null;
  unsubscribeTerminated = vi.fn();
  guide = new CompanionPermissionGuideController({
    createWindow: bounds => {
      const win = new GuideWindow();
      win.bounds = bounds;
      windows.push(win);
      return win as unknown as BrowserWindow;
    },
    requestAccess,
    onGranted,
    relaunch,
  }, {
    isGranted: () => granted,
    openSettings,
    locateAppWindow,
    loadApp: async () => guideApp,
    focusedWindow: () => focused as BrowserWindow | null,
    onAppTerminated: listener => { appTerminated = listener; return unsubscribeTerminated; },
  });
});

afterEach(() => {
  guide.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('companionAppBundlePath', () => {
  test('finds the app bundle around the main executable', () => {
    expect(companionAppBundlePath('/Applications/LobsterAI.app/Contents/MacOS/LobsterAI')).toBe('/Applications/LobsterAI.app');
    expect(companionAppBundlePath('/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'))
      .toBe('/repo/node_modules/electron/dist/Electron.app');
  });

  test('returns null outside a bundle', () => {
    expect(companionAppBundlePath('/usr/local/bin/node')).toBeNull();
  });
});

describe('CompanionPermissionGuideController', () => {
  test('opens the Accessibility pane and shows the card below System Settings once it is in front', async () => {
    guide.open(CompanionPermission.Accessibility);
    expect(openSettings).toHaveBeenCalledWith(expect.stringContaining('Privacy_Accessibility'));
    expect(windows).toHaveLength(0);

    guide.onForegroundChange(MAC_SYSTEM_SETTINGS_APP_ID);
    await flush();
    expect(windows).toHaveLength(1);
    expect(windows[0].visible).toBe(true);
    expect(windows[0].bounds).toMatchObject({ y: 80 + 500 - 10, ...COMPANION_PERMISSION_GUIDE_SIZE });
  });

  test('shows the card at the bottom of the screen when the System Settings window never turns up', async () => {
    locateAppWindow.mockResolvedValue(null);
    guide.open(CompanionPermission.Accessibility);
    await vi.advanceTimersByTimeAsync(1_500);
    // Still waiting for the window, not guessing a spot under the sidebar.
    expect(windows).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(windows[0]?.visible).toBe(true);
    expect(locateAppWindow).toHaveBeenCalledTimes(12);
  });

  test('waits for a cold-started System Settings window and lines up with its app list', async () => {
    locateAppWindow.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    guide.open(CompanionPermission.Accessibility);
    guide.onForegroundChange(MAC_SYSTEM_SETTINGS_APP_ID);
    await vi.advanceTimersByTimeAsync(400);
    expect(windows).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(windows).toHaveLength(1);
    expect(windows[0].bounds).toMatchObject({ x: 360 + 236 - 22, y: 80 + 500 - 10 });
  });

  test('closes when System Settings quits, which closing its window does', async () => {
    guide.open(CompanionPermission.Accessibility);
    guide.onForegroundChange(MAC_SYSTEM_SETTINGS_APP_ID);
    await flush();
    appTerminated!('com.apple.finder');
    expect(guide.active).toBe(true);
    appTerminated!(MAC_SYSTEM_SETTINGS_APP_ID);
    expect(guide.active).toBe(false);
    expect(windows[0].destroyed).toBe(true);
    expect(unsubscribeTerminated).toHaveBeenCalledOnce();
  });

  test('hides behind other apps, stays for LobsterAI itself, and returns with System Settings', async () => {
    guide.open(CompanionPermission.Accessibility);
    guide.onForegroundChange(MAC_SYSTEM_SETTINGS_APP_ID);
    await flush();

    // Pressing the card to drag the app activates LobsterAI.
    guide.onForegroundChange('com.github.Electron');
    expect(windows[0].visible).toBe(true);

    guide.onForegroundChange('com.apple.Safari');
    expect(windows[0].visible).toBe(false);

    guide.onForegroundChange(MAC_SYSTEM_SETTINGS_APP_ID);
    await flush();
    expect(windows[0].visible).toBe(true);
    expect(windows).toHaveLength(1);
  });

  test('a lookup that finishes after the user left does not bring the card back', async () => {
    let finish: (value: null) => void = () => undefined;
    locateAppWindow.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    guide.open(CompanionPermission.Accessibility);
    guide.onForegroundChange(MAC_SYSTEM_SETTINGS_APP_ID);
    guide.onForegroundChange('com.apple.Safari');
    finish(null);
    await flush();
    expect(windows).toHaveLength(0);
  });

  test('closes itself once the permission is granted and lets the toolbar start', async () => {
    guide.open(CompanionPermission.Accessibility);
    guide.onForegroundChange(MAC_SYSTEM_SETTINGS_APP_ID);
    await flush();
    granted = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(windows[0].destroyed).toBe(true);
    expect(guide.active).toBe(false);
    expect(onGranted).toHaveBeenCalledWith(CompanionPermission.Accessibility);
  });

  test('ends when the user comes back to another LobsterAI window, but not for its own window', async () => {
    guide.open(CompanionPermission.Accessibility);
    guide.onForegroundChange(MAC_SYSTEM_SETTINGS_APP_ID);
    await flush();
    // Pressing the card itself.
    focused = windows[0];
    guide.onForegroundChange('com.lobsterai.app');
    mocks.app.emit('browser-window-focus', {}, windows[0]);
    expect(guide.active).toBe(true);
    mocks.app.emit('browser-window-focus', {}, {});
    expect(guide.active).toBe(false);
    expect(windows[0].destroyed).toBe(true);
  });

  test('ends when LobsterAI is reported in front after another of its windows took focus', async () => {
    guide.open(CompanionPermission.Accessibility);
    guide.onForegroundChange(MAC_SYSTEM_SETTINGS_APP_ID);
    await flush();
    const main = {};
    // The focus event can arrive while System Settings is still the reported front app.
    mocks.app.emit('browser-window-focus', {}, main);
    expect(guide.active).toBe(true);
    focused = main;
    guide.onForegroundChange('com.lobsterai.app');
    expect(guide.active).toBe(false);
  });

  test('switching apps after pressing the card only hides it, though macOS hands focus to another LobsterAI window', async () => {
    guide.open(CompanionPermission.Accessibility);
    guide.onForegroundChange(MAC_SYSTEM_SETTINGS_APP_ID);
    await flush();
    focused = windows[0];
    guide.onForegroundChange('com.lobsterai.app');
    guide.onForegroundChange('com.apple.finder');
    mocks.app.emit('browser-window-focus', {}, {});
    expect(guide.active).toBe(true);
    expect(windows[0].visible).toBe(false);
    guide.onForegroundChange(MAC_SYSTEM_SETTINGS_APP_ID);
    await flush();
    expect(windows[0].visible).toBe(true);
  });

  test('gives up after ten minutes so a later visit to System Settings stays clean', async () => {
    guide.open(CompanionPermission.Accessibility);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(guide.active).toBe(false);
    guide.onForegroundChange(MAC_SYSTEM_SETTINGS_APP_ID);
    await flush();
    expect(windows.every(win => win.destroyed)).toBe(true);
  });

  test('serves its card, drags the app bundle and closes only for its own window', async () => {
    guide.open(CompanionPermission.Accessibility);
    guide.onForegroundChange(MAC_SYSTEM_SETTINGS_APP_ID);
    await flush();
    const info = mocks.handlers.get(CompanionPermissionGuideIpc.Info)!;
    await expect(info(guideEvent())).resolves.toEqual({
      permission: CompanionPermission.Accessibility, stage: CompanionPermissionGuideStage.Guide, paneKey: 'desktopCompanionPaneAccessibility',
      appName: 'LobsterAI', appIcon: guideApp.icon, relaunchRequired: false,
    });
    const other = { sender: { id: 7, mainFrame: {} }, senderFrame: {} };
    expect(() => info(other)).toThrow();

    mocks.listeners.get(CompanionPermissionGuideIpc.Drag)!(guideEvent());
    expect(windows[0].webContents.startDrag).toHaveBeenCalledWith({ file: guideApp.path, icon: guideApp.dragIcon });

    mocks.handlers.get(CompanionPermissionGuideIpc.Close)!(guideEvent());
    expect(guide.active).toBe(false);
    expect(onGranted).not.toHaveBeenCalled();
  });

  test('guides Screen Recording with room for a restart, which closes the guide and relaunches', async () => {
    guide.open(CompanionPermission.ScreenRecording);
    expect(openSettings).toHaveBeenCalledWith(expect.stringContaining('Privacy_ScreenCapture'));
    guide.onForegroundChange(MAC_SYSTEM_SETTINGS_APP_ID);
    await flush();
    expect(windows[0].bounds).toMatchObject(COMPANION_PERMISSION_GUIDE_RELAUNCH_SIZE);
    await expect(mocks.handlers.get(CompanionPermissionGuideIpc.Info)!(guideEvent())).resolves.toMatchObject({
      permission: CompanionPermission.ScreenRecording, relaunchRequired: true,
    });
    await mocks.handlers.get(CompanionPermissionGuideIpc.Relaunch)!(guideEvent());
    expect(guide.active).toBe(false);
    expect(relaunch).toHaveBeenCalledOnce();
  });

  test('a restart request from the Accessibility guide is ignored: that grant applies at once', async () => {
    guide.open(CompanionPermission.Accessibility);
    guide.onForegroundChange(MAC_SYSTEM_SETTINGS_APP_ID);
    await flush();
    await mocks.handlers.get(CompanionPermissionGuideIpc.Relaunch)!(guideEvent());
    expect(relaunch).not.toHaveBeenCalled();
    expect(guide.active).toBe(true);
  });

  test('guiding another permission starts over with a fresh card', async () => {
    guide.open(CompanionPermission.Accessibility);
    guide.onForegroundChange(MAC_SYSTEM_SETTINGS_APP_ID);
    await flush();
    guide.open(CompanionPermission.ScreenRecording);
    expect(windows[0].destroyed).toBe(true);
    guide.onForegroundChange(MAC_SYSTEM_SETTINGS_APP_ID);
    await flush();
    expect(windows).toHaveLength(2);
    expect(windows[1].bounds).toMatchObject(COMPANION_PERMISSION_GUIDE_RELAUNCH_SIZE);
  });

  test('does nothing outside macOS', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    guide.open(CompanionPermission.Accessibility);
    expect(openSettings).not.toHaveBeenCalled();
    expect(guide.active).toBe(false);
  });
});

describe('explaining a permission first', () => {
  test('shows a focused card mid-screen that opens nothing yet and ignores app switches', async () => {
    guide.explain(CompanionPermission.ScreenRecording);
    expect(openSettings).not.toHaveBeenCalled();
    expect(windows[0].bounds).toEqual(resolvePermissionIntroBounds(COMPANION_PERMISSION_INTRO_SIZE, WORK_AREA));
    expect(windows[0].visible).toBe(true);
    expect(windows[0].isFocused()).toBe(true);
    guide.onForegroundChange('com.apple.finder');
    expect(windows[0].visible).toBe(true);
    await expect(mocks.handlers.get(CompanionPermissionGuideIpc.Info)!(guideEvent())).resolves.toMatchObject({
      stage: CompanionPermissionGuideStage.Intro, paneKey: expect.stringMatching(/^desktopCompanionPaneScreen/), relaunchRequired: true,
    });
  });

  test('closes like a dialog once it loses focus', async () => {
    guide.explain(CompanionPermission.ScreenRecording);
    windows[0].blur();
    await vi.advanceTimersByTimeAsync(200);
    expect(guide.active).toBe(false);
    expect(openSettings).not.toHaveBeenCalled();
  });

  test('去开启 asks macOS, opens the pane and turns the same window into the guide beside System Settings', async () => {
    guide.explain(CompanionPermission.ScreenRecording);
    const next = await mocks.handlers.get(CompanionPermissionGuideIpc.Proceed)!(guideEvent());
    expect(requestAccess).toHaveBeenCalledWith(CompanionPermission.ScreenRecording);
    expect(openSettings).toHaveBeenCalledWith(expect.stringContaining('Privacy_ScreenCapture'));
    expect(next).toMatchObject({ stage: CompanionPermissionGuideStage.Guide });
    // Invisible, not hidden, until it moves: the card keeps key focus away from the main window.
    expect(windows[0].opacity).toBe(0);
    expect(windows[0].visible).toBe(true);

    // System Settings takes focus; the guide must not close the way the explanation does.
    windows[0].blur();
    guide.onForegroundChange(MAC_SYSTEM_SETTINGS_APP_ID);
    await vi.advanceTimersByTimeAsync(200);
    expect(guide.active).toBe(true);
    expect(windows).toHaveLength(1);
    expect(windows[0].opacity).toBe(1);
    expect(windows[0].bounds).toMatchObject({ ...COMPANION_PERMISSION_GUIDE_RELAUNCH_SIZE, y: 80 + 500 - 10 });
  });

  test('System Settings quitting does not close the explanation, which never opened it', () => {
    guide.explain(CompanionPermission.ScreenRecording);
    appTerminated!(MAC_SYSTEM_SETTINGS_APP_ID);
    expect(guide.active).toBe(true);
  });

  test('explaining a permission that is already being guided only brings System Settings back', () => {
    guide.open(CompanionPermission.ScreenRecording);
    guide.explain(CompanionPermission.ScreenRecording);
    expect(openSettings).toHaveBeenCalledTimes(2);
    expect(windows).toHaveLength(0);
  });
});
