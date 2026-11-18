// Bundled into the one-click repair helper with openclawCompatibilityRepairCore;
// keep this module free of Electron and other app imports.
import fs from 'node:fs';
import path from 'node:path';

import {
  type OpenClawRepairPhase, type OpenClawRepairProgress, OpenClawRepairProgressStage,
} from '../../shared/openclawEngine/repair';
import { resolveSnapshotSkipReason } from './openclawRepairSnapshotPaths';

/**
 * How often a running snapshot reports progress: far below the app's idle
 * limit, and sparse enough that hours of reports stay well inside the app
 * runner's 1 MiB stdout buffer.
 */
export const SNAPSHOT_PROGRESS_INTERVAL_MS = 10_000;
/** Files at least this large are copied in chunks, so progress moves inside one file. */
export const SNAPSHOT_CHUNKED_COPY_MIN_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_COPY_CHUNK_BYTES = 4 * 1024 * 1024;

export type RepairProgressReporter = (progress: OpenClawRepairProgress) => void;

export interface SnapshotTotals {
  files: number;
  bytes: number;
}

/**
 * Counts snapshot work and reports it at most once per interval, and only when
 * the counts moved. A copy stuck in one I/O call therefore stays silent, and
 * the app's idle limit still stops a hung helper. Every copy must be
 * asynchronous for the interval to run while it is in flight.
 */
export class SnapshotProgress {
  private stage: OpenClawRepairProgressStage = OpenClawRepairProgressStage.Scan;
  private files = 0;
  private bytes = 0;
  private totals?: SnapshotTotals;
  private lastReported = '';
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly phase: OpenClawRepairPhase, private readonly report?: RepairProgressReporter) {}

  start(): void {
    if (!this.report || this.timer) return;
    this.timer = setInterval(() => this.flush(), SNAPSHOT_PROGRESS_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  add(files: number, bytes: number): void {
    this.files += files;
    this.bytes += bytes;
  }

  /** Ends the scan and reports the totals at once, so the app can size its wait. */
  plan(totals: SnapshotTotals): void {
    this.stage = OpenClawRepairProgressStage.Copy;
    this.files = 0;
    this.bytes = 0;
    this.totals = totals;
    this.flush();
  }

  /** Reports the current counts unless exactly these were reported last. */
  flush(): void {
    if (!this.report) return;
    const progress: OpenClawRepairProgress = {
      phase: this.phase, stage: this.stage, files: this.files, bytes: this.bytes,
      ...(this.totals ? { totalFiles: this.totals.files, totalBytes: this.totals.bytes } : {}),
    };
    const key = JSON.stringify(progress);
    if (key === this.lastReported) return;
    this.lastReported = key;
    this.report(progress);
  }
}

/**
 * Measures what a snapshot of `stateDir` copies: regular files and links
 * outside the paths it skips, without following links. This is an estimate for
 * the wait budget; entries that cannot be read are left to the copy pass, which
 * reports them with their path.
 */
export async function measureSnapshotSource(stateDir: string, progress: SnapshotProgress): Promise<SnapshotTotals> {
  const totals: SnapshotTotals = { files: 0, bytes: 0 };
  async function visit(directory: string): Promise<void> {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const source = path.join(directory, entry.name);
      if (resolveSnapshotSkipReason(path.relative(stateDir, source), entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        await visit(source);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        let bytes = 0;
        if (entry.isFile()) {
          try { bytes = (await fs.promises.lstat(source)).size; } catch { /* the copy pass reports it */ }
        }
        totals.files += 1;
        totals.bytes += bytes;
        progress.add(1, bytes);
      }
    }
  }
  await visit(stateDir);
  return totals;
}

/**
 * Copies a regular file to a target that must not exist yet, reporting bytes
 * as they are written. Small files use the platform copy; large ones are
 * copied in chunks so a slow disk shows progress within a single file.
 */
export async function copySnapshotFile(
  source: string, target: string, size: number, onBytes: (bytes: number) => void,
): Promise<void> {
  if (size < SNAPSHOT_CHUNKED_COPY_MIN_BYTES) {
    await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    onBytes(size);
    return;
  }
  const input = await fs.promises.open(source, 'r');
  try {
    const output = await fs.promises.open(target, 'wx', 0o600);
    try {
      const buffer = Buffer.allocUnsafe(SNAPSHOT_COPY_CHUNK_BYTES);
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        for (let offset = 0; offset < bytesRead;) {
          offset += (await output.write(buffer, offset, bytesRead - offset)).bytesWritten;
        }
        onBytes(bytesRead);
      }
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}
