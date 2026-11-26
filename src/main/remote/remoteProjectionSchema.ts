import type Database from 'better-sqlite3';

/** Optional history materializations. Core identity and execution tables are initialized separately. */
export function initializeRemoteProjectionSchema(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS remote_projection_publications(session_id TEXT PRIMARY KEY,path TEXT NOT NULL,source_seq INTEGER NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_projection_failures(session_id TEXT PRIMARY KEY,reason TEXT NOT NULL,retry_at INTEGER NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_object_state(session_id TEXT NOT NULL,object_key TEXT NOT NULL,revision INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(session_id,object_key));
      CREATE TABLE IF NOT EXISTS remote_dirty (session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS remote_content_dirty (session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS remote_outbox (
        session_id TEXT NOT NULL, source_seq INTEGER NOT NULL, event_json TEXT NOT NULL,
        PRIMARY KEY(session_id,source_seq));
      CREATE TABLE IF NOT EXISTS remote_projection (
        session_id TEXT NOT NULL, object_key TEXT NOT NULL, hash TEXT NOT NULL,
        revision INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(session_id,object_key));
      CREATE TABLE IF NOT EXISTS remote_reply_contents (session_id TEXT NOT NULL, content_id TEXT NOT NULL, version INTEGER NOT NULL,
        message_id TEXT NOT NULL, block_id TEXT NOT NULL, format TEXT NOT NULL, sha256 TEXT NOT NULL, chunks_json TEXT NOT NULL, size_bytes INTEGER NOT NULL,
        PRIMARY KEY(session_id,content_id,version));
      CREATE TABLE IF NOT EXISTS remote_reply_chunks(session_id TEXT NOT NULL, sha256 TEXT NOT NULL, content TEXT NOT NULL, size_bytes INTEGER NOT NULL, PRIMARY KEY(session_id,sha256));
      CREATE TABLE IF NOT EXISTS remote_projection_scan(session_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
  `);
    // SQLite IF NOT EXISTS also accepts a view collision; never treat that as a usable materialization.
    for (const name of ['remote_projection_publications', 'remote_projection_failures', 'remote_object_state',
      'remote_dirty', 'remote_content_dirty', 'remote_outbox', 'remote_projection', 'remote_reply_contents',
      'remote_reply_chunks', 'remote_projection_scan']) {
      const row = db.prepare('SELECT type FROM sqlite_master WHERE name=?').get(name) as { type: string } | undefined;
      if (row?.type !== 'table') throw new Error('REMOTE_PROJECTION_SCHEMA_INVALID');
    }
  })();
}
