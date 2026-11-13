import type Database from 'better-sqlite3';

import { payloadHash } from './canonical';
import { classifyTaskSyncFailure } from './remoteTaskSyncPolicy';
import type { TaskSyncContext } from './remoteTaskSyncState';

interface DependencyState { version: 1; epoch: number; unavailable: boolean }
const MaxEpoch = 2147483647;
const prefix = 'autoRecoveryDependency:';
export function isRecoveryDependencyFailure(error: unknown): boolean {
  const failure = classifyTaskSyncFailure(error);
  return failure.scope === 'service' && (failure.phase === 'backoff' || failure.phase === 'cooldown');
}
/** Connectivity evidence only; it never grants publication or consumes a task's recovery budget. */
export class RemoteRecoveryDependency {
  constructor(private readonly db: Database.Database) {}
  private key(context: TaskSyncContext): string { return prefix + payloadHash(context); }
  private read(context: TaskSyncContext): DependencyState | null {
    const row = this.db.prepare('SELECT value FROM remote_state WHERE key=?').get(this.key(context)) as { value: string } | undefined;
    if (!row) return { version: 1, epoch: 0, unavailable: false };
    if (row.value.length > 256) return null;
    try {
      const value = JSON.parse(row.value) as DependencyState;
      return value?.version === 1 && Number.isSafeInteger(value.epoch) && value.epoch >= 0 && value.epoch <= MaxEpoch
        && typeof value.unavailable === 'boolean' ? value : null;
    } catch { return null; }
  }
  epoch(context: TaskSyncContext): number | null { return this.read(context)?.epoch ?? null; }
  observe(context: TaskSyncContext, success: boolean): boolean {
    return this.db.transaction(() => {
      const before = this.read(context);
      if (!before || success && !before.unavailable || !success && before.unavailable || success && before.epoch === MaxEpoch) return false;
      const next: DependencyState = { version: 1, epoch: before.epoch + (success ? 1 : 0), unavailable: !success };
      this.db.prepare('INSERT INTO remote_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(this.key(context), JSON.stringify(next));
      return success;
    })();
  }
}
