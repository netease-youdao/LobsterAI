import { open } from 'node:fs/promises';
import path from 'node:path';

import { type BrowserWindow, ipcMain, type IpcMainEvent, MessageChannelMain, type WebContents, WebContentsView } from 'electron';

import {
  WordPanelAction, type WordPanelBounds, type WordPanelEvent, WordPanelIpc, type WordPanelPresentation, WordPanelSessionAction,
} from '../../../shared/office/word/constants';

const RESPONSE_TIMEOUT_MS = 30_000;
const MAX_PREVIEW_BYTES = 100 * 1024 * 1024;
type Caller = Pick<IpcMainEvent, 'sender' | 'senderFrame'>;
type HostOptions = { getWindow: () => BrowserWindow | null; preload: string; pageUrl: string };

const owns = (event: Caller, contents?: WebContents | null) => !!contents && !contents.isDestroyed()
  && event.sender === contents && event.senderFrame === contents.mainFrame;

/** One trusted renderer owns all visible and parked Word sessions for this app window. */
export class WordPanelHost {
  private view?: WebContentsView;
  private loading?: Promise<void>;
  private markReady?: () => void;
  private active?: WordPanelPresentation;
  private mountedToken?: string;
  private sent?: WordPanelPresentation;
  private focusOnShow = false;
  private bounds: WordPanelBounds | null = null;

  constructor(private readonly options: HostOptions) {}

  get contents(): WebContents | null { return this.view?.webContents ?? null; }

  isDocument(url: string, id?: number): boolean {
    return this.contents?.id === id && !!this.view && url === this.options.pageUrl;
  }

