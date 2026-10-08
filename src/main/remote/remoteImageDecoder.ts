import { randomUUID } from 'crypto';
import { app, BrowserWindow } from 'electron';
import { constants, promises as fs } from 'fs';

import { inspectRemoteImage, RemoteImageBudget } from './remoteImageHeader';

export interface RemoteImageContext { current(): boolean; signal?: AbortSignal }
interface DecodedImage { base64Data: string; mimeType: string; width: number; height: number }

// This function is serialized into a separate sandboxed Chromium renderer. No Node APIs,
// paths, credentials, preload, persistence, or network capability cross the boundary.
async function decodeInRenderer(base64: string, mimeType: string, preview: boolean, maximumBytes: number, maximumPixels: number): Promise<DecodedImage> {
  const bytes = Uint8Array.from(atob(base64), value => value.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width * bitmap.height > maximumPixels) throw new Error('INPUT_UNSUPPORTED');
    const ratio = preview ? Math.min(1, 256 / Math.max(bitmap.width, bitmap.height)) : 1;
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * ratio)), Math.max(1, Math.round(bitmap.height * ratio)));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('INPUT_UNSUPPORTED');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const output = await canvas.convertToBlob({ type: preview ? 'image/jpeg' : 'image/png', quality: 0.7 });
    if (!output.size || output.size > maximumBytes) throw new Error('INPUT_UNSUPPORTED');
    const encoded = new Uint8Array(await output.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < encoded.length; offset += 8192) binary += String.fromCharCode(...encoded.subarray(offset, offset + 8192));
    return { base64Data: btoa(binary), mimeType: output.type, width: canvas.width, height: canvas.height };
  } finally { bitmap.close(); }
}

/** A single isolated renderer bounds native decoder failures independently of the desktop.
 * The lane stays reserved until the OS confirms the exact child gone; an unconfirmed exit
 * disables further decoding rather than accumulating stuck renderers. */
