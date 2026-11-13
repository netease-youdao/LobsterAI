import {
  app,
  BrowserWindow,
  type Event,
  type Input,
  ipcMain,
  type IpcMainEvent,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  type MouseInputEvent,
  nativeImage,
  screen,
  type WebContents,
  webContents,
} from 'electron';
import path from 'path';

import { AppQuitDialogIpc } from '../../shared/dialog/appQuitConfirmation';
import { getLanguage } from '../i18n';

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

let revealActiveDialog: (() => void) | null = null;

/** Reuse the existing prompt when the user asks to quit again. */
export function focusAppQuitDialog(): void {
  revealActiveDialog?.();
}

/** Keep background pages inert without macOS's translucent setEnabled(false) sheet. */
function blockBackgroundInput(dialogWindow: BrowserWindow): () => void {
  const cleanups = new Map<WebContents, () => void>();
  const register = (contents: WebContents): void => {
    if (dialogWindow.isDestroyed() || contents.isDestroyed() || contents === dialogWindow.webContents || cleanups.has(contents)) return;
    const shouldBlock = (): boolean => {
      if (dialogWindow.isDestroyed() || !dialogWindow.isVisible() || contents.isDestroyed()) return false;
      const owner = BrowserWindow.fromWebContents(contents);
      return !!owner && owner !== dialogWindow && !owner.isDestroyed() && owner.isVisible() && !owner.isMinimized();
    };
    const onKeyboardInput = (event: Event, input: Input): void => {
      if (!shouldBlock()) return;
      event.preventDefault();
      if (input.type === 'keyDown') dialogWindow.focus();
    };
    const onMouseInput = (event: Event, input: MouseInputEvent): void => {
      if (!shouldBlock()) return;
      event.preventDefault();
      // Hovering the background must not reactivate the app after an app switch.
      if (input.type === 'mouseDown') dialogWindow.focus();
    };
    const cleanup = (): void => {
      contents.removeListener('before-input-event', onKeyboardInput);
      contents.removeListener('before-mouse-event', onMouseInput);
      contents.removeListener('destroyed', cleanup);
      cleanups.delete(contents);
    };
    cleanups.set(contents, cleanup);
    contents.on('before-input-event', onKeyboardInput);
    contents.on('before-mouse-event', onMouseInput);
    contents.once('destroyed', cleanup);
  };
  const onCreated = (_event: Event, contents: WebContents): void => register(contents);
  app.on('web-contents-created', onCreated);
  for (const contents of webContents.getAllWebContents()) register(contents);
  return () => {
    app.removeListener('web-contents-created', onCreated);
    for (const cleanup of cleanups.values()) cleanup();
  };
}

function buildDialogHtml(options: MessageBoxOptions, icon: string): string {
  const details = (options.detail ?? '').split('\n\n');
  const description = details.pop() ?? '';
  const buttons = (options.buttons ?? []).map((label, index) => (
    `<button data-response="${index}"${index === options.defaultId ? ' autofocus class="primary"' : ''}>${escapeHtml(label)}</button>`
  ));
  // Keep the reference layout: Cancel on the left, Quit on the right.
  buttons.reverse();

  return `<!doctype html>
<html lang="${getLanguage()}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(options.title ?? '')}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; background: transparent; overflow: hidden; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #292929; user-select: none; }
    main { width: max-content; min-width: 0; padding: 28px 24px 20px; border: 1px solid #c9c9c9; border-radius: 22px; background: #faf9fa; text-align: center; }
    img { display: block; width: 56px; height: 56px; margin: 0 auto 20px; }
    h1 { margin: 0; font-size: 17px; font-weight: 600; line-height: 24px; }
    p { margin: 12px 0 0; font-size: 13px; line-height: 20px; }
    .description { white-space: nowrap; }
    .warning { max-width: 480px; margin: 12px auto 0; }
    .buttons { display: flex; justify-content: center; gap: 12px; margin-top: 22px; }
    button { flex: 0 0 116px; height: 32px; padding: 0 16px; border: 0; border-radius: 10px; background: #eaeaea; color: inherit; font: inherit; font-size: 14px; cursor: pointer; }
    button.primary { background: #007aff; color: #fff; font-weight: 600; }
    button:hover { filter: brightness(.96); }
    button:active { filter: brightness(.9); }
    button:focus-visible { outline: 2px solid #80baff; outline-offset: 2px; }
    @media (prefers-color-scheme: dark) {
      body { color: #f5f5f5; }
      main { background: #282828; border-color: #555; }
      button { background: #454545; }
      button.primary { background: #0a84ff; }
    }
  </style>
</head>
<body>
  <main id="quit-dialog" role="alertdialog" aria-modal="true" aria-labelledby="quit-title" aria-describedby="quit-description${details.length ? ' quit-warning' : ''}">
    <img src="${escapeHtml(icon)}" alt="" draggable="false">
    <h1 id="quit-title">${escapeHtml(options.message)}</h1>
    ${details.length ? `<p id="quit-warning" class="warning">${details.map(escapeHtml).join('<br>')}</p>` : ''}
    <p id="quit-description" class="description">${escapeHtml(description)}</p>
    <div class="buttons">${buttons.join('')}</div>
  </main>
</body>
</html>`;
}

