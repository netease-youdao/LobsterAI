import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ windows: [] as any[], metrics: [] as any[], response: null as any, stop: true, pid: 12345, loading: false }));
vi.mock('electron', () => ({
  app: { getAppMetrics: () => mocks.metrics },
  BrowserWindow: class {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      getOSProcessId: () => mocks.pid,
      setWindowOpenHandler: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), webRequest: { onBeforeRequest: vi.fn() } },
      executeJavaScript: vi.fn(() => mocks.response instanceof Promise ? mocks.response : Promise.resolve(mocks.response)),
      forcefullyCrashRenderer: vi.fn(() => {
        if (mocks.stop) { mocks.metrics = []; this.webContents.emit('render-process-gone'); }
      }),
    });
    constructor(readonly options: unknown) { mocks.windows.push(this); mocks.metrics = [{ pid: 12345, memory: { workingSetSize: 1000 } }]; }
    isDestroyed(): boolean { return this.destroyed; }
    destroy(): void { this.destroyed = true; }
    async loadURL(): Promise<void> { if (mocks.loading) await new Promise<void>(() => undefined); }
  },
}));

import { RemoteImageDecoder } from './remoteImageDecoder';
import { inspectRemoteImage, RemoteImageBudget } from './remoteImageHeader';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG9sAAAAASUVORK5CYII=', 'base64');
let root: string, input: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-image-test-')); input = path.join(root, 'input.png'); fs.writeFileSync(input, png);
  mocks.windows = []; mocks.stop = true; mocks.metrics = []; mocks.pid = 12345; mocks.loading = false;
  vi.spyOn(process, 'kill').mockImplementation(pid => {
    if (mocks.metrics.some(value => value.pid === pid)) return true;
    throw Object.assign(new Error('Exited'), { code: 'ESRCH' });
  });
  mocks.response = { base64Data: png.toString('base64'), mimeType: 'image/png', width: 1, height: 1 };
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); fs.rmSync(root, { force: true, recursive: true }); });