export class RemoteImageDecoder {
  private static busy = false;
  private exitConfirmed = true;
  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (RemoteImageDecoder.busy) throw new Error('INPUT_UNSUPPORTED');
    RemoteImageDecoder.busy = true; this.exitConfirmed = true;
    try { return await run(); }
    finally { if (this.exitConfirmed) RemoteImageDecoder.busy = false; }
  }
  private alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }
  async preview(filePath: string, context: RemoteImageContext): Promise<DecodedImage> {
    return this.exclusive(() => this.decode(filePath, true, 128 * 1024, context));
  }
  async convert(filePath: string, targetPath: string, maximumBytes: number, context: RemoteImageContext): Promise<{ path: string; mimeType: string }> {
    return this.exclusive(async () => {
      const result = await this.decode(filePath, false, maximumBytes, context);
      if (!context.current() || context.signal?.aborted) throw new Error('INPUT_UNSUPPORTED');
      const bytes = Buffer.from(result.base64Data, 'base64');
      const header = inspectRemoteImage(bytes);
      if (header.mimeType !== 'image/png' || header.width !== result.width || header.height !== result.height || bytes.length > maximumBytes) throw new Error('INPUT_UNSUPPORTED');
      const temporary = `${targetPath}.${randomUUID()}.part`;
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        if (!context.current() || context.signal?.aborted) throw new Error('INPUT_UNSUPPORTED');
        // Exclusive publication, unlike rename, cannot overwrite an existing attachment.
        await fs.link(temporary, targetPath);
        return { path: targetPath, mimeType: result.mimeType };
      } finally { await fs.rm(temporary, { force: true }); }
    });
  }
  private async decode(filePath: string, preview: boolean, maximumBytes: number, context: RemoteImageContext): Promise<DecodedImage> {
    const current = (): boolean => { try { return context.current() && !context.signal?.aborted; } catch { return false; } };
    if (!current() || !Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) throw new Error('INPUT_UNSUPPORTED');
    let window: BrowserWindow | undefined, pid = 0, gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined, watchdog: ReturnType<typeof setInterval> | undefined;
    let cancel: (() => void) | undefined;
    try {
      const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let input: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size <= 0 || stat.size > RemoteImageBudget.InputBytes) throw new Error('INPUT_UNSUPPORTED');
        // The declared size was already hash-verified by input preparation. Never read
        // beyond this bound if another process modifies the supposedly immutable file.
        input = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < input.length) {
          const read = await handle.read(input, offset, input.length - offset, offset);
          if (!read.bytesRead || !current()) throw new Error('INPUT_UNSUPPORTED');
          offset += read.bytesRead;
        }
        const after = await handle.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('INPUT_UNSUPPORTED');
      } finally { await handle.close(); }
      const header = inspectRemoteImage(input);
      if (!current()) throw new Error('INPUT_UNSUPPORTED');
      this.exitConfirmed = false;
      window = new BrowserWindow({ show: false, width: 1, height: 1, skipTaskbar: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
          partition: `remote-image-${randomUUID()}`, devTools: false, backgroundThrottling: false,
          spellcheck: false, enableWebSQL: false, disableDialogs: true, navigateOnDragDrop: false } });
      const renderer = window.webContents;
      renderer.setWindowOpenHandler(() => ({ action: 'deny' }));
      renderer.on('will-navigate', event => event.preventDefault());
      renderer.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      renderer.session.setPermissionCheckHandler(() => false);
      renderer.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'file://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
      const result = await new Promise<DecodedImage>((resolve, reject) => {
        cancel = () => reject(new Error('INPUT_UNSUPPORTED'));
        context.signal?.addEventListener('abort', cancel, { once: true });
        renderer.once('render-process-gone', () => { gone = true; cancel?.(); });
        timer = setTimeout(cancel, preview ? 2000 : RemoteImageBudget.TimeoutMs);
        watchdog = setInterval(() => {
          try {
            if (!current()) { cancel?.(); return; }
            pid ||= renderer.getOSProcessId();
            const memory = pid ? app.getAppMetrics().find(metric => metric.pid === pid)?.memory : undefined;
            if (memory && memory.workingSetSize * 1024 > RemoteImageBudget.RssBytes) cancel?.();
          } catch { cancel?.(); }
        }, 50);
        void (async () => {
          await window!.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; script-src 'none'; connect-src 'none'">`));
          pid = renderer.getOSProcessId();
          if (!pid || !current()) throw new Error('INPUT_UNSUPPORTED');
          const args = [input.toString('base64'), header.mimeType, preview, Math.min(maximumBytes, RemoteImageBudget.OutputBytes), RemoteImageBudget.Pixels];
          resolve(await renderer.executeJavaScript(`(${decodeInRenderer.toString()})(...${JSON.stringify(args)})`) as DecodedImage);
        })().catch(reject);
      });
      if (!current() || !result || typeof result.base64Data !== 'string' || result.base64Data.length > 4 * Math.ceil(Math.min(maximumBytes, RemoteImageBudget.OutputBytes) / 3)
        || result.mimeType !== (preview ? 'image/jpeg' : 'image/png') || !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height)
        || result.width <= 0 || result.height <= 0 || result.width > (preview ? 256 : RemoteImageBudget.Dimension)
        || result.height > (preview ? 256 : RemoteImageBudget.Dimension) || result.width * result.height > RemoteImageBudget.Pixels
        || !/^[A-Za-z0-9+/]*={0,2}$/u.test(result.base64Data) || Buffer.from(result.base64Data, 'base64').length > maximumBytes) throw new Error('INPUT_UNSUPPORTED');
      return result;
    } finally {
      if (timer) clearTimeout(timer); if (watchdog) clearInterval(watchdog);
      if (cancel) context.signal?.removeEventListener('abort', cancel);
      if (window && !window.isDestroyed()) {
        pid ||= window.webContents.getOSProcessId();
        if (pid && !gone) window.webContents.forcefullyCrashRenderer();
        window.destroy();
      }
      const deadline = Date.now() + 5000;
      while (pid && this.alive(pid) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 25));
      // Missing Chromium metrics or a still-unassigned PID is not exit confirmation.
      // Retain the lane on unknown termination, including an unfinished loadURL.
      if (window && pid && !this.alive(pid)) this.exitConfirmed = true;
    }
  }
}
