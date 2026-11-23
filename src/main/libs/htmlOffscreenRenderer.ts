import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { BrowserWindow } from 'electron';

import {
  HTML_RENDER_LIMITS,
  HtmlRenderFormat,
} from '../../shared/dshEngine/hostConstants';

export interface HtmlRenderJob {
  htmlPath: string;
  outputPath: string;
  width: number;
  height: number;
  fullPage: boolean;
  format: HtmlRenderFormat;
  quality: number;
  waitMs: number;
}

export interface HtmlRenderItemResult {
  htmlPath: string;
  outputPath: string;
  width: number;
  height: number;
  bytes: number;
  format: HtmlRenderFormat;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('HTML offscreen rendering was aborted.');
  }
}

async function waitForPageReady(win: BrowserWindow, waitMs: number): Promise<{ width: number; height: number }> {
  const measured = await win.webContents.executeJavaScript(
    `(async () => {
      try {
        if (document.fonts && document.fonts.ready) {
          await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 2000))]);
        }
      } catch {}
      const imgs = Array.from(document.images || []);
      await Promise.all(imgs.map(img => img.complete ? Promise.resolve() : new Promise(resolve => {
        const done = () => resolve(undefined);
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
        setTimeout(done, 2000);
      })));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const docEl = document.documentElement;
      const body = document.body;
      const width = Math.max(docEl ? docEl.scrollWidth : 0, body ? body.scrollWidth : 0, window.innerWidth || 0);
      const height = Math.max(docEl ? docEl.scrollHeight : 0, body ? body.scrollHeight : 0, window.innerHeight || 0);
      return { width, height };
    })()`,
    true,
  ) as { width?: number; height?: number } | null;

  if (waitMs > 0) {
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
  return {
    width: typeof measured?.width === 'number' && measured.width > 0 ? Math.ceil(measured.width) : 0,
    height: typeof measured?.height === 'number' && measured.height > 0 ? Math.ceil(measured.height) : 0,
  };
}

/**
 * Render one or more local HTML files to pixel-exact PNG/JPEG images using
 * Electron's built-in Chromium via a hidden BrowserWindow + CDP device metrics
 * override (`deviceScaleFactor: 1`). Never disturbs visible app windows or the
 * interactive in-app browser.
 */
export async function renderHtmlFilesOffscreen(
  jobs: readonly HtmlRenderJob[],
  signal?: AbortSignal,
): Promise<HtmlRenderItemResult[]> {
  if (jobs.length === 0) return [];
  throwIfAborted(signal);

  const initialWidth = jobs[0].width;
  const initialHeight = jobs[0].height;
  const win = new BrowserWindow({
    show: false,
    width: initialWidth,
    height: initialHeight,
    useContentSize: true,
    enableLargerThanScreen: true,
    frame: false,
    backgroundColor: '#ffffff',
    paintWhenInitiallyHidden: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      offscreen: true,
    },
  });

  const abortListener = () => {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  };
  signal?.addEventListener('abort', abortListener, { once: true });

  const results: HtmlRenderItemResult[] = [];
  let debuggerAttached = false;

  try {
    for (const job of jobs) {
      throwIfAborted(signal);
      // Load the local document BEFORE attaching CDP & setting device metrics;
      // calling Emulation.setDeviceMetricsOverride before the initial
      // RenderWidgetHostView exists triggers a native Chromium crash on Windows.
      const fileUrl = pathToFileURL(job.htmlPath).toString();
      await win.loadURL(fileUrl);
      throwIfAborted(signal);

      if (!debuggerAttached) {
        win.webContents.debugger.attach('1.3');
        debuggerAttached = true;
      }

      await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: job.width,
        height: job.height,
        deviceScaleFactor: 1,
        mobile: false,
      });

      const measured = await waitForPageReady(win, job.waitMs);
      throwIfAborted(signal);

      const captureHeight = job.fullPage
        ? Math.min(
          Math.max(job.height, measured.height || job.height),
          HTML_RENDER_LIMITS.MaxDimension * 3,
        )
        : job.height;

      if (job.fullPage && captureHeight !== job.height) {
        await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: job.width,
          height: captureHeight,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await new Promise(resolve => setTimeout(resolve, 40));
      }

      const captureParams: Record<string, unknown> = {
        format: job.format,
        fromSurface: true,
        captureBeyondViewport: job.fullPage,
        clip: {
          x: 0,
          y: 0,
          width: job.width,
          height: captureHeight,
          scale: 1,
        },
      };
      if (job.format === HtmlRenderFormat.Jpeg) {
        captureParams.quality = job.quality;
      }

      const captured = await win.webContents.debugger.sendCommand(
        'Page.captureScreenshot',
        captureParams,
      ) as { data?: string };

      if (!captured?.data || typeof captured.data !== 'string') {
        throw new Error(`Offscreen capture returned empty image data for ${job.htmlPath}`);
      }

      const buffer = Buffer.from(captured.data, 'base64');
      await fs.mkdir(path.dirname(job.outputPath), { recursive: true });
      await fs.writeFile(job.outputPath, buffer);

      results.push({
        htmlPath: job.htmlPath,
        outputPath: job.outputPath,
        width: job.width,
        height: captureHeight,
        bytes: buffer.byteLength,
        format: job.format,
      });
    }

    return results;
  } finally {
    signal?.removeEventListener('abort', abortListener);
    if (debuggerAttached && !win.isDestroyed()) {
      try {
        win.webContents.debugger.detach();
      } catch {
        // Ignore already-detached debugger during teardown.
      }
    }
    if (!win.isDestroyed()) {
      win.destroy();
    }
  }
}
