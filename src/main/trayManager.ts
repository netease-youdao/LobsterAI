import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';
import path from 'path';

import { APP_NAME } from './appConstants';
import { t } from './i18n';

let tray: Tray | null = null;
let contextMenu: Menu | null = null;
let clickHandler: (() => void) | null = null;
let rightClickHandler: (() => void) | null = null;
let trayReminder: TrayReminderState = { count: 0 };
let companionActions: TrayCompanionActions | undefined;

interface TrayCompanionActions {
  isEnabled(): boolean;
  toggleEnabled(): void;
  openPanel(): void;
}

export interface TrayReminderState {
  count: number;
  onClick?: () => void;
}

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

function getLabels(): {
  showWindow: string;
  newTask: string;
  viewCompletedTask: string;
  settings: string;
  quit: string;
} {
  return {
    showWindow: t('trayShowWindow'),
    newTask: t('trayNewTask'),
    viewCompletedTask: t('trayViewCompletedTask'),
    settings: t('traySettings'),
    quit: t('trayQuit'),
  };
}

function buildContextMenu(getWindow: () => BrowserWindow | null): Menu {
  const labels = getLabels();

  return Menu.buildFromTemplate([
    ...(trayReminder.count > 0
      ? [
          {
            label: labels.viewCompletedTask,
            click: () => trayReminder.onClick?.(),
          },
          { type: 'separator' as const },
        ]
      : []),
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
    ...(companionActions ? [
      { label: t('desktopCompanionOpenPanel'), click: () => companionActions?.openPanel() },
      {
        label: t('desktopCompanionEnable'),
        type: 'checkbox' as const,
        checked: companionActions.isEnabled(),
        click: () => companionActions?.toggleEnabled(),
      },
      { type: 'separator' as const },
    ] : []),
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

export function createTray(getWindow: () => BrowserWindow | null, actions?: TrayCompanionActions): Tray {
  companionActions = actions ?? companionActions;
  if (tray) {
    updateTrayMenu(getWindow);
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
  tray.setToolTip(resolveTrayTooltip());

  contextMenu = buildContextMenu(getWindow);

  clickHandler = () => {
    if (trayReminder.count > 0) {
      trayReminder.onClick?.();
      return;
    }
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
  tray.setToolTip(resolveTrayTooltip());
}

export function updateTrayReminder(
  getWindow: () => BrowserWindow | null,
  reminder: TrayReminderState,
): void {
  trayReminder = reminder;
  updateTrayMenu(getWindow);
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
    trayReminder = { count: 0 };
    companionActions = undefined;
  }
}

function resolveTrayTooltip(): string {
  if (trayReminder.count > 0) {
    return t('trayCompletedTaskTooltip', { count: trayReminder.count });
  }
  return APP_NAME;
}
