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

/** Every companion surface is a transparent, frameless, always-on-top window loading the same entry. */
export function createCompanionWindow(env: CompanionWindowEnvironment, options: CompanionWindowOptions): BrowserWindow {
  const isSelection = options.surface === DesktopCompanionSurface.Selection;
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
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: options.focusable,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    webPreferences: {
      preload: env.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      navigateOnDragDrop: false,
      spellcheck: false,
      ...(options.surface === DesktopCompanionSurface.LanguageTools ? { autoplayPolicy: 'no-user-gesture-required' as const } : {}),
    },
  });
  win.setMenu(null);
  // The selection toolbar sits above menus of the app it is attached to.
  win.setAlwaysOnTop(true, isSelection ? 'pop-up-menu' : 'floating');
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: isSelection, skipTransformProcessType: true });
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  const loading = env.devServerUrl
    ? win.loadURL(new URL(`desktop-companion.html?surface=${options.surface}`, env.devServerUrl).href)
    : win.loadFile(path.join(env.rendererDirectory, 'desktop-companion.html'), { query: { surface: options.surface } });
  void loading.catch(error => console.error(`[DesktopCompanion] ${options.surface} renderer failed to load`, error));
  return win;
}