  prepare(): Promise<void> {
    if (this.loading) return this.loading;
    const window = this.options.getWindow();
    if (!window || window.isDestroyed()) return Promise.reject(new Error('Word panel window is unavailable'));
    const view = new WebContentsView({ webPreferences: {
      preload: this.options.preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
      // Parked documents still need to checkpoint edits and answer agent requests.
      backgroundThrottling: false,
    } });
    this.view = view;
    const contents = view.webContents;
    view.setVisible(false);
    window.contentView.addChildView(view);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-frame-navigate', event => event.preventDefault());
    let timeout: ReturnType<typeof setTimeout>;
    let rejectReady: (error: Error) => void;
    const hideOnReload = () => { if (this.active) this.hide(this.active.token); };
    const dispose = () => {
      if (this.view !== view) return;
      clearTimeout(timeout);
      const token = this.active?.token;
      this.active = undefined;
      this.sent = undefined;
      this.view = undefined;
      this.mountedToken = undefined;
      this.bounds = null;
      this.markReady = undefined;
      this.loading = undefined;
      window.removeListener('closed', dispose);
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.removeListener('did-navigate', hideOnReload);
        window.contentView.removeChildView(view);
        if (token) window.webContents.send(WordPanelIpc.Action, { token, action: WordPanelAction.Failed });
      }
      if (!contents.isDestroyed()) contents.close();
      rejectReady(new Error('Word panel renderer stopped'));
    };
    const waitForGuest = () => {
      this.loading = new Promise<void>((resolve, reject) => {
        this.markReady = () => { clearTimeout(timeout); resolve(); };
        rejectReady = reject;
        timeout = setTimeout(dispose, RESPONSE_TIMEOUT_MS);
      });
      // A reload may have no pending callers. Each caller still receives the original rejection.
      void this.loading.catch(() => {});
      return this.loading;
    };
    const ready = waitForGuest();
    window.once('closed', dispose);
    window.webContents.on('did-navigate', hideOnReload);
    contents.once('render-process-gone', dispose);
    contents.once('destroyed', dispose);
    contents.on('did-start-navigation', details => {
      if (!details.isMainFrame || details.isSameDocument || this.markReady) return;
      view.setVisible(false);
      this.mountedToken = undefined;
      waitForGuest();
    });
    void contents.loadURL(this.options.pageUrl).catch(dispose);
    return ready;
  }

  private publish(): void {
    if (!this.active || this.sent === this.active || !this.contents) return;
    this.sent = this.active;
    this.contents.send(WordPanelIpc.Present, this.active);
  }

  async present(panel: WordPanelPresentation): Promise<void> {
    if (typeof panel?.token !== 'string' || !path.isAbsolute(panel.filePath) || path.extname(panel.filePath).toLowerCase() !== '.docx') {
      throw new Error('Invalid Word panel document');
    }
    if (this.active?.token !== panel.token) {
      this.view?.setVisible(false);
      this.mountedToken = undefined;
      this.bounds = null;
      this.focusOnShow = panel.autoFocus;
    }
    this.active = panel;
    await this.prepare();
    if (this.active === panel) this.publish();
  }

  hide(token: string): void {
    if (!this.active || this.active.token !== token) return;
    this.active = undefined;
    this.sent = undefined;
    this.bounds = null;
    this.mountedToken = undefined;
    this.view?.setVisible(false);
    this.contents?.send(WordPanelIpc.Present, null);
  }

  private position(): void {
    const view = this.view;
    if (!view) return;
    const token = this.active?.token;
    if (!this.bounds || !token || this.mountedToken !== token) {
      if (view.getVisible() && token && !this.bounds) {
        // Keep the document behind the host's drawer or menu while the DOM owns the mouse.
        void view.webContents.capturePage(undefined, { stayHidden: true }).then(image => {
          if (this.active?.token !== token || this.bounds || image.isEmpty()) return;
          this.options.getWindow()?.webContents.send(WordPanelIpc.Action, { token, action: WordPanelAction.Snapshot,
            text: `data:image/jpeg;base64,${image.toJPEG(80).toString('base64')}` });
        }).catch(() => {});
        if (view.webContents.isFocused()) this.options.getWindow()?.webContents.focus();
      }
      view.setVisible(false);
      return;
    }
    const window = this.options.getWindow();
    if (!window || window.isDestroyed()) return;
    const zoom = window.webContents.getZoomFactor();
    if (view.webContents.getZoomFactor() !== zoom) view.webContents.setZoomFactor(zoom);
    const { x, y, width, height } = this.bounds;
    view.setBounds({ x: Math.round(x * zoom), y: Math.round(y * zoom), width: Math.round(width * zoom), height: Math.round(height * zoom) });
    view.setVisible(true);
    if (this.focusOnShow) {
      this.focusOnShow = false;
      view.webContents.focus();
    }
  }

  private async session(action: WordPanelSessionAction, filePath: string): Promise<boolean> {
    if (!this.loading) return false;
    if (!Object.values(WordPanelSessionAction).includes(action)) throw new Error('Unknown Word session action');
    await this.loading;
    const contents = this.contents;
    if (!contents) throw new Error('Word panel renderer stopped');
    const { port1, port2 } = new MessageChannelMain();
    return new Promise((resolve, reject) => {
      const finish = (result?: unknown) => {
        clearTimeout(timer);
        contents.removeListener('destroyed', finish);
        port1.removeAllListeners();
        port1.close();
        if (typeof result === 'boolean') resolve(result);
        else reject(new Error('Word editor could not complete the file operation'));
      };
      const timer = setTimeout(finish, RESPONSE_TIMEOUT_MS);
      contents.once('destroyed', finish);
      port1.once('message', event => finish(event.data));
      port1.once('close', finish);
      port1.start();
      contents.postMessage(WordPanelIpc.Session, { action, filePath }, [port2]);
    });
  }

  register(): void {
    const fromApp = (event: Caller) => owns(event, this.options.getWindow()?.webContents);
    const fromWord = (event: Caller) => owns(event, this.contents);
    ipcMain.handle(WordPanelIpc.Prepare, event => fromApp(event) && this.prepare());
    ipcMain.handle(WordPanelIpc.Present, (event, panel: WordPanelPresentation) => fromApp(event) && this.present(panel));
    ipcMain.on(WordPanelIpc.Hide, (event, token: string) => { if (fromApp(event)) this.hide(token); });
    ipcMain.on(WordPanelIpc.Bounds, (event, token: string, bounds: WordPanelBounds | null) => {
      if (!fromApp(event) || this.active?.token !== token) return;
      this.bounds = bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
        && bounds.width > 0 && bounds.height > 0 ? bounds : null;
      this.position();
    });
    ipcMain.handle(WordPanelIpc.Session, (event, action: WordPanelSessionAction, filePath: string) =>
      fromApp(event) && this.session(action, filePath));
    ipcMain.on(WordPanelIpc.Ready, event => {
      if (!fromWord(event)) return;
      this.markReady?.();
      this.markReady = undefined;
      this.sent = undefined;
      this.publish();
    });
    ipcMain.on(WordPanelIpc.Presented, (event, token: string) => {
      if (!fromWord(event) || this.active?.token !== token) return;
      this.mountedToken = token;
      this.position();
    });
    ipcMain.on(WordPanelIpc.Action, (event, message: WordPanelEvent) => {
      const panel = this.active;
      if (!fromWord(event) || !panel || message?.token !== panel.token) return;
      if (panel.actions.includes(message.action) || message.action === WordPanelAction.OpenExternal
        || message.action === WordPanelAction.Toast || message.action === WordPanelAction.Shortcut) {
        this.options.getWindow()?.webContents.send(WordPanelIpc.Action, message);
      }
    });
    ipcMain.handle(WordPanelIpc.ReadPreview, async (event, filePath: string) => {
      if (!fromWord(event) || !this.active || this.active.filePath !== filePath) return { success: false };
      const file = await open(filePath, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_PREVIEW_BYTES) return { success: false };
        const data = await file.readFile();
        return { success: true, dataUrl: `data:application/octet-stream;base64,${data.toString('base64')}` };
      } finally { await file.close(); }
    });
  }
}

export function registerWordPanelHandlers(options: HostOptions): WordPanelHost {
  const host = new WordPanelHost(options);
  host.register();
  return host;
}
