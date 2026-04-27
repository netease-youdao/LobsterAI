import Database from 'better-sqlite3';
import crypto from 'crypto';
import { app } from 'electron';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import { DB_FILENAME } from './appConstants';
import {
  openSqliteDatabaseWithRecovery,
  SqliteBackupManager,
} from './libs/sqliteBackup/sqliteBackupManager';

type ChangePayload<T = unknown> = {
  key: string;
  newValue: T | undefined;
  oldValue: T | undefined;
};

const USER_MEMORIES_MIGRATION_KEY = 'userMemories.migration.v1.completed';

export class SqliteStore {
  private db: Database.Database;
  private dbPath: string;
  private emitter = new EventEmitter();
  private didRunMigration = false;

  private constructor(db: Database.Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static async create(userDataPath?: string): Promise<SqliteStore> {
    const basePath = userDataPath ?? app.getPath('userData');
    const dbPath = path.join(basePath, DB_FILENAME);

    let db = openSqliteDatabaseWithRecovery(basePath, dbPath);

    const autoBackupEnabled = SqliteStore.readSqliteAutoBackupEnabled(db);
    if (autoBackupEnabled) {
      const backupManager = new SqliteBackupManager(basePath);
      const health = backupManager.verifyDatabaseHealth(db);
      if (!health.ok) {
        const healthReason = 'reason' in health ? health.reason : 'unknown reason';
        console.warn(`[SqliteBackup] Startup health check failed: ${healthReason}`);
        try {
          db.close();
        } catch {
          // Ignore close failures before restore.
        }
        const restoreResult = backupManager.restoreLatestBackup(dbPath);
        if (!restoreResult.restored) {
          console.warn('[SqliteBackup] No valid snapshot was restored; continuing with database reinitialization');
        }
        db = openSqliteDatabaseWithRecovery(basePath, dbPath);
      }
    }

    const store = new SqliteStore(db, dbPath);
    store.initializeTables(basePath);
    return store;
  }

  private initializeTables(basePath: string) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Create cowork tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        claude_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        pinned INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        model_override TEXT NOT NULL DEFAULT '',
        execution_mode TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cowork_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        sequence INTEGER,
        FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cowork_messages_session_id ON cowork_messages(session_id);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cowork_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.75,
        is_explicit INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'created',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_memory_sources (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        session_id TEXT,
        message_id TEXT,
        role TEXT NOT NULL DEFAULT 'system',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES user_memories(id) ON DELETE CASCADE
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_user_memories_status_updated_at
      ON user_memories(status, updated_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_user_memories_fingerprint
      ON user_memories(fingerprint);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_user_memory_sources_session_id
      ON user_memory_sources(session_id, is_active);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_user_memory_sources_memory_id
      ON user_memory_sources(memory_id, is_active);
    `);

    // Create agents table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        identity TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL DEFAULT '',
        skill_ids TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'custom',
        preset_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Create MCP servers table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        transport_type TEXT NOT NULL DEFAULT 'stdio',
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Migrations - safely add columns if they don't exist
    try {
      // Check if execution_mode column exists
      const columns = this.db.pragma('table_info(cowork_sessions)') as Array<{ name: string }>;
      const colNames = columns.map((c) => c.name);

      if (!colNames.includes('execution_mode')) {
        this.db.exec('ALTER TABLE cowork_sessions ADD COLUMN execution_mode TEXT;');
        this.didRunMigration = true;
      }

      if (!colNames.includes('pinned')) {
        this.db.exec('ALTER TABLE cowork_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;');
        this.didRunMigration = true;
      }

      if (!colNames.includes('active_skill_ids')) {
        this.db.exec('ALTER TABLE cowork_sessions ADD COLUMN active_skill_ids TEXT;');
        this.didRunMigration = true;
      }

      if (!colNames.includes('model_override')) {
        this.db.exec("ALTER TABLE cowork_sessions ADD COLUMN model_override TEXT NOT NULL DEFAULT '';");
        this.didRunMigration = true;
      }

      // Migration: Add sequence column to cowork_messages
      const msgColumns = this.db.pragma('table_info(cowork_messages)') as Array<{ name: string }>;
      const msgColNames = msgColumns.map(c => c.name);

      if (!msgColNames.includes('sequence')) {
        this.db.exec('ALTER TABLE cowork_messages ADD COLUMN sequence INTEGER');
        this.didRunMigration = true;

        // Assign sequence numbers to existing messages ordered by created_at + ROWID
        this.db.exec(`
          WITH numbered AS (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY session_id
              ORDER BY created_at ASC, ROWID ASC
            ) as seq
            FROM cowork_messages
          )
          UPDATE cowork_messages
          SET sequence = (SELECT seq FROM numbered WHERE numbered.id = cowork_messages.id)
        `);
      }
    } catch {
      // Column already exists or migration not needed.
    }

    try {
      this.db.exec('UPDATE cowork_sessions SET pinned = 0 WHERE pinned IS NULL;');
      this.didRunMigration = true;
    } catch {
      // Column might not exist yet.
    }

    // Migration: Add agent_id column to cowork_sessions
    try {
      const sessionCols = this.db.pragma('table_info(cowork_sessions)') as Array<{ name: string }>;
      const sessionColNames = sessionCols.map(c => c.name);
      if (!sessionColNames.includes('agent_id')) {
        this.db.exec(
          "ALTER TABLE cowork_sessions ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main';",
        );
        this.didRunMigration = true;
      }
    } catch {
      // Column already exists or migration not needed.
    }

    // Migration: Ensure default 'main' agent exists
    try {
      const mainAgent = this.db.prepare("SELECT id FROM agents WHERE id = 'main'").get();
      if (!mainAgent) {
        const now = Date.now();
        // Read existing systemPrompt from cowork_config to inherit into main agent
        let existingSystemPrompt = '';
        try {
          const spRow = this.db
            .prepare("SELECT value FROM cowork_config WHERE key = 'systemPrompt'")
            .get() as { value: string } | undefined;
          if (spRow?.value) {
            existingSystemPrompt = spRow.value;
          }
        } catch {
          // No existing systemPrompt
        }
        this.db
          .prepare(
            `
          INSERT INTO agents (id, name, description, system_prompt, identity, model, icon, skill_ids, enabled, is_default, source, preset_id, created_at, updated_at)
          VALUES ('main', 'main', '', ?, '', '', '', '[]', 1, 1, 'custom', '', ?, ?)
        `,
          )
          .run(existingSystemPrompt, now, now);
      }
    } catch (error) {
      console.warn('Failed to ensure main agent:', error);
    }

    try {
      this.db.exec(
        `UPDATE cowork_sessions SET execution_mode = 'local' WHERE execution_mode = 'container';`,
      );
      this.db.exec(`
        UPDATE cowork_config
        SET value = 'local'
        WHERE key = 'executionMode' AND value = 'container';
      `);
      this.didRunMigration = true;
    } catch (error) {
      console.warn('Failed to migrate cowork execution mode:', error);
    }

    this.migrateLegacyMemoryFileToUserMemories();
    this.migrateFromElectronStore(basePath);
  }

  onDidChange<T = unknown>(
    key: string,
    callback: (newValue: T | undefined, oldValue: T | undefined) => void,
  ) {
    const handler = (payload: ChangePayload<T>) => {
      if (payload.key !== key) return;
      callback(payload.newValue, payload.oldValue);
    };
    this.emitter.on('change', handler);
    return () => this.emitter.off('change', handler);
  }

  get<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch (error) {
      console.warn(`Failed to parse store value for ${key}`, error);
      return undefined;
    }
  }

  set<T = unknown>(key: string, value: T): void {
    const oldValue = this.get<T>(key);
    const now = Date.now();
    this.db
      .prepare(
        `
      INSERT INTO kv (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `,
      )
      .run(key, JSON.stringify(value), now);
    this.emitter.emit('change', { key, newValue: value, oldValue } as ChangePayload<T>);
  }

  delete(key: string): void {
    const oldValue = this.get(key);
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
    this.emitter.emit('change', { key, newValue: undefined, oldValue } as ChangePayload);
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  getDbPath(): string {
    return this.dbPath;
  }

  getDidRunMigration(): boolean {
    return this.didRunMigration;
  }

  close(): void {
    this.db.close();
  }

  private static readSqliteAutoBackupEnabled(db: Database.Database): boolean {
    try {
      const row = db.prepare("SELECT value FROM kv WHERE key = 'app_config'").get() as
        | { value: string }
        | undefined;
      if (!row?.value) return false;
      const parsed = JSON.parse(row.value) as { sqliteAutoBackupEnabled?: boolean };
      return parsed.sqliteAutoBackupEnabled === true;
    } catch {
      return false;
    }
  }

  private tryReadLegacyMemoryText(): string {
    const candidates = [
      path.join(process.cwd(), 'MEMORY.md'),
      path.join(app.getAppPath(), 'MEMORY.md'),
      path.join(process.cwd(), 'memory.md'),
      path.join(app.getAppPath(), 'memory.md'),
    ];

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return fs.readFileSync(candidate, 'utf8');
        }
      } catch {
        // Skip unreadable candidates.
      }
    }
    return '';
  }

  private parseLegacyMemoryEntries(raw: string): string[] {
    const normalized = raw.replace(/```[\s\S]*?```/g, ' ');
    const lines = normalized.split(/\r?\n/);
    const entries: string[] = [];
    const seen = new Set<string>();

    for (const line of lines) {
      const match = line.trim().match(/^-+\s*(?:\[[^\]]+\]\s*)?(.+)$/);
      if (!match?.[1]) continue;
      const text = match[1].replace(/\s+/g, ' ').trim();
      if (!text || text.length < 6) continue;
      if (/^\(empty\)$/i.test(text)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(text.length > 360 ? `${text.slice(0, 359)}…` : text);
    }

    return entries.slice(0, 200);
  }

  private memoryFingerprint(text: string): string {
    const normalized = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return crypto.createHash('sha1').update(normalized).digest('hex');
  }

  private migrateLegacyMemoryFileToUserMemories(): void {
    if (this.get<string>(USER_MEMORIES_MIGRATION_KEY) === '1') {
      return;
    }

    const content = this.tryReadLegacyMemoryText();
    if (!content.trim()) {
      this.set(USER_MEMORIES_MIGRATION_KEY, '1');
      return;
    }

    const entries = this.parseLegacyMemoryEntries(content);
    if (entries.length === 0) {
      this.set(USER_MEMORIES_MIGRATION_KEY, '1');
      return;
    }

    const now = Date.now();
    const insertMemory = this.db.prepare(`
      INSERT INTO user_memories (
        id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, 1, 'created', ?, ?, NULL)
    `);
    const insertSource = this.db.prepare(`
      INSERT INTO user_memory_sources (id, memory_id, session_id, message_id, role, is_active, created_at)
      VALUES (?, ?, NULL, NULL, 'system', 1, ?)
    `);
    const checkExisting = this.db.prepare(
      `SELECT id FROM user_memories WHERE fingerprint = ? AND status != 'deleted' LIMIT 1`,
    );

    const migrate = this.db.transaction(() => {
      for (const text of entries) {
        const fingerprint = this.memoryFingerprint(text);
        if (checkExisting.get(fingerprint)) continue;

        const memoryId = crypto.randomUUID();
        insertMemory.run(memoryId, text, fingerprint, 0.9, now, now);
        insertSource.run(crypto.randomUUID(), memoryId, now);
      }
    });

    try {
      migrate();
    } catch (error) {
      console.warn('Failed to migrate legacy MEMORY.md entries:', error);
    }

    this.set(USER_MEMORIES_MIGRATION_KEY, '1');
  }

  private migrateFromElectronStore(userDataPath: string) {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM kv').get() as { count: number };
    if (row.count > 0) return;

    const legacyPath = path.join(userDataPath, 'config.json');
    if (!fs.existsSync(legacyPath)) return;

    try {
      const raw = fs.readFileSync(legacyPath, 'utf8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (!data || typeof data !== 'object') return;

      const entries = Object.entries(data);
      if (!entries.length) return;

      const now = Date.now();
      const insert = this.db.prepare(`
        INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
      `);
      const migrate = this.db.transaction(() => {
        for (const [key, value] of entries) {
          insert.run(key, JSON.stringify(value), now);
        }
      });

      migrate();
      console.info(`Migrated ${entries.length} entries from electron-store.`);
    } catch (error) {
      console.warn('Failed to migrate electron-store data:', error);
    }
  }
}
