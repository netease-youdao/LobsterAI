import { EventEmitter } from 'node:events';

import type { BrowserWindow } from 'electron';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { WordPanelAction, WordPanelIpc, type WordPanelPresentation } from '../../../shared/office/word/constants';
import { registerWordPanelHandlers } from './handlers';

const ipc = vi.hoisted(() => ({ handle: vi.fn(), on: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: ipc,
  WebContentsView: class {
    visible = false;
    webContents = Object.assign(new EventEmitter(), {
      id: 23, mainFrame: {}, send: vi.fn(), loadURL: vi.fn(async () => {}), isDestroyed: () => false,
      setWindowOpenHandler: vi.fn(), getZoomFactor: () => 1, setZoomFactor: vi.fn(), close: vi.fn(), focus: vi.fn(),
    });
    setVisible(value: boolean) { this.visible = value; }
    getVisible() { return this.visible; }
    setBounds = vi.fn();
  },
}));

const pageUrl = 'file:///app/word-panel.html';
function setup() {
  const main = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, getZoomFactor: () => 1, send: vi.fn() });
  const children = { addChildView: vi.fn(), removeChildView: vi.fn() };
  const window = Object.assign(new EventEmitter(), { webContents: main, contentView: children, isDestroyed: () => false });
  const host = registerWordPanelHandlers({ preload: '/app/wordPanelPreload.js', pageUrl, getWindow: () => window as unknown as BrowserWindow });
  const send = (channel: string, sender: { mainFrame: unknown }, ...args: unknown[]) => {
    const entry = [...ipc.on.mock.calls, ...ipc.handle.mock.calls].find(([key]) => key === channel)!;
    return entry[1]({ sender, senderFrame: sender.mainFrame }, ...args);
  };
  const present = (token: string) => ({ token, filePath: `/tmp/${token}.docx`, language: 'zh', theme: '', dark: false,
    actions: [WordPanelAction.Share], fileListOpen: false, autoFocus: false } satisfies WordPanelPresentation);
  return { host, main, children, send, present, window };
}

afterEach(() => { vi.clearAllMocks(); });

describe('Word panel renderer ownership', () => {
  test('an agent and two tab opens share one launch, and late geometry or acknowledgements cannot show a stale tab', async () => {
    const { host, main, children, send, present, window } = setup();
    const agent = host.prepare();
    const first = host.present(present('first'));
    const second = host.present(present('second'));
    const guest = host.contents!;
    const view = children.addChildView.mock.calls[0][0];
    expect(children.addChildView).toHaveBeenCalledTimes(1);
    expect(host.isDocument(pageUrl, guest.id)).toBe(true);
    expect(host.isDocument('file:///app/index.html', guest.id)).toBe(false);
    send(WordPanelIpc.Ready, guest);
    await Promise.all([agent, first, second]);
    expect(guest.send).toHaveBeenCalledTimes(1);
    expect(guest.send).toHaveBeenCalledWith(WordPanelIpc.Present, present('second'));
    const bounds = { x: 300, y: 40, width: 520, height: 700 };
    send(WordPanelIpc.Bounds, main, 'second', bounds);
    send(WordPanelIpc.Presented, guest, 'first');
    send(WordPanelIpc.Presented, main, 'second');
    expect(view.getVisible()).toBe(false);
    send(WordPanelIpc.Presented, guest, 'second');
    send(WordPanelIpc.Hide, main, 'first');
    expect(view.getVisible()).toBe(true);
    expect(view.setBounds).toHaveBeenCalledWith(bounds);
    send(WordPanelIpc.Action, guest, { token: 'first', action: WordPanelAction.Share });
    send(WordPanelIpc.Action, guest, { token: 'second', action: WordPanelAction.Download });
    expect(main.send).not.toHaveBeenCalled();
    send(WordPanelIpc.Hide, main, 'second');
    expect(view.getVisible()).toBe(false);
    expect(host.contents).toBe(guest);
    window.emit('closed');
    expect(host.contents).toBeNull();
  });

  test('a failed launch rejects its waiters and the next agent request starts a fresh renderer', async () => {
    const { host, children, send, window } = setup();
    const first = host.prepare();
    const old = host.contents!;
    old.emit('render-process-gone');
    await expect(first).rejects.toThrow('renderer stopped');
    const second = host.prepare();
    const guest = host.contents!;
    expect(guest).not.toBe(old);
    expect(children.addChildView).toHaveBeenCalledTimes(2);
    send(WordPanelIpc.Ready, old);
    send(WordPanelIpc.Ready, guest);
    await second;
    window.emit('closed');
  });

  test('agent work arriving during a guest reload waits for its new listeners and the active tab is restored', async () => {
    const { host, send, present, window } = setup();
    const panel = present('current');
    const first = host.present(panel);
    const guest = host.contents!;
    send(WordPanelIpc.Ready, guest);
    await first;
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    const called = vi.fn();
    const pending = host.prepare().then(called);
    await Promise.resolve();
    expect(called).not.toHaveBeenCalled();
    send(WordPanelIpc.Ready, guest);
    await pending;
    expect(guest.send).toHaveBeenCalledTimes(2);
    expect(guest.send).toHaveBeenLastCalledWith(WordPanelIpc.Present, panel);
    window.emit('closed');
  });
});
