import Database from 'better-sqlite3';

export interface SubagentMessage {
  id: string;
  runId: string;
  type: string;
  content: string;
  metadata: string | null;
  createdAt: number;
  sequence: number;
}

export class SubagentMessageStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Batch-insert messages for a subagent run.
   * Uses a transaction for performance on larger message lists.
   */
  insertMessages(runId: string, messages: Array<{
    id: string;
    type: string;
    content: string;
    metadata?: Record<string, unknown> | null;
    timestamp: number;
    sequence: number;
  }>): void {
    if (messages.length === 0) return;

    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO subagent_messages (id, run_id, type, content, metadata, created_at, sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertAll = this.db.transaction(() => {
      for (const msg of messages) {
        stmt.run(
          msg.id,
          runId,
          msg.type,
          msg.content,
          msg.metadata ? JSON.stringify(msg.metadata) : null,
          msg.timestamp,
          msg.sequence,
        );
      }
    });
    insertAll();
  }

  /**
   * Read all messages for a subagent run, ordered by sequence.
   */
  getMessages(runId: string): SubagentMessage[] {
    return this.db
      .prepare(`
        SELECT
          id,
          run_id AS runId,
          type,
          content,
          metadata,
          created_at AS createdAt,
          sequence
        FROM subagent_messages
        WHERE run_id = ?
        ORDER BY sequence ASC
      `)
      .all(runId) as SubagentMessage[];
  }

  /**
   * Check if messages exist for a given run.
   */
  hasMessages(runId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM subagent_messages WHERE run_id = ? LIMIT 1')
      .get(runId);
    return row !== undefined;
  }

  /**
   * Delete messages for specific runs (used when parent session is deleted).
   */
  deleteByRunIds(runIds: string[]): void {
    if (runIds.length === 0) return;
    const placeholders = runIds.map(() => '?').join(',');
    this.db
      .prepare(`DELETE FROM subagent_messages WHERE run_id IN (${placeholders})`)
      .run(...runIds);
  }

  /**
   * Delete all messages belonging to subagent runs of a parent session.
   */
  deleteByParentSession(parentSessionId: string): void {
    this.db
      .prepare(
        `DELETE FROM subagent_messages WHERE run_id IN
         (SELECT id FROM subagent_runs WHERE parent_session_id = ?)`,
      )
      .run(parentSessionId);
  }
}
