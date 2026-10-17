import { BrowserWindow, clipboard, desktopCapturer, dialog, nativeImage, type Rectangle, screen, systemPreferences } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DesktopCompanionSurface } from '../../shared/desktopCompanion/constants';
import { CompanionScreenshotAction as Action, CompanionScreenshotIpc } from '../../shared/desktopCompanion/screenshot';
import { CompanionScreenshotController, decodeAnnotatedScreenshot } from './companionScreenshot';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: any, value?: unknown) => any>(),
  windows: [] as any[],
  image: { isEmpty: () => false, toPNG: vi.fn(() => Buffer.from('screen')),
    toBitmap: vi.fn(() => Buffer.from('pixels')), toJPEG: vi.fn(() => Buffer.from('preview')),
    getSize: () => ({ width: 2880, height: 1800 }), crop: vi.fn(() => ({ toPNG: () => Buffer.from('crop') })) },
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('events');
  class Window extends EventEmitter {
    visible = false;
    destroyed = false;
    bounds: Rectangle;
    webContents = Object.assign(new EventEmitter(), {
      id: mocks.windows.length + 1, mainFrame: {}, setWindowOpenHandler: vi.fn(),
    });
    constructor(options: Partial<Rectangle> = {}) {
      super();
      const { x = 0, y = 0, width = 800, height = 600 } = options;
      // Windows constrains the initial window to the work area (48px taskbar).
      this.bounds = { x, y, width, height: process.platform === 'win32' ? Math.min(height, 852) : height };
      mocks.windows.push(this);
    }
    getBounds() { return this.bounds; }
    setBounds(bounds: Rectangle) { this.bounds = { ...bounds }; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    setMenu() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    loadFile = vi.fn(() => Promise.resolve());
    loadURL = vi.fn(() => Promise.resolve());
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
  }
  const display = { id: 2, bounds: { x: -1440, y: 0, width: 1440, height: 900 }, size: { width: 1440, height: 900 }, scaleFactor: 2 };
  return {
    app: { getPath: () => '/tmp' },
    BrowserWindow: Window,
    ipcMain: { handle: (channel: string, handler: any) => mocks.handlers.set(channel, handler), removeHandler: (channel: string) => mocks.handlers.delete(channel) },
    screen: Object.assign(new EventEmitter(), { getAllDisplays: () => [display], getCursorScreenPoint: () => ({ x: -600, y: 100 }), getDisplayNearestPoint: () => display }),
    nativeImage: { createFromBitmap: vi.fn(() => mocks.image), createFromBuffer: vi.fn() },
    clipboard: { writeImage: vi.fn() },
    dialog: { showSaveDialog: vi.fn() },
    desktopCapturer: { getSources: vi.fn() },
    systemPreferences: { getMediaAccessStatus: vi.fn(() => 'granted') },
  };
});
vi.mock('fs/promises', () => ({ default: { mkdir: vi.fn(), writeFile: vi.fn(), rm: vi.fn() } }));
vi.mock('../i18n', () => ({ t: (key: string) => key }));

let controller: CompanionScreenshotController;
let orb: BrowserWindow;
function invoke(channel: string, value?: unknown, sender = mocks.windows.at(-1).webContents) {
  return mocks.handlers.get(channel)!({ sender, senderFrame: sender.mainFrame }, value);
}
async function start() {
  const result = controller.capture([orb]);
  await vi.advanceTimersByTimeAsync(200);
  return { result, overlay: mocks.windows.at(-1) };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue('granted');
  mocks.windows.length = 0;
  mocks.handlers.clear();
  vi.mocked(desktopCapturer.getSources).mockResolvedValue([{ display_id: '2', thumbnail: mocks.image } as any]);
  controller = new CompanionScreenshotController({ preloadPath: '/preload.js', rendererDirectory: '/dist', title: 'Companion' });
  orb = new BrowserWindow();
  orb.showInactive();
});
afterEach(() => {
  controller.dispose();
  screen.removeAllListeners();
  vi.useRealTimers();
});

