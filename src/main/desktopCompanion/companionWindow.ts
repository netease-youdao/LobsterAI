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
/** Focus requests for a macOS panel that has not become key since it was shown. */
const PANEL_REFOCUS_ATTEMPTS = 2;

/** Dismiss interactive panels on blur, preserving passive notifications and native dialogs. */
export function dismissCompanionPanelOnBlur(win: BrowserWindow, dismiss: () => void, shouldDismiss = () => true): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let focusTimer: ReturnType<typeof setInterval> | undefined;
  let sheetOpen = false;
  // Clicking the orb can leave a macOS panel still marked key after it hides. The next
  // show() then cannot make it key, so it opens without focus: no outside click took it.
  let focusedWhileShown = false;
  let refocusAttempts = 0;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  const neverFocused = () => process.platform === 'darwin' && !focusedWhileShown;
  const scheduleDismiss = () => {
    if (timer) return;
    // Native dialogs may begin just after blur. Allow them to establish their
    // sheet/disabled-owner state before deciding this was an outside click.
    timer = setTimeout(() => {
      timer = undefined;
      if (win.isDestroyed() || !win.isVisible() || !shouldDismiss() || win.isFocused() || neverFocused() || sheetOpen || !win.isEnabled()) return;
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
    // Occlusion also emits `show` for a window that stayed open; it only adds evidence of focus.
    if (win.isFocused()) focusedWhileShown = true;
    if (process.platform !== 'darwin') return;
    focusTimer = setInterval(() => {
      if (win.isDestroyed() || !win.isVisible()) { stop(); return; }
      if (win.isFocused()) { focusedWhileShown = true; cancel(); return; }
      if (!shouldDismiss()) { cancel(); return; }
      if (focusedWhileShown) { scheduleDismiss(); return; }
      // Ask again once AppKit has settled which window is key; never dismiss a panel for focus it never had.
      if (refocusAttempts < PANEL_REFOCUS_ATTEMPTS) {
        refocusAttempts += 1;
        console.debug(`[DesktopCompanion] Panel opened without key focus; requesting it (attempt ${refocusAttempts})`);
        win.focus();
      }
    }, PANEL_BLUR_DELAY_MS);
  };
  win.on('blur', scheduleDismiss);
  win.on('show', watchFocus);
  win.on('sheet-begin', () => { sheetOpen = true; cancel(); });
  win.on('sheet-end', () => { sheetOpen = false; });
  win.on('focus', () => {
    if (win.isVisible()) focusedWhileShown = true;
    cancel();
  });
  // A delayed native hide notification may belong to an earlier opening.
  win.on('hide', () => {
    if (win.isVisible()) return;
    focusedWhileShown = false;
    refocusAttempts = 0;
    stop();
  });
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
    // Use WS_EX_TOOLWINDOW so Windows excludes companion surfaces from taskbar
    // previews even when they are shown again after skipTaskbar removed the tab.
    ...(process.platform === 'win32' ? { type: 'toolbar' as const } : {}),
    // macOS shows only panel windows over another app's full-screen Space, so a task card needs it too.
    // Its occlusion `hide` events (app switch, Space change) leave the window visible; handlers check isVisible().
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    webPreferences: {
      preload: env.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      navigateOnDragDrop: false,
      spellcheck: false,
      // Reopening waits for a freshly painted composer frame while the window is hidden. The selection
      // toolbar and the stage are placed by the size their renderer measures in an animation frame,
      // which a hidden, throttled page never runs: they would open at the default size, then jump.
      ...(options.surface === DesktopCompanionSurface.Panel || isSelection || options.surface === DesktopCompanionSurface.Stage
        ? { backgroundThrottling: false } : {}),
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
