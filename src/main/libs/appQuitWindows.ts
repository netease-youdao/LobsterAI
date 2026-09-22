import { BrowserWindow } from 'electron';

/** Give immediate feedback while keeping renderers alive for graceful cleanup. */
export function hideAppWindowsForQuit(): void {
  const startedAt = Date.now();
  let hiddenCount = 0;
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    try {
      window.hide();
      hiddenCount += 1;
    } catch (error) {
      console.warn('[AppQuit] failed to hide a window before cleanup:', error);
    }
  }
  console.log(`[AppQuit] Hid ${hiddenCount} windows before cleanup in ${Date.now() - startedAt}ms`);
}
