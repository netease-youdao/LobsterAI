import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import {
  closeOpenClawStateDatabaseByPath,
  detectOpenClawStateDatabaseSchemaMigrations,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from '#openclaw-state-db';
import { OPENCLAW_STATE_SCHEMA_VERSION } from '#openclaw-state-db-contract';
import { assertOpenClawStateDatabaseOwner, assertSupportedSchemaVersion } from '#openclaw-repair-state-check';
import { assertCurrentStateRuntimeSchema } from '#openclaw-state-schema-validation';
import { assertOwnedRepairPath } from '../src/main/libs/openclawCompatibilityRepairCore.ts';

function verifyIntegrity(db) {
  const rows = db.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok') {
    throw new Error('Shared-state migration refused a database that failed integrity_check.');
  }
}

/** Run under the startup helper's stopped-gateway lease, before any canonical DB consumer. */
export async function migrateSharedStateSchema({ stateDir, configPath, env, backups }) {
  const databasePath = path.join(stateDir, 'state', 'openclaw.sqlite');
  const backupRoot = path.join(stateDir, 'startup-recovery-backups');
  for (const file of [databasePath, databasePath + '-wal', databasePath + '-shm', configPath, backupRoot]) {
    assertOwnedRepairPath(stateDir, file);
  }
  if (!fs.existsSync(databasePath)) return [];

  let needsLegacyInitialization = false;
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assertSupportedSchemaVersion(source, databasePath);
    const version = source.prepare('PRAGMA user_version').get().user_version;
    // An empty first-use database is initialized by OpenClaw, not repaired as legacy state.
    if (version === 0 && !source.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) return [];
    if (version === OPENCLAW_STATE_SCHEMA_VERSION
      && detectOpenClawStateDatabaseSchemaMigrations({ stateDir, env }).length === 0) return [];
    assertOpenClawStateDatabaseOwner(source, { pathname: databasePath });
    const metadata = source.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get();
    if (version < 1 || metadata?.schema_version !== version) {
      throw new Error('Shared-state migration requires consistent legacy schema metadata.');
    }
    verifyIntegrity(source);
    needsLegacyInitialization = version === 1
      && !source.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'audit_events'").get();
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    const directory = fs.mkdtempSync(path.join(backupRoot, `state-schema-${Date.now()}-${randomUUID()}-`));
    const databaseBackup = path.join(directory, 'openclaw.sqlite');
    // The SQLite backup API retains committed WAL pages; copying the base file does not.
    await backup(source, databaseBackup);
    fs.chmodSync(databaseBackup, 0o600);
    backups.push(databaseBackup);
    const saved = new DatabaseSync(databaseBackup, { readOnly: true });
    try { verifyIntegrity(saved); } finally { saved.close(); }
    if (fs.existsSync(configPath)) {
      const configBackup = path.join(directory, 'openclaw.json');
      fs.copyFileSync(configPath, configBackup, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(configBackup, 0o600);
      backups.push(configBackup);
    }
  } finally { source.close(); }

  // The pinned owner validates recognized shapes and performs its migrations transactionally.
  // Do not implement parallel SQL migrations or run general Doctor/plugin repairs at startup.
  const result = repairOpenClawStateDatabaseSchema({ stateDir, env });
  if (result.warnings.length) throw new Error(result.warnings.join('\n'));
  if (needsLegacyInitialization) {
    // The pinned repair owner leaves pre-audit v1 at v1 so normal open can
    // initialize the complete schema. Finish that step under the same lease
    // and backup before requiring the current runtime schema below.
    try { openOpenClawStateDatabase({ path: databasePath, env }); }
    finally { closeOpenClawStateDatabaseByPath(databasePath); }
  }
  const verified = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assertCurrentStateRuntimeSchema(verified, databasePath);
    verifyIntegrity(verified);
  } finally { verified.close(); }
  return [...result.changes, `Verified shared-state schema ${OPENCLAW_STATE_SCHEMA_VERSION} before startup configuration migration.`];
}
