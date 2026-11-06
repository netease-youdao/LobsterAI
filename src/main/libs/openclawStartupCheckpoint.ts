import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// OpenClaw v2026.8.1 src/infra/startup-migration-checkpoint.ts STARTUP_MIGRATION_META_KEY.
const STARTUP_MIGRATION_META_KEY = 'startup-migrations';
// Same file, formatStartupMigrationCheckpoint: the parts joined into app_version, in order.
const STARTUP_MIGRATION_CHECKPOINT_SEPARATOR = '\n';
const STARTUP_MIGRATION_CHECKPOINT_PARTS = [
  'version',
  'format',
  'buildIdentity',
  'effectiveConfig',
  'pluginDoctorConfig',
  'pluginMigration',
] as const;

export const StartupMigrationCheckpointOutcome = {
  Hit: 'hit',
  Miss: 'miss',
  Unknown: 'unknown',
} as const;
export type StartupMigrationCheckpointOutcome =
  typeof StartupMigrationCheckpointOutcome[keyof typeof StartupMigrationCheckpointOutcome];

export type StartupMigrationCheckpoint = {
  updatedAt: number;
  value: string | null;
};

/**
 * OpenClaw's startup-migration checkpoint row. The gateway rewrites it only
 * after rerunning its migrations, so an unchanged stamp across a start means
 * the checkpoint matched.
 */
export function readStartupMigrationCheckpoint(stateDir: string): StartupMigrationCheckpoint | null {
  const databasePath = path.join(stateDir, 'state', 'openclaw.sqlite');
  if (!fs.existsSync(databasePath)) return null;
  let database: Database.Database | null = null;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 250 });
    const row = database.prepare('SELECT app_version AS value, updated_at AS updatedAt FROM schema_meta WHERE meta_key = ?')
      .get(STARTUP_MIGRATION_META_KEY) as { value?: unknown; updatedAt?: unknown } | undefined;
    if (typeof row?.updatedAt !== 'number') return null;
    return { updatedAt: row.updatedAt, value: typeof row.value === 'string' ? row.value : null };
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

/**
 * Names the checkpoint parts that differ between two recorded checkpoints, so
 * a miss says which input (runtime build, config or plugin set) invalidated it.
 */
export function listChangedStartupMigrationCheckpointParts(
  before: StartupMigrationCheckpoint | null,
  after: StartupMigrationCheckpoint | null,
): string[] {
  if (!before?.value || !after?.value) return [];
  const beforeParts = before.value.split(STARTUP_MIGRATION_CHECKPOINT_SEPARATOR);
  const afterParts = after.value.split(STARTUP_MIGRATION_CHECKPOINT_SEPARATOR);
  const length = Math.max(beforeParts.length, afterParts.length);
  const changed: string[] = [];
  for (let index = 0; index < length; index += 1) {
    if (beforeParts[index] !== afterParts[index]) {
      changed.push(STARTUP_MIGRATION_CHECKPOINT_PARTS[index] ?? `part${index}`);
    }
  }
  return changed;
}
