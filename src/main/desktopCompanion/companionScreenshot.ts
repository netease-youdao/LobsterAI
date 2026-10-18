import { randomUUID } from 'crypto';
import { app, type BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, type NativeImage, nativeImage, type Rectangle, screen, systemPreferences } from 'electron';
import fs from 'fs/promises';
import path from 'path';

import { type DesktopCompanionAttachment, DesktopCompanionSurface } from '../../shared/desktopCompanion/constants';
import { CompanionScreenshotAction as Action, companionScreenshotCrop, CompanionScreenshotIpc } from '../../shared/desktopCompanion/screenshot';
import { SystemPermissionStatus } from '../../shared/permissions/constants';
import { t } from '../i18n';
import { type CompanionWindowEnvironment, createCompanionWindow } from './companionWindow';

interface CaptureFrame {
  window: BrowserWindow;
  bounds: Rectangle;
  image: NativeImage;
  preview?: string;
}

interface ScreenshotSelection { image: NativeImage; action: Action }
export type CompanionCaptureResult = (DesktopCompanionAttachment & { action: Action }) | { action: typeof Action.Copy | typeof Action.Save };

/** Inspect the PNG header before decoding renderer bytes, then match the approved crop exactly. */
export function decodeAnnotatedScreenshot(value: unknown, width: number, height: number): NativeImage {
  const prefix = 'data:image/png;base64,';
  if (typeof value !== 'string' || !value.startsWith(prefix) || value.length > 80 * 1024 * 1024) {
    throw new Error('Invalid screenshot image data');
  }
  const bytes = Buffer.from(value.slice(prefix.length), 'base64');
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height
    || width * height > 64_000_000) throw new Error('Invalid screenshot image dimensions');
  const image = nativeImage.createFromBuffer(bytes);
  const size = image.getSize();
  if (image.isEmpty() || size.width !== width || size.height !== height) throw new Error('Invalid screenshot image');
  return image;
}

/** A one-shot capture. Only the crop is saved; full-screen frames live in memory until selection ends. */
export class CompanionScreenshotController {
  private frames = new Map<number, CaptureFrame>();
  private pending: { resolve(selection: ScreenshotSelection | null): void; reject(error: Error): void } | null = null;
  private active = false;
  private disposed = false;
  private cancelActive: (() => void) | null = null;
  private loadTimer: ReturnType<typeof setTimeout> | undefined;
  private timing: { started: number; captured: number; prepared: number } | null = null;

