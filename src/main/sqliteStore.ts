import Database from 'better-sqlite3';
import crypto from 'crypto';
import { app } from 'electron';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import { AgentId, DefaultAgentAvatarIcon, DefaultAgentProfile, LegacyAgentName, normalizeAgentAvatarIcon } from '../shared/agent';
import {
  OpenClawCronRunMetadataKey,
  parseOpenClawCronSessionKey,
} from '../shared/cowork/openclawCronSessionKey';
import { DB_FILENAME } from './appConstants';
import { initializeLibraryTables } from './library/libraryMigrations';
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
const AGENT_WORKING_DIRECTORY_BACKFILL_KEY = 'agents.workingDirectoryBackfill.v1.completed';
const SCHEDULED_TASK_SESSION_BACKFILL_KEY = 'coworkSessions.scheduledTaskIdBackfill.v1.completed';
const EXTRACT_SCHEDULED_TASK_ID_SQL_FUNCTION = 'lobster_extract_scheduled_task_id';

const extractScheduledTaskIdFromMessageMetadata = (metadata: unknown): string | null => {
  if (typeof metadata !== 'string' || !metadata) return null;
  try {
    const parsedMetadata = JSON.parse(metadata) as unknown;
    if (!parsedMetadata || typeof parsedMetadata !== 'object' || Array.isArray(parsedMetadata)) {
      return null;
    }
    const sessionKey = (parsedMetadata as Record<string, unknown>)[
      OpenClawCronRunMetadataKey.SessionKey
    ];
    if (typeof sessionKey !== 'string') return null;
    return parseOpenClawCronSessionKey(sessionKey.trim())?.scheduledTaskId ?? null;
  } catch {
    return null;
  }
};

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
        scheduled_task_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        pinned INTEGER NOT NULL DEFAULT 0,
        pin_order INTEGER,
        cwd TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        model_override TEXT NOT NULL DEFAULT '',
        thinking_level TEXT NOT NULL DEFAULT '',
        execution_mode TEXT,
        parent_session_id TEXT,
        forked_from_message_id TEXT,
        forked_at INTEGER,
        fork_mode TEXT NOT NULL DEFAULT 'none',
        fork_workspace_path TEXT,
        fork_git_branch TEXT,
        fork_git_base_ref TEXT,
        goal_json TEXT,
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
      CREATE TABLE IF NOT EXISTS cowork_session_capsules (
        session_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        capsule_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        last_source TEXT NOT NULL,
        last_compacted_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cowork_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    initializeLibraryTables(this.db);

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
        thinking_level TEXT NOT NULL DEFAULT '',
        working_directory TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL DEFAULT '',
        skill_ids TEXT NOT NULL DEFAULT '[]',
        subagent_allow_agent_ids TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        pinned INTEGER NOT NULL DEFAULT 0,
        pin_order INTEGER,
        sort_order INTEGER,
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_launch_resolutions (
        server_id TEXT PRIMARY KEY,
        resolver_kind TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        package_name TEXT,
        requested_version TEXT,
        resolved_version TEXT,
        install_dir TEXT,
        command TEXT,
        args_json TEXT,
        env_json TEXT,
        error TEXT,
        installed_at INTEGER,
        resolved_at INTEGER,
        last_probe_at INTEGER,
        last_probe_status TEXT,
        updated_at INTEGER NOT NULL
      );
    `);

    // Create user plugins table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_plugins (
        plugin_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        spec TEXT NOT NULL,
        registry TEXT,
        version TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        installed_at INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subagent_runs (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        session_key TEXT,
        child_cowork_session_id TEXT,
        agent_id TEXT,
        task TEXT,
        label TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        created_at INTEGER NOT NULL,
        ended_at INTEGER
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent_session_id
      ON subagent_runs(parent_session_id);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_agent_id
      ON subagent_runs(agent_id);
    `);
    // Subagent messages table — stores fetched conversation history locally
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subagent_messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        metadata TEXT,
        created_at INTEGER NOT NULL,
        sequence INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_subagent_messages_run_id
      ON subagent_messages(run_id);
    `);

    // Migration: add messages_persisted column to subagent_runs
    try {
      const subagentCols = this.db.pragma('table_info(subagent_runs)') as Array<{ name: string }>;
      if (!subagentCols.some(c => c.name === 'messages_persisted')) {
        this.db.exec('ALTER TABLE subagent_runs ADD COLUMN messages_persisted INTEGER NOT NULL DEFAULT 0;');
        this.didRunMigration = true;
      }
      if (!subagentCols.some(c => c.name === 'child_cowork_session_id')) {
        this.db.exec('ALTER TABLE subagent_runs ADD COLUMN child_cowork_session_id TEXT;');
        this.didRunMigration = true;
      }
    } catch {
      // Migration not needed
    }

    try {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_subagent_runs_child_cowork_session_id
        ON subagent_runs(child_cowork_session_id);
      `);
    } catch {
      // Migration not needed
    }

    // Migration: add config column to user_plugins
    try {
      const pluginCols = this.db.pragma('table_info(user_plugins)') as Array<{ name: string }>;
      if (!pluginCols.some(c => c.name === 'config')) {
        this.db.exec('ALTER TABLE user_plugins ADD COLUMN config TEXT;');
        this.didRunMigration = true;
      }
    } catch {
      // Migration not needed
    }

    // `thinking_level` is selected by every Cowork session read after this
    // release. Keep this required migration independent from the legacy
    // best-effort block below so an unrelated ALTER failure cannot skip it.
    try {
      const sessionCols = this.db.pragma('table_info(cowork_sessions)') as Array<{ name: string }>;
      if (!sessionCols.some(column => column.name.toLowerCase() === 'thinking_level')) {
        this.db.exec("ALTER TABLE cowork_sessions ADD COLUMN thinking_level TEXT NOT NULL DEFAULT '';");
        this.didRunMigration = true;
        console.log('[SqliteStore] added required cowork_sessions.thinking_level column');
      }
    } catch (error) {
      console.error('[SqliteStore] failed to add cowork_sessions.thinking_level:', error);
      throw error;
    }

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

      if (!colNames.includes('pin_order')) {
        this.db.exec('ALTER TABLE cowork_sessions ADD COLUMN pin_order INTEGER;');
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

      if (!colNames.includes('parent_session_id')) {
        this.db.exec('ALTER TABLE cowork_sessions ADD COLUMN parent_session_id TEXT;');
        this.didRunMigration = true;
      }

      if (!colNames.includes('forked_from_message_id')) {
        this.db.exec('ALTER TABLE cowork_sessions ADD COLUMN forked_from_message_id TEXT;');
        this.didRunMigration = true;
      }

      if (!colNames.includes('forked_at')) {
        this.db.exec('ALTER TABLE cowork_sessions ADD COLUMN forked_at INTEGER;');
        this.didRunMigration = true;
      }

      if (!colNames.includes('fork_mode')) {
        this.db.exec("ALTER TABLE cowork_sessions ADD COLUMN fork_mode TEXT NOT NULL DEFAULT 'none';");
        this.didRunMigration = true;
      }

      if (!colNames.includes('fork_workspace_path')) {
        this.db.exec('ALTER TABLE cowork_sessions ADD COLUMN fork_workspace_path TEXT;');
        this.didRunMigration = true;
      }

      if (!colNames.includes('fork_git_branch')) {
        this.db.exec('ALTER TABLE cowork_sessions ADD COLUMN fork_git_branch TEXT;');
        this.didRunMigration = true;
      }

      if (!colNames.includes('fork_git_base_ref')) {
        this.db.exec('ALTER TABLE cowork_sessions ADD COLUMN fork_git_base_ref TEXT;');
        this.didRunMigration = true;
      }

      if (!colNames.includes('goal_json')) {
        this.db.exec('ALTER TABLE cowork_sessions ADD COLUMN goal_json TEXT;');
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

    // Keep mixed-message pagination (history rail and conversation search)
    // index-backed. This must run after the legacy `sequence` migration above:
    // older installations can still have a cowork_messages table without that
    // column when initializeTables starts.
    try {
      const indexName = 'idx_cowork_messages_session_order';
      const existingIndex = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(indexName);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_cowork_messages_session_order
        ON cowork_messages(session_id, COALESCE(sequence, created_at), created_at);
      `);
      if (!existingIndex) {
        this.didRunMigration = true;
        console.log('[SqliteStore] created cowork message pagination index');
      }
    } catch (error) {
      // Index creation is an optimization; keep startup compatible with a
      // recoverable legacy schema and leave the existing pagination path usable.
      console.warn('[SqliteStore] failed to create cowork message pagination index:', error);
    }

    // This column is required by all Cowork session reads after this release.
    // Keep its migration isolated from unrelated legacy columns so an earlier
    // best-effort migration cannot prevent it from being installed.
    try {
      const sessionCols = this.db.pragma('table_info(cowork_sessions)') as Array<{ name: string }>;
      if (!sessionCols.some(column => column.name === 'scheduled_task_id')) {
        this.db.exec('ALTER TABLE cowork_sessions ADD COLUMN scheduled_task_id TEXT;');
        this.didRunMigration = true;
      }
    } catch (error) {
      console.error('[SqliteStore] failed to add cowork_sessions.scheduled_task_id:', error);
      throw error;
    }

    try {
      const pinnedResult = this.db.prepare('UPDATE cowork_sessions SET pinned = 0 WHERE pinned IS NULL;').run();
      const pinOrderResult = this.db
        .prepare('UPDATE cowork_sessions SET pin_order = updated_at WHERE pinned = 1 AND pin_order IS NULL;')
        .run();
      const unpinnedResult = this.db
        .prepare('UPDATE cowork_sessions SET pin_order = NULL WHERE pinned = 0 AND pin_order IS NOT NULL;')
        .run();
      if (pinnedResult.changes > 0 || pinOrderResult.changes > 0 || unpinnedResult.changes > 0) {
        this.didRunMigration = true;
      }
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

    try {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_cowork_sessions_scheduled_task_id
        ON cowork_sessions(scheduled_task_id, agent_id);
      `);
    } catch (error) {
      // The index improves restart lookup but is not required for correctness.
      console.warn('[SqliteStore] failed to create scheduled task session index:', error);
    }

    // Migration: identify legacy top-level cron sessions from their imported run history.
    // The completion key is written only after a successful transaction so an interrupted
    // migration can safely retry on the next startup.
    try {
      if (this.get<string>(SCHEDULED_TASK_SESSION_BACKFILL_KEY) !== '1') {
        this.db.function(
          EXTRACT_SCHEDULED_TASK_ID_SQL_FUNCTION,
          { deterministic: true },
          extractScheduledTaskIdFromMessageMetadata,
        );
        const backfillScheduledTaskIds = this.db.transaction(() => {
          const result = this.db.prepare(
            `WITH candidate_sessions AS MATERIALIZED (
               SELECT sessions.id AS session_id,
                      (
                        SELECT ${EXTRACT_SCHEDULED_TASK_ID_SQL_FUNCTION}(messages.metadata)
                        FROM cowork_messages AS messages
                        WHERE messages.session_id = sessions.id
                          AND messages.metadata IS NOT NULL
                          AND messages.metadata LIKE ?
                          AND ${EXTRACT_SCHEDULED_TASK_ID_SQL_FUNCTION}(messages.metadata) IS NOT NULL
                        ORDER BY messages.created_at DESC, messages.id DESC
                        LIMIT 1
                      ) AS scheduled_task_id
               FROM cowork_sessions AS sessions
               WHERE sessions.scheduled_task_id IS NULL
                 AND sessions.parent_session_id IS NULL
             )
             UPDATE cowork_sessions AS sessions
             SET scheduled_task_id = candidates.scheduled_task_id
             FROM candidate_sessions AS candidates
             WHERE sessions.id = candidates.session_id
               AND candidates.scheduled_task_id IS NOT NULL`,
          ).run(`%"${OpenClawCronRunMetadataKey.SessionKey}"%`);
          return result.changes;
        });
        const backfilledSessionCount = backfillScheduledTaskIds();
        if (backfilledSessionCount > 0) {
          this.didRunMigration = true;
          console.log(
            `[SqliteStore] backfilled scheduled task ids for ${backfilledSessionCount} legacy sessions.`,
          );
        }
        this.set(SCHEDULED_TASK_SESSION_BACKFILL_KEY, '1');
      }
    } catch (error) {
      console.warn('[SqliteStore] failed to backfill scheduled task session ids:', error);
    }

    // `thinking_level` is also required by all agent reads. Migrate it before
    // optional layout columns so upgrades from partially migrated databases
    // cannot leave the agents table unreadable.
    try {
      const agentCols = this.db.pragma('table_info(agents)') as Array<{ name: string }>;
      if (!agentCols.some(column => column.name.toLowerCase() === 'thinking_level')) {
        this.db.exec("ALTER TABLE agents ADD COLUMN thinking_level TEXT NOT NULL DEFAULT '';");
        this.didRunMigration = true;
        console.log('[SqliteStore] added required agents.thinking_level column');
      }
    } catch (error) {
      console.error('[SqliteStore] failed to add agents.thinking_level:', error);
      throw error;
    }

    // Migration: Add model preference and layout columns to agents
    try {
      const agentCols = this.db.pragma('table_info(agents)') as Array<{ name: string }>;
      const agentColNames = agentCols.map(c => c.name);
      if (!agentColNames.includes('working_directory')) {
        this.db.exec("ALTER TABLE agents ADD COLUMN working_directory TEXT NOT NULL DEFAULT '';");
        this.didRunMigration = true;
      }
      if (!agentColNames.includes('pinned')) {
        this.db.exec('ALTER TABLE agents ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;');
        this.didRunMigration = true;
      }
      if (!agentColNames.includes('pin_order')) {
        this.db.exec('ALTER TABLE agents ADD COLUMN pin_order INTEGER;');
        this.didRunMigration = true;
      }
      if (!agentColNames.includes('sort_order')) {
        this.db.exec('ALTER TABLE agents ADD COLUMN sort_order INTEGER;');
        this.didRunMigration = true;
      }
      if (!agentColNames.includes('subagent_allow_agent_ids')) {
        this.db.exec("ALTER TABLE agents ADD COLUMN subagent_allow_agent_ids TEXT NOT NULL DEFAULT '[]';");
        this.didRunMigration = true;
      }
    } catch {
      // Column already exists or migration not needed.
    }

    try {
      const pinnedAgentResult = this.db.prepare('UPDATE agents SET pinned = 0 WHERE pinned IS NULL;').run();
      const pinOrderAgentResult = this.db
        .prepare('UPDATE agents SET pin_order = updated_at WHERE pinned = 1 AND pin_order IS NULL;')
        .run();
      const unpinnedAgentResult = this.db
        .prepare('UPDATE agents SET pin_order = NULL WHERE pinned = 0 AND pin_order IS NOT NULL;')
        .run();
      if (pinnedAgentResult.changes > 0 || pinOrderAgentResult.changes > 0 || unpinnedAgentResult.changes > 0) {
        this.didRunMigration = true;
      }
    } catch {
      // Columns might not exist yet.
    }

    // Migration: Ensure default agent exists and legacy display values are upgraded.
    try {
      const mainAgent = this.db
        .prepare('SELECT id, name, icon FROM agents WHERE id = ?')
        .get(AgentId.Main) as { id: string; name: string; icon: string } | undefined;
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
          VALUES (?, ?, '', ?, '', '', ?, '[]', 1, 1, 'custom', '', ?, ?)
        `,
          )
          .run(AgentId.Main, DefaultAgentProfile.Name, existingSystemPrompt, DefaultAgentAvatarIcon, now, now);
      } else {
        const normalizedName = mainAgent.name.trim();
        const shouldUpgradeName = !normalizedName || normalizedName.toLowerCase() === LegacyAgentName.Main;
        if (shouldUpgradeName) {
          this.db
            .prepare('UPDATE agents SET name = ?, updated_at = ? WHERE id = ?')
            .run(DefaultAgentProfile.Name, Date.now(), AgentId.Main);
          this.didRunMigration = true;
        }
      }
    } catch (error) {
      console.warn('[SqliteStore] failed to ensure default agent:', error);
    }

    // Migration: Preserve the existing agent display order in the new explicit sort column.
    try {
      const rows = this.db
        .prepare(
          `
          SELECT id
          FROM agents
          WHERE sort_order IS NULL
          ORDER BY is_default DESC, created_at ASC, id ASC
        `,
        )
        .all() as Array<{ id: string }>;

      if (rows.length > 0) {
        const updateSortOrder = this.db.prepare('UPDATE agents SET sort_order = ? WHERE id = ?');
        const backfillSortOrder = this.db.transaction((agents: Array<{ id: string }>) => {
          agents.forEach((agent, index) => {
            updateSortOrder.run(index + 1, agent.id);
          });
        });
        backfillSortOrder(rows);
        this.didRunMigration = true;
      }
    } catch (error) {
      console.warn('[SqliteStore] failed to backfill agent sort order:', error);
    }

    // Migration: Replace legacy text/emoji/designed agent icons with the latest SVG avatar format.
    try {
      const rows = this.db
        .prepare('SELECT id, icon FROM agents')
        .all() as Array<{ id: string; icon: string }>;
      const updates = rows
        .map((row) => ({ id: row.id, icon: normalizeAgentAvatarIcon(row.icon) }))
        .filter((row, index) => row.icon !== rows[index].icon);

      if (updates.length > 0) {
        const now = Date.now();
        const updateIcon = this.db.prepare('UPDATE agents SET icon = ?, updated_at = ? WHERE id = ?');
        const migrateIcons = this.db.transaction((agents: Array<{ id: string; icon: string }>) => {
          for (const agent of agents) {
            updateIcon.run(agent.icon, now, agent.id);
          }
        });
        migrateIcons(updates);
        this.didRunMigration = true;
      }
    } catch (error) {
      console.warn('[SqliteStore] failed to migrate agent avatar icons:', error);
    }

    // Migration: Backfill agent working directories from the legacy global cwd once.
    try {
      if (this.get<string>(AGENT_WORKING_DIRECTORY_BACKFILL_KEY) !== '1') {
        const cwdRow = this.db
          .prepare("SELECT value FROM cowork_config WHERE key = 'workingDirectory'")
          .get() as { value: string } | undefined;
        const legacyWorkingDirectory = cwdRow?.value?.trim() || '';
        if (legacyWorkingDirectory) {
          const result = this.db
            .prepare(
              `UPDATE agents
               SET working_directory = ?, updated_at = ?
               WHERE TRIM(COALESCE(working_directory, '')) = ''`,
            )
            .run(legacyWorkingDirectory, Date.now());
          if (result.changes > 0) {
            this.didRunMigration = true;
          }
        }
        this.set(AGENT_WORKING_DIRECTORY_BACKFILL_KEY, '1');
      }
    } catch (error) {
      console.warn('[SqliteStore] failed to backfill agent working directories:', error);
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
