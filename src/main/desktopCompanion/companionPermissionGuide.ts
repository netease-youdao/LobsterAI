import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { app, BrowserWindow, ipcMain, type NativeImage, nativeImage, type Rectangle, screen, shell, systemPreferences, type WebContents } from 'electron';

import { categorizeCompanionApp, CompanionAppCategory } from '../../shared/desktopCompanion/appCategories';
import { CompanionPermission } from '../../shared/desktopCompanion/constants';
import {
  COMPANION_PERMISSION_INTRO_SIZE,
  type CompanionPermissionGuideInfo,
  CompanionPermissionGuideIpc,
  companionPermissionGuideSize,
  CompanionPermissionGuideStage as Stage,
  companionPermissionNeedsRelaunch,
  companionPermissionPaneKey,
  resolvePermissionGuideBounds,
  resolvePermissionIntroBounds,
} from '../../shared/desktopCompanion/permissionGuide';
import { MediaAccessStatus } from '../../shared/permissions/constants';
import { extractIcon } from '../shellApps';
import { dismissCompanionPanelOnBlur } from './companionWindow';
import { parseRunningApplication } from './foregroundAppMonitor';

const execFileAsync = promisify(execFile);

export const MAC_SYSTEM_SETTINGS_APP_ID = 'com.apple.systempreferences';
const MAC_PERMISSION_SETTINGS: Record<CompanionPermission, string> = {
  [CompanionPermission.Accessibility]: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  [CompanionPermission.ScreenRecording]: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};
const GRANT_POLL_MS = 1_000;
// System Settings normally comes to the front well within this; show the guide anyway after it.
const REVEAL_FALLBACK_MS = 1_500;
// A cold-started System Settings activates about 1.5–2 s before its window is on screen.
const LOCATE_ATTEMPTS = 12;
const LOCATE_RETRY_MS = 250;
const MAC_APP_TERMINATED_NOTIFICATION = 'NSWorkspaceDidTerminateApplicationNotification';
// A guide the user walked away from must not reappear whenever System Settings is opened later.
const GUIDE_LIFETIME_MS = 10 * 60_000;
const DRAG_ICON_SIZE = 64;

