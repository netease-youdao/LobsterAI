import fs from 'node:fs/promises';
import path from 'node:path';

import { RemoteTelemetryLimit } from '../../shared/remote/telemetry';

const SegmentBytes = 192 * 1024;
const SegmentCount = 20;
const SegmentName = /^segment-\d{2}\.jsonl(?:\.tmp)?$/u;
export interface RemoteTelemetrySpoolRecord { eventId: string; epoch: string; createdAt: number; }
/** Disposable telemetry snapshots only. Serialized replacement coalesces writes and cannot grow an IO queue. */
export class RemoteTelemetrySpool<T extends RemoteTelemetrySpoolRecord> {
  private pending: readonly T[] | null = null;
  private running: Promise<void> | null = null;
  private revision = 0;
  constructor(private readonly directory: string, private readonly onFailure: () => void = () => undefined) {}

  replace(records: readonly T[]): void {
    this.revision++;
    this.pending = records.slice(0, RemoteTelemetryLimit.Queue);
    if (!this.running) this.running = this.pump().finally(() => {
      this.running = null;
      if (this.pending) this.replace(this.pending);
    });
  }

  private async pump(): Promise<void> {
    while (this.pending) {
      const records = this.pending, revision = this.revision;
      this.pending = null;
      try {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const segments: string[] = [];
        let segment = '', bytes = 0, total = 0, rows = 0;
        for (const record of records) {
          const line = JSON.stringify(record) + '\n', size = Buffer.byteLength(line);
          if (size > 8192 || total + size > RemoteTelemetryLimit.SpoolBytes) continue;
          if (bytes + size > SegmentBytes || rows >= 50) { segments.push(segment); segment = ''; bytes = 0; rows = 0; }
          if (segments.length >= SegmentCount) break;
          segment += line; bytes += size; total += size; rows++;
        }
        if (segment) segments.push(segment);
        for (let index = 0; index < SegmentCount; index++) {
          const target = path.join(this.directory, `segment-${String(index).padStart(2, '0')}.jsonl`);
          if (index < segments.length) {
            await fs.writeFile(target + '.tmp', segments[index], { mode: 0o600 });
            // Account/consent changes invalidate this snapshot before publication.
            if (revision !== this.revision) { await fs.rm(target + '.tmp', { force: true }); break; }
            await fs.rename(target + '.tmp', target);
          } else await fs.rm(target, { force: true });
        }
      } catch { this.onFailure(); }
      // Always give the event loop a chance between snapshots.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  async restore(accept: (value: unknown) => T | null, current: () => boolean): Promise<T[]> {
    const result: T[] = [];
    let total = 0;
    try {
      // Read only the finite names this module owns, not arbitrary directory contents.
      for (let index = 0; index < SegmentCount && current(); index++) {
        const filename = `segment-${String(index).padStart(2, '0')}.jsonl`;
        if (!SegmentName.test(filename)) continue;
        let handle;
        try {
          handle = await fs.open(path.join(this.directory, filename), 'r');
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > SegmentBytes || total + stat.size > RemoteTelemetryLimit.SpoolBytes) { this.onFailure(); continue; }
          total += stat.size;
          // Explicit bounded read, including if a file grows after stat.
          const buffer = Buffer.alloc(Math.min(SegmentBytes, stat.size));
          const read = await handle.read(buffer, 0, buffer.length, 0);
          const lines = buffer.subarray(0, read.bytesRead).toString('utf8').split('\n');
          if (lines.length > 51) { this.onFailure(); continue; }
          for (const line of lines) {
            if (!line || !current()) continue;
            if (Buffer.byteLength(line) > 8192) { this.onFailure(); continue; }
            try { const value = accept(JSON.parse(line)); if (value) result.push(value); else this.onFailure(); }
            catch { this.onFailure(); }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onFailure();
        } finally { await handle?.close(); }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    } catch { this.onFailure(); }
    return current() ? result : [];
  }

  async flush(): Promise<void> {
    await this.running;
  }
}