describe('desktop screenshot capture', () => {
  test('Windows overlays cover the full display instead of squeezing the captured taskbar into the work area', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      const { result, overlay } = await start();
      const displayBounds = screen.getAllDisplays()[0].bounds;
      // Include a negative monitor origin and a 2x image scale. The viewport must
      // match the display before Ready so preview pixels and crop coordinates agree.
      expect(overlay.getBounds()).toEqual(displayBounds);
      expect(overlay.isVisible()).toBe(false);
      invoke(CompanionScreenshotIpc.Ready);
      expect(overlay.getBounds()).toEqual(displayBounds);
      invoke(CompanionScreenshotIpc.Finish, { x: 0, y: 852, width: 1440, height: 48 });
      await result;
      expect(mocks.image.crop).toHaveBeenCalledWith({ x: 0, y: 1704, width: 2880, height: 96 });
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  test('hides companion windows, waits for the image to render, saves only a retina crop and restores the orb', async () => {
    const { result, overlay } = await start();
    expect(orb.isVisible()).toBe(false);
    expect(overlay.visible).toBe(false);
    expect(invoke(CompanionScreenshotIpc.GetFrame)).toBe(`data:image/png;base64,${Buffer.from('screen').toString('base64')}`);
    invoke(CompanionScreenshotIpc.Ready);
    expect(overlay.visible).toBe(true);
    invoke(CompanionScreenshotIpc.Finish, { x: 100, y: 50, width: 200, height: 100 });
    expect(await result).toMatchObject({ path: expect.stringMatching(/screenshot-.*\.png$/), isImage: true });
    expect(mocks.image.crop).toHaveBeenCalledWith({ x: 200, y: 100, width: 400, height: 200 });
    expect(fs.writeFile).toHaveBeenCalledWith(expect.any(String), Buffer.from('crop'), { mode: 0o600 });
    expect(overlay.destroyed).toBe(true);
    expect(orb.isVisible()).toBe(true);
  });

  test('encodes the lossless annotation source lazily and caches it only for this capture', async () => {
    const { result, overlay } = await start();
    expect(overlay.loadFile).toHaveBeenCalledWith(path.join('/dist', 'companion-screenshot.html'), { query: { surface: DesktopCompanionSurface.Screenshot } });
    expect(nativeImage.createFromBitmap).toHaveBeenCalledWith(Buffer.from('pixels'), { width: 2880, height: 1800 });
    expect(mocks.image.toPNG).not.toHaveBeenCalled();
    const firstPreview = invoke(CompanionScreenshotIpc.GetFrame);
    expect(invoke(CompanionScreenshotIpc.GetFrame)).toBe(firstPreview);
    expect(mocks.image.toJPEG).not.toHaveBeenCalled();
    expect(mocks.image.toPNG).toHaveBeenCalledTimes(1);
    invoke(CompanionScreenshotIpc.Finish, null);
    await result;

    mocks.image.toPNG.mockReturnValueOnce(Buffer.from('new screen'));
    const next = await start();
    expect(invoke(CompanionScreenshotIpc.GetFrame)).not.toBe(firstPreview);
    expect(mocks.image.toPNG).toHaveBeenCalledTimes(2);
    invoke(CompanionScreenshotIpc.Finish, null);
    await next.result;
  });

  test('development uses the dedicated screenshot page too', async () => {
    controller.dispose();
    controller = new CompanionScreenshotController({
      preloadPath: '/preload.js', rendererDirectory: '/dist', title: 'Companion', devServerUrl: 'http://localhost:5175',
    });
    const { result, overlay } = await start();
    expect(overlay.loadURL).toHaveBeenCalledWith(`http://localhost:5175/companion-screenshot.html?surface=${DesktopCompanionSurface.Screenshot}`);
    invoke(CompanionScreenshotIpc.Finish, null);
    await result;
  });

  test.each(['escape', 'cancel', 'display-change', 'close'])('%s cancels without saving a file', async reason => {
    const { result, overlay } = await start();
    if (reason === 'escape') overlay.webContents.emit('before-input-event', { preventDefault: vi.fn() }, { key: 'Escape' });
    if (reason === 'cancel') invoke(CompanionScreenshotIpc.Finish, null);
    if (reason === 'display-change') screen.emit('display-metrics-changed');
    if (reason === 'close') overlay.destroy();
    expect(await result).toBeNull();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(orb.isVisible()).toBe(true);
  });

  test('other windows and child frames cannot read or finish a capture', async () => {
    const { result, overlay } = await start();
    expect(() => invoke(CompanionScreenshotIpc.GetFrame, undefined, orb.webContents)).toThrow('Invalid screenshot IPC sender');
    expect(() => mocks.handlers.get(CompanionScreenshotIpc.Finish)!({ sender: overlay.webContents, senderFrame: {} }, null))
      .toThrow('Invalid screenshot IPC sender');
    expect(() => invoke(CompanionScreenshotIpc.Finish, { x: Infinity })).toThrow('Invalid screenshot selection');
    invoke(CompanionScreenshotIpc.Finish, null);
    await result;
  });

  test('permission or capture errors restore all hidden windows', async () => {
    vi.mocked(desktopCapturer.getSources).mockRejectedValue(new Error('Permission denied'));
    const result = controller.capture([orb]);
    const failure = expect(result).rejects.toThrow('Permission denied');
    await vi.advanceTimersByTimeAsync(200);
    await failure;
    expect(orb.isVisible()).toBe(true);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  test.skipIf(process.platform !== 'darwin')('denied macOS access cannot produce a misleading partial screenshot', async () => {
    vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue('denied');
    const result = controller.capture([orb]);
    const failure = expect(result).rejects.toThrow('Screen recording permission denied');
    await vi.advanceTimersByTimeAsync(200);
    await failure;
    expect(mocks.windows).toHaveLength(1);
    expect(orb.isVisible()).toBe(true);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  test('a renderer that never loads times out and restores the orb', async () => {
    const { result, overlay } = await start();
    const failure = expect(result).rejects.toThrow('Screenshot overlay timed out');
    await vi.advanceTimersByTimeAsync(15_000);
    await failure;
    expect(overlay.destroyed).toBe(true);
    expect(orb.isVisible()).toBe(true);
  });

  test('disposing during selection cancels and never reopens companion windows', async () => {
    const { result, overlay } = await start();
    controller.dispose();
    expect(await result).toBeNull();
    expect(overlay.destroyed).toBe(true);
    expect(orb.isVisible()).toBe(false);
    expect(mocks.handlers.size).toBe(0);
  });

  test.each([Action.ExtractText, Action.Translate])('preserves the explicit %s action with its PNG attachment', async action => {
    const { result } = await start();
    invoke(CompanionScreenshotIpc.Finish, { rect: { x: 100, y: 50, width: 200, height: 100 }, action });
    expect(await result).toMatchObject({ action, isImage: true, path: expect.stringMatching(/\.png$/) });
  });

  test('copy closes the overlay and writes only to the clipboard', async () => {
    const { result, overlay } = await start();
    invoke(CompanionScreenshotIpc.Finish, { rect: { x: 0, y: 0, width: 200, height: 100 }, action: Action.Copy });
    expect(await result).toEqual({ action: Action.Copy });
    expect(clipboard.writeImage).toHaveBeenCalledTimes(1);
    expect(overlay.destroyed).toBe(true);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  test('save writes only the user-selected file, and canceling the picker writes nothing', async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: '/chosen/capture.png' });
    const { result } = await start();
    invoke(CompanionScreenshotIpc.Finish, { rect: { x: 0, y: 0, width: 200, height: 100 }, action: Action.Save });
    expect(await result).toEqual({ action: Action.Save });
    expect(fs.writeFile).toHaveBeenCalledExactlyOnceWith('/chosen/capture.png', Buffer.from('crop'), { mode: 0o600 });
    vi.mocked(fs.writeFile).mockClear();
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: '' });
    const next = await start();
    invoke(CompanionScreenshotIpc.Finish, { rect: { x: 0, y: 0, width: 200, height: 100 }, action: Action.Save });
    expect(await next.result).toBeNull();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  test('rejects forged actions and annotated PNG dimensions before native decoding', async () => {
    const { result } = await start();
    const rect = { x: 0, y: 0, width: 200, height: 100 };
    expect(() => invoke(CompanionScreenshotIpc.Finish, { rect, action: 'execute' })).toThrow('Invalid screenshot action');
    expect(() => invoke(CompanionScreenshotIpc.Finish, { rect, action: Action.Copy, imageDataUrl: 'data:image/png;base64,bm90LXBuZw==' }))
      .toThrow('Invalid screenshot image dimensions');
    expect(nativeImage.createFromBuffer).not.toHaveBeenCalled();
    invoke(CompanionScreenshotIpc.Finish, null);
    await result;
  });

  test('accepts only a decoded PNG that exactly matches the approved crop', () => {
    const header = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
    header.write('IHDR', 12); header.writeUInt32BE(400, 16); header.writeUInt32BE(200, 20);
    const dataUrl = `data:image/png;base64,${header.toString('base64')}`;
    const image = { isEmpty: () => false, getSize: () => ({ width: 400, height: 200 }) } as any;
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue(image);
    expect(decodeAnnotatedScreenshot(dataUrl, 400, 200)).toBe(image);
    expect(() => decodeAnnotatedScreenshot(dataUrl, 401, 200)).toThrow('Invalid screenshot image dimensions');
  });

  test('account cancellation during capture releases overlays and does not create an attachment', async () => {
    const { result, overlay } = await start();
    controller.cancel();
    expect(await result).toBeNull();
    expect(overlay.destroyed).toBe(true);
    expect(fs.writeFile).not.toHaveBeenCalled();
    const next = await start();
    invoke(CompanionScreenshotIpc.Finish, null);
    await next.result;
  });

  test('canceling while the crop is being written removes it and never returns an attachment', async () => {
    let written!: () => void;
    vi.mocked(fs.writeFile).mockImplementationOnce(() => new Promise<void>(resolve => { written = resolve; }));
    const { result } = await start();
    invoke(CompanionScreenshotIpc.Finish, { x: 0, y: 0, width: 200, height: 100 });
    await vi.advanceTimersByTimeAsync(0);
    screen.emit('display-removed');
    written();
    expect(await result).toBeNull();
    expect(fs.rm).toHaveBeenCalledWith(expect.stringMatching(/screenshot-.*\.png$/), { force: true });
  });
});
