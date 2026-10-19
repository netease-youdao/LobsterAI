import { randomUUID } from 'crypto';
import { app, type BrowserWindow, desktopCapturer, ipcMain, type NativeImage, nativeImage, type Rectangle, screen, systemPreferences } from 'electron';
import fs from 'fs/promises';
import path from 'path';

import { type DesktopCompanionAttachment, DesktopCompanionSurface } from '../../shared/desktopCompanion/constants';
import { companionScreenshotCrop, CompanionScreenshotIpc } from '../../shared/desktopCompanion/screenshot';
import { SystemPermissionStatus } from '../../shared/permissions/constants';
import { t } from '../i18n';
import { type CompanionWindowEnvironment, createCompanionWindow } from './companionWindow';

interface CaptureFrame {
  window: BrowserWindow;
  bounds: Rectangle;
  image: NativeImage;
  preview?: string;
}

/** A one-shot capture. Only the crop is saved; full-screen frames live in memory until selection ends. */
export class CompanionScreenshotController {
  private frames = new Map<number, CaptureFrame>();
  private pending: { resolve(image: NativeImage | null): void; reject(error: Error): void } | null = null;
  private active = false;
  private disposed = false;
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
    // Only the overlay uses JPEG. Keep the original pixels for the lossless PNG crop,
    // and encode at most once even if the renderer requests the frame again.
    handle(CompanionScreenshotIpc.GetFrame, frame => frame.preview
      ??= `data:image/jpeg;base64,${frame.image.toJPEG(90).toString('base64')}`);
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
      const crop = companionScreenshotCrop(value, frame.bounds, frame.image.getSize());
      if (!crop) throw new Error('Invalid screenshot selection');
      this.finish(frame.image.crop(crop));
    });
  }

  async capture(companions: Array<BrowserWindow | null>): Promise<DesktopCompanionAttachment | null> {
    if (this.active || this.disposed) return null;
    this.active = true;
    const started = performance.now();
    const visible = companions.filter((win): win is BrowserWindow => !!win && !win.isDestroyed() && win.isVisible());
    let canceled = false;
    const cancel = () => { canceled = true; this.finish(null); };
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
      const image = await new Promise<NativeImage | null>((resolve, reject) => {
        this.pending = { resolve, reject };
        this.loadTimer = setTimeout(() => this.fail(new Error('Screenshot overlay timed out')), 15_000);
        for (const capture of captures) {
          const win = createCompanionWindow(this.env, {
            surface: DesktopCompanionSurface.Screenshot, bounds: capture.bounds, focusable: true,
          });
          this.frames.set(win.webContents.id, { ...capture, window: win });
          win.on('closed', cancel);
          win.webContents.on('before-input-event', (event, input) => {
            if (input.key === 'Escape') { event.preventDefault(); cancel(); }
          });
          win.webContents.on('did-fail-load', () => this.fail(new Error('Screenshot overlay failed to load')));
          win.webContents.on('render-process-gone', () => this.fail(new Error('Screenshot overlay renderer exited')));
        }
      });
      this.closeFrames();
      if (!image || this.disposed) return null;
      const directory = path.join(app.getPath('temp'), 'lobsterai', 'attachments');
      await fs.mkdir(directory, { recursive: true });
      const filePath = path.join(directory, `screenshot-${randomUUID()}.png`);
      await fs.writeFile(filePath, image.toPNG(), { mode: 0o600 });
      return { path: filePath, name: `${t('desktopCompanionScreenshotName')}.png`, isImage: true };
    } finally {
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
    this.finish(null);
    this.closeFrames();
    for (const channel of Object.values(CompanionScreenshotIpc)) ipcMain.removeHandler(channel);
  }

  private finish(image: NativeImage | null): void {
    this.pending?.resolve(image);
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