  constructor(private readonly env: CompanionWindowEnvironment) {
    const handle = (channel: string, callback: (frame: CaptureFrame, value: unknown) => unknown) => {
      ipcMain.handle(channel, (event, value: unknown) => {
        const frame = this.frames.get(event.sender.id);
        if (!frame || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid screenshot IPC sender');
        return callback(frame, value);
      });
    };
    // Annotation exports need lossless source pixels. Encode once and keep them in memory only.
    handle(CompanionScreenshotIpc.GetFrame, frame => frame.preview
      ??= `data:image/png;base64,${frame.image.toPNG().toString('base64')}`);
    handle(CompanionScreenshotIpc.Ready, frame => {
      frame.window.showInactive();
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      if (display.bounds.x === frame.bounds.x && display.bounds.y === frame.bounds.y) frame.window.focus();
      if ([...this.frames.values()].every(item => item.window.isVisible())) {
        clearTimeout(this.loadTimer);
        if (this.timing) {
          const { started, captured, prepared } = this.timing;
          console.debug('[DesktopCompanion] Screenshot overlay ready', {
            captureMs: Math.round(captured - started),
            prepareMs: Math.round(prepared - captured),
            overlayMs: Math.round(performance.now() - prepared),
            totalMs: Math.round(performance.now() - started),
          });
          this.timing = null;
        }
      }
    });
    handle(CompanionScreenshotIpc.Finish, (frame, value) => {
      if (value === null) { this.finish(null); return; }
      if (!value || typeof value !== 'object') throw new Error('Invalid screenshot selection');
      const result = 'rect' in value ? value as { rect: unknown; action?: unknown; imageDataUrl?: unknown } : null;
      const action = result ? result.action : Action.Ask;
      if (!Object.values(Action).includes(action as Action)) throw new Error('Invalid screenshot action');
      const crop = companionScreenshotCrop(result ? result.rect : value, frame.bounds, frame.image.getSize());
      if (!crop) throw new Error('Invalid screenshot selection');
      const image = result?.imageDataUrl === undefined ? frame.image.crop(crop)
        : decodeAnnotatedScreenshot(result.imageDataUrl, crop.width, crop.height);
      this.finish({ image, action: action as Action });
    });
  }

  async capture(companions: Array<BrowserWindow | null>): Promise<CompanionCaptureResult | null> {
    if (this.active || this.disposed) return null;
    this.active = true;
    const started = performance.now();
    const visible = companions.filter((win): win is BrowserWindow => !!win && !win.isDestroyed() && win.isVisible());
    let canceled = false;
    const cancel = () => { canceled = true; this.finish(null); };
    this.cancelActive = cancel;
    screen.on('display-removed', cancel);
    screen.on('display-metrics-changed', cancel);
    try {
      for (const win of visible) win.hide();
      // Let the native menu and companion windows leave the compositor before taking the shot.
      await new Promise(resolve => setTimeout(resolve, 200));
      if (this.disposed || canceled) return null;
      const displays = screen.getAllDisplays();
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.ceil(Math.max(...displays.map(display => display.size.width * display.scaleFactor))),
          height: Math.ceil(Math.max(...displays.map(display => display.size.height * display.scaleFactor))),
        },
      });
      const captured = performance.now();
      if (this.disposed || canceled) return null;
      if (!sources.length || !displays.length) throw new Error('No screens available for capture');
      if (process.platform === 'darwin') {
        const permission = systemPreferences.getMediaAccessStatus('screen');
        if (permission === SystemPermissionStatus.Denied || permission === SystemPermissionStatus.Restricted) {
          throw new Error('Screen recording permission denied');
        }
      }
      const captures = displays.map(display => {
        const source = sources.find(item => item.display_id === String(display.id))
          ?? (displays.length === 1 && sources.length === 1 && !sources[0].display_id ? sources[0] : undefined);
        if (!source || source.thumbnail.isEmpty()) throw new Error('No screenshot available for display');
        // Normalize to one scale without a full-screen PNG encode/decode on the main thread.
        const image = nativeImage.createFromBitmap(source.thumbnail.toBitmap(), source.thumbnail.getSize(1));
        return { bounds: display.bounds, image };
      });
      this.timing = { started, captured, prepared: performance.now() };
      const selection = await new Promise<ScreenshotSelection | null>((resolve, reject) => {
        this.pending = { resolve, reject };
        this.loadTimer = setTimeout(() => this.fail(new Error('Screenshot overlay timed out')), 15_000);
        for (const capture of captures) {
          const win = createCompanionWindow(this.env, {
            surface: DesktopCompanionSurface.Screenshot, bounds: capture.bounds, focusable: true,
          });
          this.frames.set(win.webContents.id, { ...capture, window: win });
          win.on('closed', () => { if (this.frames.has(win.webContents.id)) cancel(); });
          win.webContents.on('before-input-event', (event, input) => {
            if (input.key === 'Escape') { event.preventDefault(); cancel(); }
          });
          win.webContents.on('did-fail-load', () => this.fail(new Error('Screenshot overlay failed to load')));
          win.webContents.on('render-process-gone', () => this.fail(new Error('Screenshot overlay renderer exited')));
        }
      });
      this.closeFrames();
      if (!selection || this.disposed || canceled) return null;
      const { image, action } = selection;
      if (action === Action.Copy) {
        clipboard.writeImage(image);
        return { action };
      }
      if (action === Action.Save) {
        const result = await dialog.showSaveDialog({
          defaultPath: path.join(app.getPath('pictures'), `screenshot-${Date.now()}.png`),
          filters: [{ name: 'PNG', extensions: ['png'] }],
        });
        if (result.canceled || !result.filePath || this.disposed || canceled) return null;
        await fs.writeFile(result.filePath, image.toPNG(), { mode: 0o600 });
        return { action };
      }
      const directory = path.join(app.getPath('temp'), 'lobsterai', 'attachments');
      await fs.mkdir(directory, { recursive: true });
      if (this.disposed || canceled) return null;
      const filePath = path.join(directory, `screenshot-${randomUUID()}.png`);
      await fs.writeFile(filePath, image.toPNG(), { mode: 0o600 });
      if (this.disposed || canceled) {
        await fs.rm(filePath, { force: true });
        return null;
      }
      return { action, path: filePath, name: `${t('desktopCompanionScreenshotName')}.png`, isImage: true };
    } finally {
      this.cancelActive = null;
      this.pending = null;
      this.timing = null;
      clearTimeout(this.loadTimer);
      this.closeFrames();
      screen.removeListener('display-removed', cancel);
      screen.removeListener('display-metrics-changed', cancel);
      if (!this.disposed) {
        for (const win of visible) if (!win.isDestroyed()) win.showInactive();
      }
      this.active = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    for (const channel of Object.values(CompanionScreenshotIpc)) ipcMain.removeHandler(channel);
  }

  cancel(): void { this.cancelActive?.(); this.closeFrames(); }

  private finish(selection: ScreenshotSelection | null): void {
    this.pending?.resolve(selection);
    this.pending = null;
  }

  private fail(error: Error): void {
    this.pending?.reject(error);
    this.pending = null;
  }

  private closeFrames(): void {
    const frames = [...this.frames.values()];
    this.frames.clear();
    for (const frame of frames) if (!frame.window.isDestroyed()) frame.window.destroy();
  }
}
