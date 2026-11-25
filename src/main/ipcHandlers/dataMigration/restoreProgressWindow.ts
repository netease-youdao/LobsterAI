import { BrowserWindow, nativeTheme } from 'electron';

import {
  type DataMigrationProgressEvent,
  DataMigrationProgressPhase,
} from '../../../shared/dataMigration/constants';
import { t } from '../../i18n';

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const resolvePhaseLabel = (phase: DataMigrationProgressPhase): string => {
  switch (phase) {
    case DataMigrationProgressPhase.CheckingSpace:
      return t('dataMigrationPhaseCheckingSpace');
    case DataMigrationProgressPhase.CreatingRollback:
      return t('dataMigrationPhaseCreatingRollback');
    case DataMigrationProgressPhase.ExtractingArchive:
      return t('dataMigrationPhaseExtracting');
    case DataMigrationProgressPhase.SanitizingData:
      return t('dataMigrationPhaseSanitizing');
    case DataMigrationProgressPhase.ApplyingData:
      return t('dataMigrationPhaseApplying');
    case DataMigrationProgressPhase.Completed:
      return t('dataMigrationPhaseCompleted');
    default:
      return t('dataMigrationRestoreProgressDesc');
  }
};

export interface RestoreProgressWindowController {
  getWindow(): BrowserWindow | null;
  show(): Promise<void>;
  updateProgress(event: DataMigrationProgressEvent): void;
  releaseRendererWindows(): Promise<void>;
}

export function createRestoreProgressWindowController(): RestoreProgressWindowController {
  let progressWindow: BrowserWindow | null = null;

  const show = async (): Promise<void> => {
    if (progressWindow && !progressWindow.isDestroyed()) {
      progressWindow.show();
      progressWindow.focus();
      return;
    }

    const dark = nativeTheme.shouldUseDarkColors;
    const windowTitle = t('dataMigrationRestoreProgressTitle');
    const title = escapeHtml(windowTitle);
    const desc = escapeHtml(t('dataMigrationRestoreProgressDesc'));
    const warning = escapeHtml(t('dataMigrationRestoreProgressWarning'));
    const background = dark ? '#111827' : '#f8fafc';
    const surface = dark ? '#1f2937' : '#ffffff';
    const foreground = dark ? '#f9fafb' : '#111827';
    const secondary = dark ? '#d1d5db' : '#4b5563';
    const border = dark ? '#374151' : '#e5e7eb';
    const track = dark ? '#374151' : '#e5e7eb';
    const primary = '#2563eb';
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: ${background};
      color: ${foreground};
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .panel {
      width: min(380px, calc(100vw - 40px));
      border: 1px solid ${border};
      border-radius: 14px;
      background: ${surface};
      padding: 28px 24px;
      text-align: center;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.18);
    }
    .spinner {
      width: 42px;
      height: 42px;
      margin: 0 auto 18px;
      border-radius: 999px;
      border: 4px solid rgba(37, 99, 235, 0.18);
      border-top-color: ${primary};
      animation: spin 0.9s linear infinite;
    }
    h1 {
      margin: 0;
      font-size: 17px;
      line-height: 1.4;
      font-weight: 650;
    }
    p {
      margin: 12px 0 0;
      color: ${secondary};
      font-size: 13px;
      line-height: 1.65;
    }
    .bar-track {
      margin-top: 16px;
      width: 100%;
      height: 6px;
      border-radius: 999px;
      background: ${track};
      overflow: hidden;
    }
    .bar-fill {
      width: 12%;
      height: 100%;
      border-radius: 999px;
      background: ${primary};
      transition: width 0.25s ease;
    }
    .warning {
      margin-top: 18px;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(245, 158, 11, 0.12);
      color: ${dark ? '#fde68a' : '#92400e'};
      text-align: left;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <main class="panel">
    <div class="spinner" aria-hidden="true"></div>
    <h1>${title}</h1>
    <p id="phase-desc">${desc}</p>
    <div class="bar-track" aria-hidden="true"><div id="bar-fill" class="bar-fill"></div></div>
    <p class="warning">${warning}</p>
  </main>
</body>
</html>`;

    const win = new BrowserWindow({
      width: 460,
      height: 320,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: windowTitle,
      autoHideMenuBar: true,
      backgroundColor: background,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: `data-migration-restore-${Date.now()}`,
      },
    });
    progressWindow = win;
    win.setMenu(null);
    win.on('closed', () => {
      if (progressWindow === win) {
        progressWindow = null;
      }
    });

    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    } catch (error) {
      console.warn('[DataMigration] failed to load restore progress window:', error);
    }
    if (!win.isDestroyed()) {
      win.show();
      win.focus();
    }
  };

  const updateProgress = (event: DataMigrationProgressEvent): void => {
    if (!progressWindow || progressWindow.isDestroyed()) return;
    const label = resolvePhaseLabel(event.phase);
    const pct = typeof event.percent === 'number'
      ? Math.max(5, Math.min(100, Math.round(event.percent)))
      : 50;
    const script = `(() => {
      const descEl = document.getElementById('phase-desc');
      if (descEl) descEl.textContent = ${JSON.stringify(label)};
      const barEl = document.getElementById('bar-fill');
      if (barEl) barEl.style.width = '${pct}%';
    })();`;
    void progressWindow.webContents.executeJavaScript(script).catch((): void => undefined);
  };

  const releaseRendererWindows = async (): Promise<void> => {
    const windows = BrowserWindow.getAllWindows()
      .filter(win => !win.isDestroyed() && win !== progressWindow);
    if (windows.length === 0) return;

    console.log(`[DataMigration] closing ${windows.length} renderer window(s) before restore.`);
    await Promise.all(windows.map(win => new Promise<void>(resolve => {
      let resolved = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        if (timeout) clearTimeout(timeout);
        resolve();
      };
      timeout = setTimeout(finish, 3_000);
      win.once('closed', finish);
      try {
        win.destroy();
      } catch (error) {
        console.warn('[DataMigration] failed to destroy renderer window before restore:', error);
        finish();
      }
    })));

    // Give Chromium a short window to release LevelDB handles on Windows.
    await new Promise(resolve => { setTimeout(resolve, 500); });
  };

  return {
    getWindow: () => progressWindow,
    show,
    updateProgress,
    releaseRendererWindows,
  };
}
