import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { assertSqliteSchemaContains, collectSqliteNamedIndexContract } from '#openclaw-schema-contract';
import { assertCurrentStateRuntimeSchema } from '#openclaw-state-schema-validation';
import { STATE_PERSISTENT_SCHEMA_COMPATIBILITY } from '#openclaw-state-schema-compatibility';
import { OPENCLAW_STATE_SCHEMA_SQL } from '#openclaw-state-schema';
import { assertOpenClawStateWriteAllowed } from '#openclaw-state-ownership';
import { withStateSchemaFence } from '#openclaw-state-coordinator';

const TABLE = 'current_conversation_bindings';
const TARGET_INDEX = 'idx_current_conversation_bindings_target';
const SCHEMA_VERSION = 15;
const RETIRED_COLUMNS = ['target_agent_id', 'target_session_id'];
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const indexFingerprint = ({ sql: _sql, ...contract } = {}) => JSON.stringify(contract);

function canonicalBindingSchema() {
  const reference = new DatabaseSync(':memory:');
  try {
    reference.exec(OPENCLAW_STATE_SCHEMA_SQL);
    const objects = reference.prepare('SELECT name, sql FROM sqlite_schema WHERE tbl_name = ? AND sql IS NOT NULL').all(TABLE);
    const columns = reference.prepare(`PRAGMA table_xinfo(${TABLE})`).all().map(row => row.name);
    const targetIndex = objects.find(row => row.name === TARGET_INDEX).sql;
    const currentIndex = indexFingerprint(collectSqliteNamedIndexContract(reference, TARGET_INDEX));
    // Compare index columns/order/collation/uniqueness, independently of SQL whitespace.
    reference.exec(`ALTER TABLE ${TABLE} ADD COLUMN target_agent_id TEXT NOT NULL; DROP INDEX ${TARGET_INDEX};`
      + targetIndex.replace('(target_session_key,', '(target_agent_id, target_session_key,'));
    return {
      sql: objects.map(row => row.sql + ';').join('\n'),
      targetIndex,
      targetIndexes: [currentIndex, indexFingerprint(collectSqliteNamedIndexContract(reference, TARGET_INDEX))],
      columns,
      indexes: new Set(objects.filter(row => row.name !== TABLE).map(row => row.name)),
    };
  } finally { reference.close(); }
}

function removeRetiredColumns(db, columns, canonical) {
  db.exec(`DROP INDEX IF EXISTS ${TARGET_INDEX}`);
  for (const column of columns) db.exec(`ALTER TABLE ${TABLE} DROP COLUMN ${quote(column)}`);
  db.exec(canonical.targetIndex);
}

