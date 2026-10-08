import fs from 'fs';
import path from 'path';

export const RemoteSidecarHeadroom = {
  CoreReserveBytes: 512 * 1024 * 1024,
  SidecarBytes: 512 * 1024 * 1024,
  WalBytes: 64 * 1024 * 1024,
} as const;

/** New optional work only. Existing immutable requests/receipts and core writes
 * remain writable. This physical headroom guard is not a whole-profile quota:
 * snapshots, caches and concurrent workers need their own admission reservations. */
export function assertRemoteSidecarHeadroom(filename: string, requestBytes: number, receiptBytes: number): void {
  if (filename === ':memory:') return;
  if (!Number.isSafeInteger(requestBytes) || requestBytes < 0 || !Number.isSafeInteger(receiptBytes) || receiptBytes < 0)
    throw new Error('REMOTE_SIDECAR_STORAGE_BUDGET');
  const directory = path.dirname(filename), disk = fs.statfsSync(directory);
  // Reserve room for SQLite pages, indexes and WAL amplification before sealing
  // a request that could otherwise create an unrecoverable remote outcome.
  const expected = 3 * (requestBytes + receiptBytes) + 64 * 1024;
  if (disk.bavail * disk.bsize < RemoteSidecarHeadroom.CoreReserveBytes + expected)
    throw new Error('REMOTE_SIDECAR_STORAGE_BUDGET');
  let total = 0;
  for (const name of ['remote-control.sqlite', 'remote-sync.sqlite']) {
    for (const suffix of ['', '-wal', '-shm']) {
      const file = path.join(directory, name + suffix);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('REMOTE_SIDECAR_STORAGE_BUDGET');
      total += stat.size;
      if (file === `${filename}-wal` && stat.size + expected > RemoteSidecarHeadroom.WalBytes)
        throw new Error('REMOTE_SIDECAR_STORAGE_BUDGET');
    }
  }
  if (total + expected > RemoteSidecarHeadroom.SidecarBytes) throw new Error('REMOTE_SIDECAR_STORAGE_BUDGET');
}
