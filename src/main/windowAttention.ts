import { app, BrowserWindow } from 'electron';

/**
 * Request the OS-level attention signal for the main window when the user
 * cannot see it (minimized or unfocused).
 *
 * - Windows: flashes the taskbar icon orange until the window is focused.
 * - macOS:   bounces the Dock icon once (informational, non-intrusive).
 * - Linux:   no-op (no equivalent Electron API available).
 */
export function requestWindowAttention(win: BrowserWindow): void {
  if (!win.isMinimized() && win.isFocused()) {
    return;
  }

  if (process.platform === 'win32') {
    win.flashFrame(true);
  } else if (process.platform === 'darwin') {
    app.dock?.bounce('informational');
  }
}