function inspectRecognizedShape(db, canonical) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const meta = db.prepare("SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary'").get();
  if (version !== SCHEMA_VERSION || meta?.schema_version !== SCHEMA_VERSION || meta.role !== 'global') {
    throw new Error('Binding recovery only supports consistent shared-state schema 15 metadata.');
  }
  const columns = db.prepare(`PRAGMA table_xinfo(${TABLE})`).all();
  const retired = columns.filter(row => RETIRED_COLUMNS.includes(row.name));
  if (!retired.length) {
    assertCurrentStateRuntimeSchema(db, TABLE);
    return [];
  }
  for (const column of retired) {
    const expectedRequired = column.name === RETIRED_COLUMNS[0] ? 1 : 0;
    const expectedDefault = column.name === RETIRED_COLUMNS[0] && column.dflt_value === "'main'";
    if (column.type !== 'TEXT' || column.notnull !== expectedRequired || column.pk !== 0 || column.hidden !== 0
      || (column.dflt_value !== null && !expectedDefault)) {
      throw new Error(`Unrecognized retired binding column: ${column.name}`);
    }
  }
  if (columns.some(column => !canonical.columns.includes(column.name) && !RETIRED_COLUMNS.includes(column.name))) {
    throw new Error('Binding recovery refuses unknown additional columns.');
  }
  const objects = db.prepare('SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = ? AND sql IS NOT NULL').all(TABLE);
  if (objects.some(row => !['table', 'index'].includes(row.type) || (row.name !== TABLE && !canonical.indexes.has(row.name)))
    || db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'view'").all()
      .some(row => new RegExp(`\\b${TABLE}\\b`, 'i').test(row.sql))) {
    throw new Error('Binding recovery refuses custom indexes, triggers or dependent views.');
  }
  if (!canonical.targetIndexes.includes(indexFingerprint(collectSqliteNamedIndexContract(db, TARGET_INDEX)))) {
    throw new Error('Binding recovery refuses an unrecognized target index.');
  }
  // Prove that only removing the retired projections produces the pinned table.
  // No live SQL is changed while checking unknown constraints/defaults.
  const probe = new DatabaseSync(':memory:');
  try {
    for (const object of objects.sort((left, right) => Number(right.type === 'table') - Number(left.type === 'table'))) {
      probe.exec(object.sql);
    }
    const compatibility = { allowedColumnDefinitions: STATE_PERSISTENT_SCHEMA_COMPATIBILITY.allowedColumnDefinitions };
    const legacySchema = canonical.sql + '\n' + retired.map(column =>
      `ALTER TABLE ${TABLE} ADD COLUMN ${column.name} TEXT${column.notnull ? ' NOT NULL' : ''}`
        + `${column.dflt_value === null ? '' : ` DEFAULT ${column.dflt_value}`};`).join('\n');
    // Its two accepted semantic definitions were checked above. Normalize only
    // this index in the disposable probe before comparing all column constraints.
    probe.exec(`DROP INDEX ${TARGET_INDEX}; ${canonical.targetIndex}`);
    assertSqliteSchemaContains(probe, TABLE, legacySchema, compatibility);
    removeRetiredColumns(probe, retired.map(row => row.name), canonical);
    assertSqliteSchemaContains(probe, TABLE, canonical.sql, compatibility);
  } finally { probe.close(); }
  return retired.map(row => row.name);
}

function retainedDataDigest(db, columns) {
  const statement = db.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${TABLE} ORDER BY binding_key`);
  statement.setReadBigInts(true);
  const digest = createHash('sha256');
  let count = 0;
  for (const row of statement.iterate()) {
    digest.update(JSON.stringify(columns.map(column => {
      const value = row[column];
      return [typeof value, typeof value === 'bigint' ? value.toString() : value];
    })) + '\n');
    count++;
  }
  return `${count}:${digest.digest('hex')}`;
}

/** Called only after the matching startup failure, under the stopped-gateway lease. */
export async function recoverRetiredBindingColumns({ stateDir, env, backups }) {
  const databasePath = path.join(stateDir, 'state', 'openclaw.sqlite');
  if (!fs.existsSync(databasePath)) throw new Error('Shared-state database is missing; binding recovery cannot recreate it.');
  const canonical = canonicalBindingSchema();
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (inspectRecognizedShape(source, canonical).length === 0) return null;
    const integrity = source.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error('Binding recovery refused a database that failed integrity_check.');
    }
    const directory = path.join(stateDir, 'startup-recovery-backups');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const backupPath = path.join(directory, `openclaw-${Date.now()}-${randomUUID()}.sqlite`);
    await backup(source, backupPath);
    fs.chmodSync(backupPath, 0o600);
    backups.push(backupPath);
  } finally { source.close(); }

  withStateSchemaFence({ databasePath }, () => {
    const db = new DatabaseSync(databasePath);
    try {
      db.exec('PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
      assertOpenClawStateWriteAllowed({ database: db, databasePath, env });
      const retired = inspectRecognizedShape(db, canonical);
      const before = retainedDataDigest(db, canonical.columns);
      removeRetiredColumns(db, retired, canonical);
      assertCurrentStateRuntimeSchema(db, databasePath);
      if (retainedDataDigest(db, canonical.columns) !== before || db.prepare('PRAGMA foreign_key_check').all().length) {
        throw new Error('Binding recovery failed retained-data or foreign-key verification.');
      }
      const integrity = db.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
        throw new Error('Binding recovery failed final integrity verification.');
      }
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    } finally { db.close(); }
  });
  return `Removed retired binding projections; schema ${SCHEMA_VERSION} and retained data verified.`;
}
