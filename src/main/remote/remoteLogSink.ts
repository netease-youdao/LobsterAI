import fs from 'fs/promises';
import path from 'path';

type Level = 'debug' | 'info' | 'warn' | 'error';
const FILE_BYTES = 10 * 1024 * 1024;
const QUEUE_LIMIT = 1024;
const GENERAL_LIMIT = 768;
const LINE_BYTES = 4096;
const RETRY_MS = 30000;
const SLOW_REQUEST_MS = 1000;

/** One asynchronous writer, at most two 10 MiB files. No renderer/network/console fallback. */
export function createRemoteFileWriter(directory: string, maximum = FILE_BYTES): (text: string) => Promise<void> {
  const current = path.join(directory, 'remote.log'), previous = path.join(directory, 'remote.old.log');
  let initialized = false, bytes = 0;
  return async (text: string) => {
    const added = Buffer.byteLength(text);
    if (added > maximum) throw new Error('REMOTE_LOG_BATCH_TOO_LARGE');
    if (!initialized) {
      await fs.mkdir(directory, { recursive: true });
      try { bytes = (await fs.stat(current)).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      initialized = true;
    }
    try {
      if (bytes + added > maximum) {
        try { await fs.unlink(previous); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        try { await fs.rename(current, previous); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        bytes = 0;
      }
      await fs.appendFile(current, text, { encoding: 'utf8', mode: 0o600 });
      bytes += added;
    } catch (error) { initialized = false; throw error; }
  };
}

/** Bounded best-effort diagnostics. Persistence failure never enters the business call stack. */
export class RemoteLogQueue {
  private readonly queue: string[] = [];
  private pumping = false;
  private dropped = 0;
  private retryAt = 0;
  constructor(private readonly write: (text: string) => Promise<void>, private readonly clock = Date.now) {}
  enqueue(level: Level, message: string, fields: Record<string, unknown>): void {
    try {
      if (this.clock() < this.retryAt) { this.dropped++; return; }
      const event = typeof fields.event === 'string' ? fields.event : '';
      const succeeded = message === '[RemoteSync] Request succeeded';
      const completed = succeeded || event === 'remote.request.completed';
      const elapsed = fields.elapsedMs ?? fields.durationMs;
      const slow = completed && typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= SLOW_REQUEST_MS;
      const batchSuccess = succeeded && fields.operation === 'batch';
      if (batchSuccess) {
        // One compact receipt per batch correlates even fast requests with delayed local dispatch.
        const { events: _events, ...summary } = fields;
        fields = summary;
      }
      if (level === 'debug' && !batchSuccess && !slow && ((event === 'remote.request.completed' && fields.result === 'success')
        || message === '[RemoteSync] Request started' || succeeded)) {
        const requestId = typeof fields.requestId === 'string' ? fields.requestId : '';
        let bucket = 0; for (const ch of requestId) bucket = (bucket * 31 + ch.charCodeAt(0)) >>> 0;
        if (!requestId || bucket % 100 !== 0) return;
      }
      const critical = event.startsWith('desktop.') || event.startsWith('remote.command.') || level === 'error';
      if (this.queue.length >= (critical ? QUEUE_LIMIT : GENERAL_LIMIT)) { this.dropped++; return; }
      let line = JSON.stringify({ timestamp: new Date().toISOString(), level, message: message.slice(0, 160), fields });
      if (Buffer.byteLength(line) >= LINE_BYTES) {
        line = JSON.stringify({ timestamp: new Date().toISOString(), level, message: 'remote.log.truncated', fields: { truncated: true } });
      }
      this.queue.push(line + '\n');
      if (!this.pumping) { this.pumping = true; setImmediate(() => { void this.pump(); }); }
    } catch { this.dropped++; }
  }
  private async pump(): Promise<void> {
    const batch = this.queue.splice(0, 16);
    const lost = this.dropped; this.dropped = 0;
    if (lost) batch.unshift(JSON.stringify({ timestamp: new Date().toISOString(), level: 'warn', message: 'remote.log.dropped', fields: { count: lost } }) + '\n');
    try { if (batch.length) await this.write(batch.join('')); }
    catch {
      this.dropped += lost + batch.length + this.queue.length;
      this.queue.length = 0; this.retryAt = this.clock() + RETRY_MS;
    }
    this.pumping = false;
    if (this.queue.length) { this.pumping = true; setImmediate(() => { void this.pump(); }); }
  }
  snapshot(): { queued: number; writing: boolean; dropped: number } {
    return { queued: this.queue.length, writing: this.pumping, dropped: this.dropped };
  }
}

let queue: RemoteLogQueue | null = null;
export function configureRemoteLogSink(directory: string): void {
  if (!queue) queue = new RemoteLogQueue(createRemoteFileWriter(directory));
}
export function enqueueRemoteLog(level: Level, message: string, fields: Record<string, unknown>): void {
  try { queue?.enqueue(level, message, fields); } catch { /* Never recurse through console/electron-log. */ }
}
