import { BrowserWindow, dialog } from 'electron';

import { t } from './i18n';

export const StartupRecoveryAction = {
  Restart: 'https://startup-recovery.invalid/restart',
  Logs: 'https://startup-recovery.invalid/logs',
  Quit: 'https://startup-recovery.invalid/quit',
} as const;
interface RecoveryActions { restart(): void; showLogs(): void; quit(): void }
let recoveryWindow: BrowserWindow | null = null;
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));

/** Independent of the task store, its preload and all execution/ownership APIs. */
export function showStartupRecoveryWindow(actions: RecoveryActions): void {
  if (recoveryWindow && !recoveryWindow.isDestroyed()) {
    if (recoveryWindow.isMinimized()) recoveryWindow.restore();
    recoveryWindow.show(); recoveryWindow.focus(); return;
  }
  const title = t('startupRecoveryTitle');
  try {
    const window = new BrowserWindow({
      width: 600, height: 350, resizable: false, minimizable: true, maximizable: false,
      title, autoHideMenuBar: true, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false, webviewTag: false },
    });
    recoveryWindow = window;
    let leaving = false;
    const quit = () => { if (!leaving) { leaving = true; actions.quit(); } };
    const html = `<!doctype html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
      <title>${escapeHtml(title)}</title><style>
      body{font:15px/1.6 system-ui,sans-serif;margin:32px;color:#17212b;background:#fafafa}
      h1{font-size:23px}p{margin:14px 0}nav{display:flex;gap:12px;margin-top:24px}
      a{padding:8px 12px;border:1px solid #ccd1d7;border-radius:6px;color:#174a88;text-decoration:none}
      </style></head><body><h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(t('startupRecoveryDescription'))}</p><p>${escapeHtml(t('startupRecoverySafety'))}</p><nav>
      <a href="${StartupRecoveryAction.Restart}">${escapeHtml(t('startupRecoveryRestart'))}</a>
      <a href="${StartupRecoveryAction.Logs}">${escapeHtml(t('startupRecoveryLogs'))}</a>
      <a href="${StartupRecoveryAction.Quit}">${escapeHtml(t('startupRecoveryQuit'))}</a>
      </nav></body></html>`;
    const documentUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (leaving || window.webContents.getURL() !== documentUrl) return;
      try {
        if (url === StartupRecoveryAction.Restart) { leaving = true; actions.restart(); }
        else if (url === StartupRecoveryAction.Logs) actions.showLogs();
        else if (url === StartupRecoveryAction.Quit) quit();
      } catch (error) { leaving = false; console.error('[StartupRecovery] Recovery action failed:', error); }
    });
    window.webContents.on('will-redirect', event => event.preventDefault());
    window.on('closed', () => { recoveryWindow = null; quit(); });
    void window.loadURL(documentUrl).then(() => {
      if (!window.isDestroyed()) { window.show(); window.focus(); }
    }).catch(error => {
      console.error('[StartupRecovery] Failed to load recovery window:', error);
      dialog.showErrorBox(title, t('startupRecoveryDescription'));
      if (!window.isDestroyed()) window.show();
    });
  } catch (error) {
    console.error('[StartupRecovery] Failed to create recovery window:', error);
    dialog.showErrorBox(title, t('startupRecoveryDescription'));
  }
}