/** Keep the confirmation in the app's window group, centered over its owner. */
export async function showAppQuitDialog(
  options: MessageBoxOptions,
  ownerWindow?: BrowserWindow | null,
): Promise<MessageBoxReturnValue> {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app-icon/512x512.png')
    : path.join(app.getAppPath(), 'build/icons/png/512x512.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) throw new Error('Quit confirmation app icon is unavailable');

  const focusedWindow = BrowserWindow.getFocusedWindow();
  const candidateOwner = ownerWindow ?? (focusedWindow?.isAlwaysOnTop() ? null : focusedWindow);
  const anchorWindow = candidateOwner && !candidateOwner.isDestroyed() ? candidateOwner : undefined;
  const restoreOwner = (): void => {
    if (!anchorWindow || anchorWindow.isDestroyed()) return;
    // A tray quit should have the app behind its dialog, not another app.
    if (anchorWindow.isMinimized()) anchorWindow.restore();
    if (!anchorWindow.isVisible()) anchorWindow.show();
  };
  restoreOwner();
  anchorWindow?.focus();
  const window = new BrowserWindow({
    title: options.title,
    parent: anchorWindow,
    width: 420,
    height: 240,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist-electron/appQuitConfirmationPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());

  return new Promise((resolve, reject) => {
    let response = options.cancelId ?? 1;
    let failure: Error | undefined;
    let ready = false;
    let restoreFocusOnCancel = false;
    let dialogSize: { width: number; height: number } | null = null;
    let removeInputGuards: (() => void) | undefined;
    const isDialogSender = (event: IpcMainEvent): boolean => (
      !window.isDestroyed()
      && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame
    );
    const fail = (error: Error): void => {
      failure = error;
      if (!window.isDestroyed()) window.destroy();
    };
    const timeout = setTimeout(() => fail(new Error('Quit confirmation did not become ready')), 10_000);
    const positionDialog = (): void => {
      if (!dialogSize || window.isDestroyed()) return;
      const anchorBounds = anchorWindow && !anchorWindow.isDestroyed()
        && anchorWindow.isVisible() && !anchorWindow.isMinimized()
        ? anchorWindow.getBounds()
        : null;
      const workArea = (anchorBounds
        ? screen.getDisplayMatching(anchorBounds)
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea;
      const centerBounds = anchorBounds ?? workArea;
      const margin = 16;
      const zoom = Math.min(1, (workArea.width - margin * 2) / dialogSize.width, (workArea.height - margin * 2) / dialogSize.height);
      const width = Math.ceil(dialogSize.width * zoom);
      const height = Math.ceil(dialogSize.height * zoom);
      const x = Math.round(centerBounds.x + (centerBounds.width - width) / 2);
      const y = Math.round(centerBounds.y + (centerBounds.height - height) / 2);
      window.webContents.setZoomFactor(zoom);
      window.setBounds({
        x: Math.max(workArea.x + margin, Math.min(x, workArea.x + workArea.width - width - margin)),
        y: Math.max(workArea.y + margin, Math.min(y, workArea.y + workArea.height - height - margin)),
        width,
        height,
      });
    };
    const showDialog = (focus: boolean): void => {
      if (!ready || window.isDestroyed()) return;
      if (anchorWindow && (anchorWindow.isDestroyed() || !anchorWindow.isVisible() || anchorWindow.isMinimized())) return;
      positionDialog();
      removeInputGuards ??= blockBackgroundInput(window);
      // Showing after layout or an owner restore must not steal focus from another app.
      if (!window.isVisible()) window.showInactive();
      if (focus) window.focus();
    };
    const onOwnerFocus = (): void => showDialog(true);
    const onOwnerShow = (): void => showDialog(false);
    const onOwnerHide = (): void => {
      if (!window.isDestroyed()) window.hide();
    };
    const onOwnerClosed = (): void => {
      if (!window.isDestroyed()) window.destroy();
    };
    const revealDialog = (): void => {
      if (window.isDestroyed()) return;
      // Called only by a new, explicit quit request, never by a blur event.
      restoreOwner();
      if (ready) showDialog(true);
      else anchorWindow?.focus();
    };
    revealActiveDialog = revealDialog;
    anchorWindow?.on('move', positionDialog);
    anchorWindow?.on('resize', positionDialog);
    anchorWindow?.on('focus', onOwnerFocus);
    anchorWindow?.on('show', onOwnerShow);
    anchorWindow?.on('restore', onOwnerShow);
    anchorWindow?.on('hide', onOwnerHide);
    anchorWindow?.on('minimize', onOwnerHide);
    anchorWindow?.on('closed', onOwnerClosed);
    app.on('activate', onOwnerFocus);

    const onReady = (event: IpcMainEvent, size: { width?: unknown; height?: unknown }): void => {
      if (!isDialogSender(event) || ready || !size
        || typeof size.width !== 'number' || typeof size.height !== 'number'
        || !Number.isFinite(size.width) || !Number.isFinite(size.height)
        || size.width <= 0 || size.height <= 0 || size.width > 4096 || size.height > 4096) return;
      ready = true;
      dialogSize = { width: size.width, height: size.height };
      clearTimeout(timeout);
      // If the user switched apps during loading, wait for an explicit return.
      if (!anchorWindow || (!anchorWindow.isDestroyed() && anchorWindow.isFocused())) showDialog(true);
    };
    const onRespond = (event: IpcMainEvent, value: unknown): void => {
      if (!isDialogSender(event) || !ready || typeof value !== 'number'
        || !Number.isInteger(value) || value < 0 || value >= (options.buttons?.length ?? 0)) return;
      response = value;
      window.close();
    };
    ipcMain.on(AppQuitDialogIpc.Ready, onReady);
    ipcMain.on(AppQuitDialogIpc.Respond, onRespond);
    window.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'Escape' || ((input.meta || input.control) && input.key.toLowerCase() === 'w')) {
        event.preventDefault();
        window.close();
      }
    });
    window.webContents.once('render-process-gone', () => fail(new Error('Quit confirmation renderer exited')));
    window.on('close', () => { restoreFocusOnCancel = window.isFocused(); });
    window.once('closed', () => {
      clearTimeout(timeout);
      if (revealActiveDialog === revealDialog) revealActiveDialog = null;
      anchorWindow?.removeListener('move', positionDialog);
      anchorWindow?.removeListener('resize', positionDialog);
      anchorWindow?.removeListener('focus', onOwnerFocus);
      anchorWindow?.removeListener('show', onOwnerShow);
      anchorWindow?.removeListener('restore', onOwnerShow);
      anchorWindow?.removeListener('hide', onOwnerHide);
      anchorWindow?.removeListener('minimize', onOwnerHide);
      anchorWindow?.removeListener('closed', onOwnerClosed);
      app.removeListener('activate', onOwnerFocus);
      ipcMain.removeListener(AppQuitDialogIpc.Ready, onReady);
      ipcMain.removeListener(AppQuitDialogIpc.Respond, onRespond);
      removeInputGuards?.();
      const returnFocus = anchorWindow ?? focusedWindow;
      if (restoreFocusOnCancel && response === options.cancelId && returnFocus
        && !returnFocus.isDestroyed() && returnFocus.isVisible() && !returnFocus.isMinimized()) returnFocus.focus();
      if (failure) reject(failure);
      else resolve({ response, checkboxChecked: false });
    });
    void window.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(buildDialogHtml(options, icon.toDataURL()))}`)
      .catch(fail);
  });
}
