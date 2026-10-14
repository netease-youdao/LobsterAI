import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// OpenClaw v2026.8.1 src/infra/startup-migration-checkpoint.ts STARTUP_MIGRATION_META_KEY.
const STARTUP_MIGRATION_META_KEY = 'startup-migrations';

export const StartupMigrationCheckpointOutcome = {
  Hit: 'hit',
  Miss: 'miss',
  Unknown: 'unknown',
} as const;
export type StartupMigrationCheckpointOutcome =
  typeof StartupMigrationCheckpointOutcome[keyof typeof StartupMigrationCheckpointOutcome];

/**
 * When OpenClaw last recorded its startup-migration checkpoint. The gateway
 * rewrites the row only after rerunning its migrations, so an unchanged value
 * across a start means the checkpoint matched.
 */
export function readStartupMigrationCheckpointStamp(stateDir: string): number | null {
  const databasePath = path.join(stateDir, 'state', 'openclaw.sqlite');
  if (!fs.existsSync(databasePath)) return null;
  let database: Database.Database | null = null;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 250 });
    const row = database.prepare('SELECT updated_at AS updatedAt FROM schema_meta WHERE meta_key = ?')
      .get(STARTUP_MIGRATION_META_KEY) as { updatedAt?: unknown } | undefined;
    return typeof row?.updatedAt === 'number' ? row.updatedAt : null;
  } catch {
    // Diagnostics only: a busy or older database must never affect startup.
    return null;
  } finally {
    database?.close();
  }
}

export function describeStartupMigrationCheckpoint(
  beforeSpawn: number | null,
  afterReady: number | null,
): StartupMigrationCheckpointOutcome {
  if (afterReady === null) return StartupMigrationCheckpointOutcome.Unknown;
  return beforeSpawn === afterReady ? StartupMigrationCheckpointOutcome.Hit : StartupMigrationCheckpointOutcome.Miss;
}
