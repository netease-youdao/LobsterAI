import type Database from 'better-sqlite3';

export const initializeLibraryTables = (db: Database.Database): void => {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS library_local_artifacts (
        id TEXT PRIMARY KEY,
        path_key TEXT NOT NULL UNIQUE,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        extension TEXT NOT NULL DEFAULT '',
        artifact_type TEXT NOT NULL,
        category TEXT NOT NULL,
        file_identity TEXT,
        client_source_key TEXT,
        size_bytes INTEGER,
        file_mtime_ms INTEGER,
        sort_time_ms INTEGER NOT NULL,
        availability TEXT NOT NULL DEFAULT 'available',
        origin TEXT NOT NULL DEFAULT 'conversation',
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_verified_at INTEGER NOT NULL,
        missing_since INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      DROP INDEX IF EXISTS idx_library_local_visible_updated;
      DROP INDEX IF EXISTS idx_library_local_category_updated;

      CREATE INDEX IF NOT EXISTS idx_library_local_updated
      ON library_local_artifacts(availability, sort_time_ms DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_library_local_category_updated_v2
      ON library_local_artifacts(category, availability, sort_time_ms DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_library_local_client_source
      ON library_local_artifacts(client_source_key);

      CREATE INDEX IF NOT EXISTS idx_library_local_file_identity
      ON library_local_artifacts(file_identity);

      CREATE TABLE IF NOT EXISTS library_artifact_sessions (
        artifact_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        relation_kind TEXT NOT NULL,
        first_related_at INTEGER NOT NULL,
        last_related_at INTEGER NOT NULL,
        last_message_id TEXT,
        session_artifact_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (artifact_id, session_id),
        FOREIGN KEY (artifact_id)
          REFERENCES library_local_artifacts(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id)
          REFERENCES cowork_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_library_rel_session
      ON library_artifact_sessions(session_id, last_related_at DESC);

      CREATE INDEX IF NOT EXISTS idx_library_rel_artifact_latest
      ON library_artifact_sessions(artifact_id, last_related_at DESC, session_id DESC);

      CREATE TABLE IF NOT EXISTS library_favorites (
        owner_scope TEXT NOT NULL,
        item_kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_scope, item_kind, item_id)
      );

      CREATE INDEX IF NOT EXISTS idx_library_favorites_scope_updated
      ON library_favorites(owner_scope, updated_at DESC);

      CREATE TABLE IF NOT EXISTS library_manual_sources (
        path_key TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        added_at INTEGER NOT NULL
      );
    `);
  })();
};
