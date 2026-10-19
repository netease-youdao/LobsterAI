import { BrowserWindow, type Rectangle } from 'electron';
import path from 'path';

import { DesktopCompanionSurface } from '../../shared/desktopCompanion/constants';

export interface CompanionWindowEnvironment {
  preloadPath: string;
  rendererDirectory: string;
  devServerUrl?: string;
  title: string;
}

export interface CompanionWindowOptions {
  surface: DesktopCompanionSurface;
  bounds: Rectangle;
  focusable: boolean;
}

const PANEL_BLUR_DELAY_MS = 120;

/** Dismiss interactive panels on blur, preserving passive notifications and native dialogs. */
export function dismissCompanionPanelOnBlur(win: BrowserWindow, dismiss: () => void, shouldDismiss = () => true): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let focusTimer: ReturnType<typeof setInterval> | undefined;
  let sheetOpen = false;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  const scheduleDismiss = () => {
    if (timer) return;
    // Native dialogs may begin just after blur. Allow them to establish their
    // sheet/disabled-owner state before deciding this was an outside click.
    timer = setTimeout(() => {
      timer = undefined;
      if (win.isDestroyed() || !win.isVisible() || !shouldDismiss() || win.isFocused() || sheetOpen || !win.isEnabled()) return;
      if (win.getChildWindows().some(child => !child.isDestroyed() && child.isVisible() && child.isModal())) return;
      dismiss();
    }, PANEL_BLUR_DELAY_MS);
  };
  const stop = () => {
    cancel();
    clearInterval(focusTimer);
    focusTimer = undefined;
  };
  // macOS nonactivating panels can lose key-window status without resigning
  // main-window status (the source of Electron's blur event). Check key focus
  // only while shown. Task notifications intentionally cannot take focus;
  // opening a follow-up makes the same visible window focusable again.
  const watchFocus = () => {
    stop();
    if (process.platform !== 'darwin') return;
    focusTimer = setInterval(() => {
      if (win.isDestroyed() || !win.isVisible()) { stop(); return; }
      if (!shouldDismiss() || win.isFocused()) cancel();
      else scheduleDismiss();
    }, PANEL_BLUR_DELAY_MS);
  };
  win.on('blur', scheduleDismiss);
  win.on('show', watchFocus);
  win.on('sheet-begin', () => { sheetOpen = true; cancel(); });
  win.on('sheet-end', () => { sheetOpen = false; });
  win.on('focus', cancel);
  // A delayed native hide notification may belong to an earlier opening.
  win.on('hide', () => { if (!win.isVisible()) stop(); });
  win.on('closed', stop);
}

/** Companion surfaces are transparent, frameless, always-on-top windows. */
export function createCompanionWindow(env: CompanionWindowEnvironment, options: CompanionWindowOptions): BrowserWindow {
  const isSelection = options.surface === DesktopCompanionSurface.Selection;
  const isScreenshot = options.surface === DesktopCompanionSurface.Screenshot;
  const win = new BrowserWindow({
    ...options.bounds,
    title: env.title,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // Cards draw their own soft shadow inside a transparent margin.
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    enableLargerThanScreen: isScreenshot,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: options.focusable,
    // Native panels can hide on app deactivation even when our result card is pinned.
    ...(process.platform === 'darwin' && options.surface !== DesktopCompanionSurface.Result ? { type: 'panel' as const } : {}),
    webPreferences: {
      preload: env.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      navigateOnDragDrop: false,
      spellcheck: false,
      // Reopening waits for a freshly painted composer frame while the window is hidden.
      ...(options.surface === DesktopCompanionSurface.Panel ? { backgroundThrottling: false } : {}),
      ...(options.surface === DesktopCompanionSurface.LanguageTools ? { autoplayPolicy: 'no-user-gesture-required' as const } : {}),
    },
  });
  win.setMenu(null);
  if (process.platform === 'win32' && isScreenshot) {
    // Windows clamps initial bounds to the work area, even for frameless windows.
    // Restore the full display before loading the image, otherwise it is squeezed
    // above the real taskbar and both the preview and crop coordinates are wrong.
    win.setBounds(options.bounds);
  }
  // The selection toolbar sits above menus of the app it is attached to.
  win.setAlwaysOnTop(true, isScreenshot ? 'screen-saver' : isSelection ? 'pop-up-menu' : 'floating');
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: isSelection || isScreenshot, skipTransformProcessType: true });
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  // The quick panel runs the home page's composer, which needs the main renderer's styles and store.
  // Screenshot selection must not wait for chat, Markdown, or language-tool modules to initialize.
  const page = isScreenshot ? 'companion-screenshot.html'
    : options.surface === DesktopCompanionSurface.Panel ? 'companion-composer.html' : 'desktop-companion.html';
  const loading = env.devServerUrl
    ? win.loadURL(new URL(`${page}?surface=${options.surface}`, env.devServerUrl).href)
    : win.loadFile(path.join(env.rendererDirectory, page), { query: { surface: options.surface } });
  void loading.catch(error => console.error(`[DesktopCompanion] ${options.surface} renderer failed to load`, error));
  return win;
}
