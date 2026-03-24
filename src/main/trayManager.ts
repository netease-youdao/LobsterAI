import { app, Tray, Menu, nativeImage, BrowserWindow } from 'electron';
import path from 'path';
import { APP_NAME } from './appConstants';
import { t } from './i18n';

let tray: Tray | null = null;
let contextMenu: Menu | null = null;
let clickHandler: (() => void) | null = null;
let rightClickHandler: (() => void) | null = null;

function getTrayIconPath(): string {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';

  const basePath = app.isPackaged
    ? path.join(process.resourcesPath, 'tray')
    : path.join(__dirname, '..', 'resources', 'tray');

  if (isMac) {
    return path.join(basePath, 'tray-icon-mac.png');
  }
  if (isWin) {
    return path.join(basePath, 'tray-icon.ico');
  }
  // Linux
  return path.join(basePath, 'tray-icon.png');
}

function getLabels(): { showWindow: string; newTask: string; settings: string; quit: string } {
  return {
    showWindow: t('trayShowWindow'),
    newTask: t('trayNewTask'),
    settings: t('traySettings'),
    quit: t('trayQuit'),
  };
}

function buildContextMenu(getWindow: () => BrowserWindow | null): Menu {
  const labels = getLabels();

  return Menu.buildFromTemplate([
    {
      label: labels.showWindow,
      click: () => {
        const win = getWindow();
        if (win && !win.isDestroyed()) {
          if (!win.isVisible()) win.show();
          if (!win.isFocused()) win.focus();
        }
      },
    },
    {
      label: labels.newTask,
      click: () => {
        const win = getWindow();
        if (win && !win.isDestroyed()) {
          if (!win.isVisible()) win.show();
          if (!win.isFocused()) win.focus();
          win.webContents.send('app:newTask');
        }
      },
    },
    { type: 'separator' },
    {
      label: labels.settings,
      click: () => {
        const win = getWindow();
        if (win && !win.isDestroyed()) {
          if (!win.isVisible()) win.show();
          if (!win.isFocused()) win.focus();
          win.webContents.send('app:openSettings');
        }
      },
    },
    { type: 'separator' },
    {
      label: labels.quit,
      click: () => {
        app.quit();
      },
    },
  ]);
}

export function createTray(getWindow: () => BrowserWindow | null): Tray {
  if (tray) {
    return tray;
  }

  const iconPath = getTrayIconPath();
  let icon = nativeImage.createFromPath(iconPath);

  if (process.platform === 'darwin') {
    icon.setTemplateImage(false);
    // Keep the tray icon within macOS menu bar bounds.
    if (icon.getSize().height > 18) {
      icon = icon.resize({ height: 18 });
      icon.setTemplateImage(false);
    }
  }

  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);

  contextMenu = buildContextMenu(getWindow);

  clickHandler = () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) win.show();
    if (!win.isFocused()) win.focus();
  };

  rightClickHandler = () => {
    if (contextMenu) {
      tray?.popUpContextMenu(contextMenu);
    }
  };

  tray.on('click', clickHandler);
  tray.on('right-click', rightClickHandler);

  return tray;
}

export function updateTrayMenu(getWindow: () => BrowserWindow | null): void {
  if (!tray) return;
  contextMenu = buildContextMenu(getWindow);
}

export function destroyTray(): void {
  if (tray) {
    if (clickHandler) tray.removeListener('click', clickHandler);
    if (rightClickHandler) tray.removeListener('right-click', rightClickHandler);
    tray.destroy();
    tray = null;
    contextMenu = null;
    clickHandler = null;
    rightClickHandler = null;
  }
}
