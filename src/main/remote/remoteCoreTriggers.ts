import type Database from 'better-sqlite3';

/** Only repository-owned names/SQL enter here. The caller owns the encompassing core transaction. */
export function replaceCoreTrigger(db: Database.Database, sql: string): void {
  const name = /^CREATE TRIGGER ([a-z_]+)\b/u.exec(sql.trim())?.[1];
  if (!name || !db.inTransaction) throw new Error('REMOTE_CORE_TRIGGER_MIGRATION_INVALID');
  const normalize = (value: string): string => value.trim().replace(/;$/u, '').replace(/\s+/gu, ' ');
  const previous = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | undefined;
  if (previous && normalize(previous.sql) === normalize(sql)) return;
  db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  db.exec(sql);
}
