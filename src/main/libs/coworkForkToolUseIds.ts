import type Database from 'better-sqlite3';
import crypto from 'crypto';

const FORK_TOOL_USE_ID_PREFIX = 'fork_';
const FORK_TOOL_USE_ID_HASH_LENGTH = 24;

/**
 * Tool call id for a message copied into a fork. The renderer pairs each tool_result
 * with its tool_use by this id (parallel calls land as use, use, result, result), so a
 * fork must keep the pairs intact. Deriving it from the fork's id keeps one source id
 * mapped to one new id within the fork, and keeps copied rows from colliding with the
 * calls the fork's own OpenClaw session makes later (some providers number calls from
 * zero in every transcript).
 */
export const deriveForkToolUseId = (forkSessionId: string, sourceToolUseId: string): string => {
  const digest = crypto
    .createHash('sha256')
    .update(`${forkSessionId}\n${sourceToolUseId}`)
    .digest('hex');
  return `${FORK_TOOL_USE_ID_PREFIX}${digest.slice(0, FORK_TOOL_USE_ID_HASH_LENGTH)}`;
};

interface ForkSessionRow {
  id: string;
  parent_session_id: string;
  fork_boundary: number;
}

interface ForkToolMessageRow {
  id: string;
  type: string;
  sequence: number | null;
  created_at: number;
}

interface SourceToolMessageRow {
  type: string;
  sequence: number | null;
  created_at: number;
  tool_use_id: unknown;
}

const getToolMessageKey = (row: { type: string; sequence: number | null; created_at: number }): string =>
  `${row.type}\u0000${row.sequence ?? ''}\u0000${row.created_at}`;

const hasColumns = (db: Database.Database, table: string, columns: string[]): boolean => {
  const names = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name),
  );
  return columns.every(column => names.has(column));
};

/**
 * Forks used to drop toolUseId from copied messages. A fork copies each message's type,
 * sequence and created_at unchanged, so the copy of a tool row is found again in the
 * parent session by those three values. Forks are repaired oldest first, so a fork of a
 * fork reads ids its parent already got back. Rows without exactly one match in the
 * parent (parent deleted, row edited away, ambiguous legacy rows) stay as they are.
 *
 * Returns the number of messages updated.
 */
export const repairForkedSessionToolUseIds = (db: Database.Database): number => {
  // Forking writes these columns, so a database without them holds no forks to repair.
  if (
    !hasColumns(db, 'cowork_sessions', ['parent_session_id', 'forked_at'])
    || !hasColumns(db, 'cowork_messages', ['sequence'])
  ) {
    return 0;
  }

  const forks = db.prepare(`
    SELECT id, parent_session_id, COALESCE(forked_at, created_at) AS fork_boundary
    FROM cowork_sessions
    WHERE parent_session_id IS NOT NULL AND parent_session_id != id
    ORDER BY COALESCE(forked_at, created_at) ASC, created_at ASC, ROWID ASC
  `).all() as ForkSessionRow[];
  if (forks.length === 0) return 0;

  const selectMissing = db.prepare(`
    SELECT id, type, sequence, created_at
    FROM cowork_messages
    WHERE session_id = ?
      AND type IN ('tool_use', 'tool_result')
      AND created_at <= ?
      AND (
        metadata IS NULL
        OR CASE
          WHEN json_valid(metadata) THEN COALESCE(json_extract(metadata, '$.toolUseId'), '') = ''
          ELSE 0
        END
      )
  `);
  const selectSource = db.prepare(`
    SELECT type, sequence, created_at,
      CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.toolUseId') END AS tool_use_id
    FROM cowork_messages
    WHERE session_id = ?
      AND type IN ('tool_use', 'tool_result')
      AND created_at <= ?
      AND metadata IS NOT NULL
  `);
  const updateToolUseId = db.prepare(`
    UPDATE cowork_messages
    SET metadata = CASE
      WHEN metadata IS NULL THEN json_object('toolUseId', @toolUseId)
      ELSE json_set(metadata, '$.toolUseId', @toolUseId)
    END
    WHERE id = @id AND session_id = @sessionId
  `);

  const repair = db.transaction((): number => {
    let repaired = 0;
    for (const fork of forks) {
      const missing = selectMissing.all(fork.id, fork.fork_boundary) as ForkToolMessageRow[];
      if (missing.length === 0) continue;

      // null marks a key shared by rows with different ids: too ambiguous to restore.
      const sourceIdsByKey = new Map<string, string | null>();
      const sourceRows = selectSource.all(fork.parent_session_id, fork.fork_boundary) as SourceToolMessageRow[];
      for (const row of sourceRows) {
        if (typeof row.tool_use_id !== 'string' || !row.tool_use_id.trim()) continue;
        const key = getToolMessageKey(row);
        const existing = sourceIdsByKey.get(key);
        if (existing === undefined) {
          sourceIdsByKey.set(key, row.tool_use_id);
        } else if (existing !== row.tool_use_id) {
          sourceIdsByKey.set(key, null);
        }
      }
      if (sourceIdsByKey.size === 0) continue;

      for (const row of missing) {
        const sourceToolUseId = sourceIdsByKey.get(getToolMessageKey(row));
        if (!sourceToolUseId) continue;
        updateToolUseId.run({
          toolUseId: deriveForkToolUseId(fork.id, sourceToolUseId),
          id: row.id,
          sessionId: fork.id,
        });
        repaired++;
      }
    }
    return repaired;
  });

  return repair();
};
