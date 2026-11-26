import type Database from 'better-sqlite3';

import { payloadHash } from './canonical';

export const AvailabilityMigration = { Pending: 'REMOTE_AVAILABILITY_MIGRATING', Rows: 32, Bytes: 256 * 1024, RecordBytes: 1024 * 1024 } as const;
const Phase = { Hashes: 'hashes', Usage: 'usage', Ready: 'ready' } as const;
const receiptReserve = 64 * 1024;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** One page per accessor. Callers defer remote work between pages; core desktop writes never await migration. */
export function advanceAvailabilityMigration(db: Database.Database): boolean {
  return db.transaction(() => {
    const usageExists = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='availability_usage'").get();
    db.exec(`CREATE TABLE IF NOT EXISTS availability_migration(id INTEGER PRIMARY KEY CHECK(id=1),phase TEXT NOT NULL,row_cursor INTEGER NOT NULL,rebuild_usage INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS availability_usage(lane TEXT NOT NULL,scope TEXT NOT NULL,local_id TEXT NOT NULL,
        active_bytes INTEGER NOT NULL,archive_bytes INTEGER NOT NULL,reserved_bytes INTEGER NOT NULL,PRIMARY KEY(lane,scope,local_id));`);
    db.prepare('INSERT OR IGNORE INTO availability_migration VALUES(1,?,0,?)').run(Phase.Hashes, usageExists ? 0 : 1);
    const migration = db.prepare('SELECT * FROM availability_migration WHERE id=1').get() as { phase: string; row_cursor: number; rebuild_usage: number };
    if (migration.phase === Phase.Ready) {
      if (!usageExists) throw new Error('REMOTE_AVAILABILITY_USAGE_MISSING');
      const triggers = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name IN ('availability_usage_insert','availability_usage_update','availability_usage_delete')").get() as { count: number };
      if (triggers.count !== 3) throw new Error('REMOTE_AVAILABILITY_USAGE_TRIGGERS_MISSING');
      return true;
    }
    if (migration.phase !== Phase.Hashes && migration.phase !== Phase.Usage) throw new Error('REMOTE_AVAILABILITY_MIGRATION_INVALID');
    const headers = db.prepare(`SELECT rowid AS cursor,key,octet_length(body) AS bytes FROM availability_requests
      WHERE rowid>? ORDER BY rowid LIMIT ?`).all(migration.row_cursor, AvailabilityMigration.Rows) as Array<{ cursor: number; key: string; bytes: number }>;
    let bytes = 0, cursor = migration.row_cursor;
    for (const header of headers) {
      if (bytes && bytes + Math.min(header.bytes, AvailabilityMigration.RecordBytes) > AvailabilityMigration.Bytes) break;
      cursor = header.cursor;
      bytes += Math.min(header.bytes, AvailabilityMigration.RecordBytes);
      if (migration.phase === Phase.Hashes) {
        if (header.bytes > AvailabilityMigration.RecordBytes) continue; // Keep unknown original bytes and identity.
        const row = db.prepare('SELECT body,request_hash FROM availability_requests WHERE rowid=?').get(header.cursor) as { body: string; request_hash: string | null };
        if (row.request_hash !== null) continue;
        let saved: unknown, hash: string;
        try {
          saved = JSON.parse(row.body);
          if (!record(saved) || !record(saved.body)) continue;
          hash = payloadHash(saved);
        } catch { continue; } // Pure decode/hash failure belongs to this immutable row; SQL failures do not.
        db.prepare('UPDATE availability_requests SET object_id=?,object_kind=?,request_hash=? WHERE rowid=? AND request_hash IS NULL')
          .run(identifier(saved.body.objectId) ? saved.body.objectId : null,
            ['message', 'tool'].includes(saved.body.objectKind) ? saved.body.objectKind : null, hash, header.cursor);
      } else {
        // Aggregate a single row in SQLite; never return its potentially oversized body to JavaScript.
        db.prepare(`INSERT INTO availability_usage
          SELECT lane,scope,local_id,
            CASE WHEN resolution_receipt IS NULL THEN octet_length(body)+COALESCE(length(CAST(resolution_body AS BLOB)),0) ELSE 0 END,
            CASE WHEN resolution_receipt IS NULL THEN 0 ELSE octet_length(body)+COALESCE(length(CAST(resolution_body AS BLOB)),0)+length(CAST(resolution_receipt AS BLOB)) END,
            CASE WHEN resolution_receipt IS NULL THEN ? ELSE 0 END FROM availability_requests WHERE rowid=?
          ON CONFLICT(lane,scope,local_id) DO UPDATE SET active_bytes=active_bytes+excluded.active_bytes,
            archive_bytes=archive_bytes+excluded.archive_bytes,reserved_bytes=reserved_bytes+excluded.reserved_bytes`).run(receiptReserve, header.cursor);
      }
    }
    db.prepare('UPDATE availability_migration SET row_cursor=? WHERE id=1').run(cursor);
    if (headers.length) return false;
    if (migration.phase === Phase.Hashes && migration.rebuild_usage) {
      db.prepare('UPDATE availability_migration SET phase=?,row_cursor=0 WHERE id=1').run(Phase.Usage);
      // A fresh empty ledger is immediately usable; old ledgers advance on a later turn.
      if (db.prepare('SELECT 1 FROM availability_requests LIMIT 1').get()) return false;
    }
    const usage = (alias: string): string[] => {
      const size = `length(CAST(${alias}.body AS BLOB))+COALESCE(length(CAST(${alias}.resolution_body AS BLOB)),0)`;
      return [`CASE WHEN ${alias}.resolution_receipt IS NULL THEN ${size} ELSE 0 END`,
        `CASE WHEN ${alias}.resolution_receipt IS NULL THEN 0 ELSE ${size}+length(CAST(${alias}.resolution_receipt AS BLOB)) END`,
        `CASE WHEN ${alias}.resolution_receipt IS NULL THEN ${receiptReserve} ELSE 0 END`];
    };
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const subtract = event === 'INSERT' ? '' : `UPDATE availability_usage SET ${['active_bytes', 'archive_bytes', 'reserved_bytes']
        .map((column, index) => `${column}=${column}-(${usage('OLD')[index]})`).join(',')} WHERE lane=OLD.lane AND scope=OLD.scope AND local_id=OLD.local_id;`;
      const add = event === 'DELETE' ? '' : `INSERT INTO availability_usage VALUES(NEW.lane,NEW.scope,NEW.local_id,${usage('NEW').join(',')})
        ON CONFLICT(lane,scope,local_id) DO UPDATE SET active_bytes=active_bytes+excluded.active_bytes,
          archive_bytes=archive_bytes+excluded.archive_bytes,reserved_bytes=reserved_bytes+excluded.reserved_bytes;`;
      db.exec(`CREATE TRIGGER IF NOT EXISTS availability_usage_${event.toLowerCase()} AFTER ${event} ON availability_requests BEGIN ${subtract}${add} END;`);
    }
    db.prepare('UPDATE availability_migration SET phase=? WHERE id=1').run(Phase.Ready);
    return true;
  })();
}
