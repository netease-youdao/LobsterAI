import { randomUUID } from 'crypto';
import { type BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions, screen } from 'electron';

import {
  CompanionContextMenuIpc,
  type CompanionContextMenuItem,
  type CompanionContextMenuState,
  resolveCompanionContextMenuLayout,
} from '../../shared/desktopCompanion/contextMenu';
import { dismissCompanionPanelOnBlur } from './companionWindow';

/** An action, a radio choice (with `checked`), a submenu, or a group break. */
export type CompanionMenuEntry =
  | { type: 'separator' }
  | { label: string; click: () => unknown; checked?: boolean }
  | { label: string; submenu: CompanionMenuEntry[] };

interface ContextMenuHost {
  createWindow(): BrowserWindow;
  /** The window a native menu is attached to. */
  nativeOwner(): BrowserWindow | null;
  /** The companion window holding key focus before the menu took it. */
  focusedWindow(): BrowserWindow | null;
  publish(): void;
}

function nativeTemplate(entries: CompanionMenuEntry[]): MenuItemConstructorOptions[] {
  return entries.map((entry): MenuItemConstructorOptions => {
    if ('type' in entry) return { type: 'separator' };
    if ('submenu' in entry) return { label: entry.label, submenu: nativeTemplate(entry.submenu) };
    return { label: entry.label, click: entry.click, ...(entry.checked === undefined ? {} : { type: 'radio', checked: entry.checked }) };
  });
}

/**
 * The orb's right-click menu. macOS keeps a regular app's native menus off
 * another app's full-screen Space, where the orb, a nonactivating panel, still
 * shows; so on macOS the menu is drawn in a companion panel of its own.
 */
export class CompanionContextMenuController {
  private window: BrowserWindow | null = null;
  private current: CompanionContextMenuState | null = null;
  private actions = new Map<string, () => unknown>();
  private returnFocus: BrowserWindow | null = null;
  private disposing = false;

  constructor(private readonly host: ContextMenuHost) {
    const handle = (channel: string, callback: (value: unknown) => unknown) => {
      ipcMain.handle(channel, (event, value: unknown) => {
        if (event.sender.id !== this.webContentsId || event.senderFrame !== event.sender.mainFrame) {
          throw new Error('Invalid companion context menu IPC sender');
        }
        return callback(value);
      });
    };
    handle(CompanionContextMenuIpc.Run, value => this.run(value));
    handle(CompanionContextMenuIpc.Ready, value => this.reveal(value));
    // Escape or a click beside the cards: give focus back, as a native menu never took it.
    handle(CompanionContextMenuIpc.Dismiss, () => this.hide(true));
  }

  get state(): CompanionContextMenuState | null { return this.current; }
  get isOpen(): boolean { return this.current !== null; }
  get browserWindow(): BrowserWindow | null { return this.window && !this.window.isDestroyed() ? this.window : null; }
  get webContentsId(): number | null { return this.browserWindow?.webContents.id ?? null; }

  show(entries: CompanionMenuEntry[]): void {
    if (process.platform !== 'darwin') {
      Menu.buildFromTemplate(nativeTemplate(entries)).popup({ window: this.host.nativeOwner() ?? undefined });
      return;
    }
    const win = this.ensureWindow();
    const focused = this.host.focusedWindow();
    if (focused !== win) this.returnFocus = focused;
    // Reopening elsewhere must not flash the previous menu at the new position.
    if (win.isVisible()) win.hide();
    this.actions.clear();
    const items = this.model(entries, '');
    const pointer = screen.getCursorScreenPoint();
    const layout = resolveCompanionContextMenuLayout(pointer, items, screen.getDisplayNearestPoint(pointer).workArea);
    win.setBounds(layout.bounds);
    // The renderer paints this opening while the window is hidden, then asks to reveal it.
    this.current = { id: randomUUID(), items, cards: layout.cards };
    this.host.publish();
  }

  hide(restoreFocus = false): void {
    if (!this.current) return;
    this.current = null;
    this.actions.clear();
    this.browserWindow?.hide();
    const target = this.returnFocus;
    this.returnFocus = null;
    if (restoreFocus && target && !target.isDestroyed() && target.isVisible()) target.focus();
    this.host.publish();
  }

  dispose(): void {
    this.disposing = true;
    for (const channel of Object.values(CompanionContextMenuIpc)) ipcMain.removeHandler(channel);
    this.window?.destroy();
    this.window = null;
    this.current = null;
  }

  private model(entries: CompanionMenuEntry[], prefix: string): CompanionContextMenuItem[] {
    const items: CompanionContextMenuItem[] = [];
    let divided = false;
    entries.forEach((entry, index) => {
      if ('type' in entry) { divided = items.length > 0; return; }
      const item: CompanionContextMenuItem = { id: `${prefix}${index}`, label: entry.label, ...(divided ? { divided } : {}) };
      divided = false;
      if ('submenu' in entry) item.submenu = this.model(entry.submenu, `${item.id}.`);
      else {
        this.actions.set(item.id, entry.click);
        if (entry.checked !== undefined) item.checked = entry.checked;
      }
      items.push(item);
    });
    return items;
  }

  private run(id: unknown): void {
    const action = typeof id === 'string' ? this.actions.get(id) : undefined;
    if (!action) return;
    // Close first, so an action that opens or focuses another surface keeps it.
    this.hide(true);
    void action();
  }

  private reveal(id: unknown): boolean {
    const win = this.browserWindow;
    if (!win || !this.current || id !== this.current.id) return false;
    win.show();
    win.focus();
    return true;
  }

  private ensureWindow(): BrowserWindow {
    if (this.browserWindow) return this.browserWindow;
    const win = this.host.createWindow();
    dismissCompanionPanelOnBlur(win, () => this.hide());
    // A key panel receives the app menu's Close (Cmd+W).
    win.on('close', event => { if (!this.disposing) { event.preventDefault(); this.hide(); } });
    win.on('closed', () => {
      if (this.window !== win) return;
      this.window = null;
      this.current = null;
    });
    this.window = win;
    return win;
  }
}