// Window bounds come from CGWindowList, which needs no permission (only window titles would).
// The largest normal window is the main one: a password sheet in front of it is smaller.
// JXA returns NSArray counts as strings, hence Number().
const MAC_APP_WINDOW_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function run(argv) {
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0]);
  if (Number(apps.count) === 0) return '';
  var pid = Number(apps.objectAtIndex(0).processIdentifier);
  var windows = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0));
  var best = null;
  for (var i = 0; i < Number(windows.count); i++) {
    var item = windows.objectAtIndex(i);
    if (Number(ObjC.unwrap(item.objectForKey('kCGWindowOwnerPID'))) !== pid) continue;
    if (Number(ObjC.unwrap(item.objectForKey('kCGWindowLayer'))) !== 0) continue;
    var b = item.objectForKey('kCGWindowBounds');
    var rect = {
      x: Number(ObjC.unwrap(b.objectForKey('X'))), y: Number(ObjC.unwrap(b.objectForKey('Y'))),
      width: Number(ObjC.unwrap(b.objectForKey('Width'))), height: Number(ObjC.unwrap(b.objectForKey('Height'))),
    };
    if (!best || rect.width * rect.height > best.width * best.height) best = rect;
  }
  return best ? JSON.stringify(best) : '';
}`;

export interface CompanionGuideApp {
  name: string;
  /** The .app bundle the user drags into the System Settings list. */
  path: string;
  icon: string | null;
  dragIcon: NativeImage | null;
}

export interface CompanionPermissionGuideServices {
  isGranted?(permission: CompanionPermission): boolean;
  openSettings?(url: string): Promise<void>;
  /** The frontmost normal window of a running app, in screen points. */
  locateAppWindow?(appId: string): Promise<Rectangle | null>;
  loadApp?(): Promise<CompanionGuideApp | null>;
  focusedWindow?(): BrowserWindow | null;
  /** Calls back with the bundle id of each app that quits; returns the unsubscribe. */
  onAppTerminated?(listener: (appId: string) => void): () => void;
}

interface PermissionGuideHost {
  createWindow(bounds: Rectangle): BrowserWindow;
  /** The user chose to turn it on: ask macOS so it lists the app, before System Settings opens. */
  requestAccess?(permission: CompanionPermission): void;
  onGranted(permission: CompanionPermission): void;
  /** Quit and reopen the app; macOS applies Screen Recording only to a fresh process. */
  relaunch(): void;
}

function isMacPermissionGranted(permission: CompanionPermission): boolean {
  if (permission === CompanionPermission.Accessibility) return systemPreferences.isTrustedAccessibilityClient(false);
  return systemPreferences.getMediaAccessStatus('screen') === MediaAccessStatus.Granted;
}

/** The outermost .app bundle around the running executable: LobsterAI.app, or Electron.app in development. */
export function companionAppBundlePath(executablePath: string): string | null {
  let bundle: string | null = null;
  for (let dir = path.dirname(executablePath); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (dir.endsWith('.app')) bundle = dir;
  }
  return bundle;
}

async function locateMacAppWindow(appId: string): Promise<Rectangle | null> {
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_APP_WINDOW_SCRIPT, appId], {
    timeout: 2_000, maxBuffer: 64 * 1024,
  });
  const text = stdout.trim();
  if (!text) return null;
  const value = JSON.parse(text) as Partial<Rectangle>;
  const numbers = [value.x, value.y, value.width, value.height];
  if (!numbers.every(item => typeof item === 'number' && Number.isFinite(item)) || !value.width || !value.height) return null;
  return { x: value.x!, y: value.y!, width: value.width, height: value.height };
}

function subscribeMacAppTerminated(listener: (appId: string) => void): () => void {
  if (process.platform !== 'darwin') return () => undefined;
  const id = systemPreferences.subscribeWorkspaceNotification(MAC_APP_TERMINATED_NOTIFICATION, (_event, userInfo) => {
    const appId = parseRunningApplication(userInfo);
    if (appId) listener(appId);
  });
  return () => systemPreferences.unsubscribeWorkspaceNotification(id);
}

async function loadMacGuideApp(): Promise<CompanionGuideApp | null> {
  const bundle = companionAppBundlePath(app.getPath('exe'));
  if (!bundle) return null;
  const name = path.basename(bundle, '.app');
  const icon = await extractIcon({ name, path: bundle, isDefault: false }).catch((): null => null);
  let image = icon ? nativeImage.createFromDataURL(icon) : null;
  if (!image || image.isEmpty()) image = await app.getFileIcon(bundle, { size: 'normal' }).catch((): null => null);
  // macOS refuses a drag without an image.
  const dragIcon = image && !image.isEmpty() ? image.resize({ width: DRAG_ICON_SIZE, height: DRAG_ICON_SIZE }) : null;
  return { name, path: bundle, icon, dragIcon };
}

/**
 * Walks the user through a macOS privacy list. When a feature hits the missing permission, a card
 * first explains it (explain); from there, or straight from settings (open), it opens the System
 * Settings pane and floats beside it, naming the app and offering its bundle to drag in when it is
 * missing. It closes once the permission is granted, the user closes it or comes back to LobsterAI.
 */
export class CompanionPermissionGuideController {
  private window: BrowserWindow | null = null;
  private permission: CompanionPermission | null = null;
  private stage: Stage = Stage.Guide;
  private wantVisible = false;
  private revealToken = 0;
  private disposing = false;
  private app: CompanionGuideApp | null = null;
  private appLoading: Promise<CompanionGuideApp | null> | null = null;
  private grantTimer: ReturnType<typeof setInterval> | undefined;
  private revealTimer: ReturnType<typeof setTimeout> | undefined;
  private lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  private frontAppId: string | null = null;
  private stopWatchingSettings: (() => void) | null = null;
  private readonly services: Required<CompanionPermissionGuideServices>;

  constructor(private readonly host: PermissionGuideHost, services: CompanionPermissionGuideServices = {}) {
    this.services = {
      isGranted: services.isGranted ?? isMacPermissionGranted,
      openSettings: services.openSettings ?? (url => shell.openExternal(url)),
      locateAppWindow: services.locateAppWindow ?? locateMacAppWindow,
      loadApp: services.loadApp ?? loadMacGuideApp,
      focusedWindow: services.focusedWindow ?? (() => BrowserWindow.getFocusedWindow()),
      onAppTerminated: services.onAppTerminated ?? subscribeMacAppTerminated,
    };
    const fromGuide = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => event.senderFrame === event.sender.mainFrame
      && event.sender.id === this.webContentsId;
    ipcMain.handle(CompanionPermissionGuideIpc.Info, event => {
      if (!fromGuide(event)) throw new Error('Invalid permission guide IPC sender');
      return this.info();
    });
    ipcMain.handle(CompanionPermissionGuideIpc.Proceed, event => {
      if (!fromGuide(event)) throw new Error('Invalid permission guide IPC sender');
      this.proceed();
      return this.info();
    });
    ipcMain.handle(CompanionPermissionGuideIpc.Close, event => {
      if (!fromGuide(event)) throw new Error('Invalid permission guide IPC sender');
      this.close();
    });
    ipcMain.handle(CompanionPermissionGuideIpc.Relaunch, event => {
      if (!fromGuide(event)) throw new Error('Invalid permission guide IPC sender');
      const permission = this.permission;
      if (!permission || !companionPermissionNeedsRelaunch(permission)) return;
      console.log('[DesktopCompanion] Relaunching to apply a permission', { permission });
      this.close();
      this.host.relaunch();
    });
    ipcMain.on(CompanionPermissionGuideIpc.Drag, event => {
      if (fromGuide(event)) this.startDrag(event.sender);
    });
    app.on('browser-window-focus', this.onWindowFocus);
  }

  get browserWindow(): BrowserWindow | null { return this.window && !this.window.isDestroyed() ? this.window : null; }
  get webContentsId(): number | null { return this.browserWindow?.webContents.id ?? null; }
  get active(): boolean { return this.permission !== null; }

  /** A feature needs the permission: explain it first, with a way to turn it on. */
  explain(permission: CompanionPermission): void {
    if (process.platform !== 'darwin' || this.disposing) return;
    if (this.permission === permission && this.stage === Stage.Guide) { this.open(permission); return; }
    // The card's page is written for one permission; another one starts over.
    if (this.permission && this.permission !== permission) this.close();
    this.start(permission, Stage.Intro);
    const bounds = resolvePermissionIntroBounds(COMPANION_PERMISSION_INTRO_SIZE,
      screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea);
    this.wantVisible = true;
    const win = this.browserWindow ?? this.createWindow(bounds);
    win.setBounds(bounds);
    if (!win.webContents.isLoadingMainFrame()) this.showIntro(win);
    console.log('[DesktopCompanion] Permission explained', { permission });
  }

  /** Opens the System Settings pane and guides the user there. */
  open(permission: CompanionPermission): void {
    if (process.platform !== 'darwin' || this.disposing) return;
    if (this.permission && this.permission !== permission) this.close();
    void this.services.openSettings(MAC_PERMISSION_SETTINGS[permission])
      .catch(error => console.warn('[DesktopCompanion] Could not open System Settings:', error));
    this.start(permission, Stage.Guide);
    clearTimeout(this.revealTimer);
    this.revealTimer = setTimeout(() => { void this.reveal(); }, REVEAL_FALLBACK_MS);
    console.log('[DesktopCompanion] Permission guide opened', { permission });
  }

  /** Shown while System Settings is in front, and while LobsterAI is: pressing the card activates it. */
  onForegroundChange(appId: string): void {
    this.frontAppId = appId;
    // The explanation is a dialog: it closes when it loses focus, wherever the user went.
    if (!this.permission || this.stage === Stage.Intro) return;
    if (appId === MAC_SYSTEM_SETTINGS_APP_ID) {
      clearTimeout(this.revealTimer);
      void this.reveal();
      return;
    }
    if (this.isSelf(appId)) {
      // A click on another LobsterAI window can focus it before the activation is reported.
      if (this.focusedElsewhere()) this.close();
      return;
    }
    clearTimeout(this.revealTimer);
    this.hideWindow();
  }

  close(): void {
    const wasActive = this.permission !== null;
    this.permission = null;
    this.stage = Stage.Guide;
    this.wantVisible = false;
    this.revealToken += 1;
    clearInterval(this.grantTimer);
    this.grantTimer = undefined;
    clearTimeout(this.revealTimer);
    clearTimeout(this.lifetimeTimer);
    this.stopWatchingSettings?.();
    this.stopWatchingSettings = null;
    // Each guide starts from a fresh page; the window is cheap and rarely needed.
    const win = this.window;
    this.window = null;
    if (win && !win.isDestroyed()) win.destroy();
    if (wasActive) console.log('[DesktopCompanion] Permission guide closed');
  }

  dispose(): void {
    this.disposing = true;
    this.close();
    ipcMain.removeHandler(CompanionPermissionGuideIpc.Info);
    ipcMain.removeHandler(CompanionPermissionGuideIpc.Proceed);
    ipcMain.removeHandler(CompanionPermissionGuideIpc.Close);
    ipcMain.removeHandler(CompanionPermissionGuideIpc.Relaunch);
    ipcMain.removeAllListeners(CompanionPermissionGuideIpc.Drag);
    app.removeListener('browser-window-focus', this.onWindowFocus);
  }

  private async info(): Promise<CompanionPermissionGuideInfo | null> {
    const permission = this.permission;
    if (!permission) return null;
    const guideApp = await this.loadApp();
    return {
      permission, stage: this.stage,
      paneKey: companionPermissionPaneKey(permission, Number.parseInt(os.release(), 10)),
      appName: guideApp?.name ?? app.getName(), appIcon: guideApp?.icon ?? null,
      relaunchRequired: companionPermissionNeedsRelaunch(permission),
    };
  }

  private start(permission: CompanionPermission, stage: Stage): void {
    this.permission = permission;
    this.stage = stage;
    clearTimeout(this.lifetimeTimer);
    this.lifetimeTimer = setTimeout(() => this.close(), GUIDE_LIFETIME_MS);
    if (!this.grantTimer) this.grantTimer = setInterval(this.checkGrant, GRANT_POLL_MS);
    // Closing its window quits System Settings: the guide beside it has nothing left to point at.
    this.stopWatchingSettings ??= this.services.onAppTerminated(appId => {
      if (appId !== MAC_SYSTEM_SETTINGS_APP_ID || this.stage !== Stage.Guide) return;
      console.log('[DesktopCompanion] System Settings quit; closing the permission guide');
      this.close();
    });
    void this.loadApp();
  }

  private proceed(): void {
    const permission = this.permission;
    if (!permission || this.stage !== Stage.Intro) return;
    this.host.requestAccess?.(permission);
    // Keep the card key but invisible until it moves beside System Settings: hiding the key window
    // of the active app would focus the main window, which counts as the user coming back.
    this.browserWindow?.setOpacity(0);
    this.open(permission);
  }

  private showIntro(win: BrowserWindow): void {
    win.setOpacity(1);
    win.show();
    win.focus();
  }

  private loadApp(): Promise<CompanionGuideApp | null> {
    if (this.app) return Promise.resolve(this.app);
    this.appLoading ??= this.services.loadApp()
      .then(result => { this.app = result; return result; })
      .catch((error: unknown): null => {
        console.warn('[DesktopCompanion] Could not read the app bundle for the permission guide:', error);
        return null;
      })
      .finally(() => { this.appLoading = null; });
    return this.appLoading;
  }

  private async reveal(): Promise<void> {
    const permission = this.permission;
    if (!permission) return;
    const token = ++this.revealToken;
    this.wantVisible = true;
    const stale = () => token !== this.revealToken || this.permission !== permission || this.disposing;
    // Wait for the window rather than guess: a card at the screen's bottom center sits under the sidebar.
    let settings: Rectangle | null = null;
    for (let attempt = 0; attempt < LOCATE_ATTEMPTS && !settings; attempt += 1) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, LOCATE_RETRY_MS));
      if (stale()) return;
      settings = await this.services.locateAppWindow(MAC_SYSTEM_SETTINGS_APP_ID).catch((error: unknown): null => {
        console.debug('[DesktopCompanion] System Settings window lookup failed:', error);
        return null;
      });
    }
    if (stale()) return;
    if (!settings) console.warn('[DesktopCompanion] System Settings window not found; placing the guide at the bottom of the screen');
    const display = settings ? screen.getDisplayMatching(settings) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const bounds = resolvePermissionGuideBounds(settings, companionPermissionGuideSize(permission), display.workArea);
    const win = this.browserWindow ?? this.createWindow(bounds);
    win.setBounds(bounds);
    win.setOpacity(1);
    if (!win.webContents.isLoadingMainFrame()) win.showInactive();
  }

  private createWindow(bounds: Rectangle): BrowserWindow {
    const win = this.host.createWindow(bounds);
    this.window = win;
    win.once('ready-to-show', () => {
      if (!this.wantVisible || this.window !== win || win.isDestroyed()) return;
      if (this.stage === Stage.Intro) this.showIntro(win);
      else win.showInactive();
    });
    dismissCompanionPanelOnBlur(win, () => this.close(), () => this.stage === Stage.Intro);
    // The card is key-capable, so Cmd+W reaches it: treat that like its close button.
    win.on('close', event => { if (!this.disposing) { event.preventDefault(); this.close(); } });
    win.on('closed', () => { if (this.window === win) this.window = null; });
    return win;
  }

  private hideWindow(): void {
    this.wantVisible = false;
    this.revealToken += 1;
    this.browserWindow?.hide();
  }

  private startDrag(contents: WebContents): void {
    const guideApp = this.app;
    if (!this.permission || !guideApp?.dragIcon) return;
    contents.startDrag({ file: guideApp.path, icon: guideApp.dragIcon });
  }

  private readonly checkGrant = (): void => {
    const permission = this.permission;
    if (!permission || !this.services.isGranted(permission)) return;
    console.log('[DesktopCompanion] Permission granted while the guide was open', { permission });
    this.close();
    this.host.onGranted(permission);
  };

  private isSelf(appId: string | null): boolean {
    return categorizeCompanionApp(appId) === CompanionAppCategory.Self;
  }

  private focusedElsewhere(): boolean {
    const focused = this.services.focusedWindow();
    return !!focused && focused !== this.window;
  }

  /**
   * Coming back to any other LobsterAI window ends the guide; System Settings keeps whatever the user did.
   * Hiding the card after the user pressed it hands key focus to another LobsterAI window while some
   * other app is in front: that is not the user coming back.
   */
  private readonly onWindowFocus = (_event: unknown, win: BrowserWindow): void => {
    if (!this.permission || win === this.window || !this.isSelf(this.frontAppId)) return;
    this.close();
  };
}
