import type Database from 'better-sqlite3';

import { AgentId } from '../../shared/agent/constants';

// Original sessions remain addressable by run history, forks and artifact links.
export const UNFOLDED_SCHEDULED_SESSION_SQL = `NOT EXISTS (
  SELECT 1 FROM cowork_scheduled_session_archives a WHERE a.session_id = s.id
)`;

export function foldScheduledSessions(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cowork_scheduled_session_archives (
    session_id TEXT PRIMARY KEY REFERENCES cowork_sessions(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL
  )`);

  db.transaction(() => {
    const duplicates = db.prepare(`
      WITH ranked AS (
        SELECT s.id, s.created_at, FIRST_VALUE(s.id) OVER (
          PARTITION BY s.scheduled_task_id, COALESCE(NULLIF(TRIM(s.agent_id), ''), '${AgentId.Main}')
          ORDER BY s.created_at DESC, s.id DESC
        ) AS conversation_id
        FROM cowork_sessions s
        WHERE s.scheduled_task_id IS NOT NULL AND TRIM(s.scheduled_task_id) != ''
          AND s.parent_session_id IS NULL AND ${UNFOLDED_SCHEDULED_SESSION_SQL}
      )
      SELECT id, conversation_id FROM ranked WHERE id != conversation_id
      ORDER BY created_at DESC, id DESC
    `).all() as { id: string; conversation_id: string }[];
    if (!duplicates.length) return;

    // Prepend newest archive first. Negative sequences leave the retained
    // conversation's existing message order, edit boundaries and IDs intact.
    const prepend = db.prepare(`
      WITH head AS (
        SELECT COALESCE(MIN(COALESCE(sequence, created_at)), 1) AS first
        FROM cowork_messages WHERE session_id = @conversation_id
      )
      INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
      SELECT lower(hex(randomblob(16))), @conversation_id, type, content,
        CASE WHEN json_valid(metadata) AND json_type(metadata, '$.llmTrace.traceId') = 'text'
          THEN json_set(metadata, '$.llmTrace.usageContext.sessionId', @id)
          ELSE metadata END,
        created_at, head.first - ROW_NUMBER() OVER (
          ORDER BY COALESCE(sequence, created_at) DESC, created_at DESC, cowork_messages.ROWID DESC
        )
      FROM cowork_messages, head WHERE session_id = @id
    `);
    const archive = db.prepare(`INSERT INTO cowork_scheduled_session_archives (session_id, conversation_id)
      VALUES (@id, @conversation_id)`);
    const carryPin = db.prepare(`UPDATE cowork_sessions SET pinned = 1,
      pin_order = (SELECT pin_order FROM cowork_sessions WHERE id = @id)
      WHERE id = @conversation_id AND pinned = 0 AND (SELECT pinned FROM cowork_sessions WHERE id = @id) = 1`);
    for (const pair of duplicates) {
      prepend.run(pair);
      carryPin.run(pair);
      archive.run(pair);
    }
  }).immediate();
}