describe('remote image admission and renderer lifetime', () => {
  it('rejects a tiny PNG claiming excessive dimensions before creating a native decoder', async () => {
    const bytes = Buffer.from(png); bytes.writeUInt32BE(100000, 16); fs.writeFileSync(input, bytes);
    await expect(new RemoteImageDecoder().convert(input, path.join(root, 'out.png'), 1000, { current: () => true })).rejects.toThrow('INPUT_UNSUPPORTED');
    expect(mocks.windows).toHaveLength(0);
  });
  it('validates common header formats and rejects truncated or unsupported input', () => {
    expect(inspectRemoteImage(png)).toEqual({ width: 1, height: 1, mimeType: 'image/png' });
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'); expect(inspectRemoteImage(gif)).toMatchObject({ width: 1, height: 1, mimeType: 'image/gif' });
    const webp = Buffer.alloc(30); webp.write('RIFF'); webp.write('WEBPVP8X', 8); webp.writeUIntLE(1, 24, 3); webp.writeUIntLE(2, 27, 3);
    expect(inspectRemoteImage(webp)).toMatchObject({ width: 2, height: 3, mimeType: 'image/webp' });
    expect(() => inspectRemoteImage(Buffer.from('<svg></svg>'))).toThrow();
    expect(() => inspectRemoteImage(png.subarray(0, 20))).toThrow();
  });
  it('rejects APNG, animated WebP and multiple GIF frames without native decoding', () => {
    const animation = Buffer.alloc(20); animation.writeUInt32BE(8); animation.write('acTL', 4);
    expect(() => inspectRemoteImage(Buffer.concat([png.subarray(0, 33), animation, png.subarray(33)]))).toThrow();
    const webp = Buffer.alloc(30); webp.write('RIFF'); webp.write('WEBPVP8X', 8); webp[20] = 2;
    expect(() => inspectRemoteImage(webp)).toThrow();
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const frame = gif.subarray(gif.indexOf(0x2c), -1);
    expect(() => inspectRemoteImage(Buffer.concat([gif.subarray(0, -1), frame, Buffer.from([0x3b])]))).toThrow();
  });
  it('uses an isolated sandbox and publishes only validated bytes after renderer termination', async () => {
    const target = path.join(root, 'out.png');
    expect(await new RemoteImageDecoder().convert(input, target, 1000, { current: () => true })).toEqual({ path: target, mimeType: 'image/png' });
    expect(fs.readFileSync(target)).toEqual(png);
    expect(mocks.windows[0].options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(mocks.windows[0].webContents.forcefullyCrashRenderer).toHaveBeenCalledOnce();
    expect(mocks.metrics).toEqual([]);
  });
  it('rejects forged or over-budget decoder output and preserves any existing destination', async () => {
    const target = path.join(root, 'out.png'); fs.writeFileSync(target, 'existing');
    await expect(new RemoteImageDecoder().convert(input, target, 1000, { current: () => true })).rejects.toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('existing');
    mocks.response = { ...mocks.response, width: 2 };
    await expect(new RemoteImageDecoder().convert(input, path.join(root, 'new.png'), 1000, { current: () => true })).rejects.toThrow();
    expect(fs.existsSync(path.join(root, 'new.png'))).toBe(false);
    mocks.response = { ...mocks.response, base64Data: 'a'.repeat(200000) };
    await expect(new RemoteImageDecoder().preview(input, { current: () => true })).rejects.toThrow();
  });
  it('cancels a hung decoder and holds the lane until the exact renderer is gone', async () => {
    const decoder = new RemoteImageDecoder(), abort = new AbortController();
    mocks.stop = false; mocks.response = new Promise(() => undefined);
    const running = decoder.convert(input, path.join(root, 'out.png'), 1000, { current: () => true, signal: abort.signal });
    const rejected = expect(running).rejects.toThrow('INPUT_UNSUPPORTED');
    await vi.waitFor(() => expect(mocks.windows[0]?.webContents.executeJavaScript).toHaveBeenCalledOnce());
    abort.abort();
    await vi.waitFor(() => expect(mocks.windows[0].webContents.forcefullyCrashRenderer).toHaveBeenCalledOnce());
    await expect(decoder.convert(input, path.join(root, 'other.png'), 1000, { current: () => true })).rejects.toThrow();
    expect(mocks.windows).toHaveLength(1);
    mocks.metrics = []; await rejected;
    expect(fs.existsSync(path.join(root, 'out.png'))).toBe(false);
  });
  it.each(['memory', 'account', 'deadline'])('stops isolated decoding on %s without publishing required input', async reason => {
    const decoder = new RemoteImageDecoder(); let current = true;
    mocks.response = new Promise(() => undefined);
    const running = decoder.preview(input, { current: () => current });
    const rejected = expect(running).rejects.toThrow('INPUT_UNSUPPORTED');
    await vi.waitFor(() => expect(mocks.windows[0]?.webContents.executeJavaScript).toHaveBeenCalledOnce());
    if (reason === 'memory') mocks.metrics[0].memory.workingSetSize = RemoteImageBudget.RssBytes / 1024 + 1;
    if (reason === 'account') current = false;
    await rejected;
    expect(mocks.windows[0].webContents.forcefullyCrashRenderer).toHaveBeenCalledOnce();
    expect(mocks.metrics).toEqual([]);
  });
  it.each(['unobservable', 'unassigned'])('keeps all decoder instances fenced when renderer termination is %s', async mode => {
    vi.resetModules();
    const { RemoteImageDecoder: Decoder } = await import('./remoteImageDecoder');
    const decoder = new Decoder(), abort = new AbortController();
    mocks.response = new Promise(() => undefined);
    if (mode === 'unassigned') { mocks.pid = 0; mocks.loading = true; }
    const pending = decoder.preview(input, { current: () => true, signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow('INPUT_UNSUPPORTED');
    await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
    if (mode === 'unobservable') {
      await vi.waitFor(() => expect(mocks.windows[0].webContents.executeJavaScript).toHaveBeenCalledOnce());
      vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Unobservable'), { code: 'EPERM' }); });
    }
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    abort.abort(); await vi.advanceTimersByTimeAsync(5100); await rejected;
    await expect(new Decoder().preview(input, { current: () => true })).rejects.toThrow('INPUT_UNSUPPORTED');
    expect(mocks.windows).toHaveLength(1);
    expect(mocks.windows[0].destroyed).toBe(true);
  });

});
