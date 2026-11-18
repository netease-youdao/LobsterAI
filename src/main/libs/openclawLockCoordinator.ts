import Database from 'better-sqlite3';

import type { GatewayLockCoordinator } from './openclawGatewayLock';

/**
 * Mirrors OpenClaw's tryAcquireExclusiveSqliteCoordinator() on a gateway
 * lock's `<lock>.sqlite` companion. Kept out of openclawGatewayLock.ts because
 * the repair helper bundles that module without native dependencies. A
 * missing companion is never created: its writer never held one.
 */
export function tryAcquireOpenClawLockCoordinator(coordinatorPath: string): GatewayLockCoordinator | null {
  let database: Database.Database;
  try {
    database = new Database(coordinatorPath, { fileMustExist: true, timeout: 0 });
  } catch {
    return null;
  }
  try {
    database.exec('BEGIN EXCLUSIVE');
  } catch {
    // SQLITE_BUSY: the writer, or another contender, still holds it.
    database.close();
    return null;
  }
  return {
    release: () => {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Closing the connection ends the transaction as well.
      }
      database.close();
    },
  };
}
