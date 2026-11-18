import type Database from 'better-sqlite3';

import { type CoworkMessageEditPending,CoworkMessageEditPhase } from '../../shared/cowork/messageEdit';
import type { CoworkMessage } from '../coworkStore';

export interface CoworkMessageEditOperation extends CoworkMessageEditPending {
  sessionId: string;
  sessionKey: string;
  /**
   * Gateway entry the transcript was rewound to. Absent when nothing from the
   * edited message onward reached the gateway, so the edit rewound nothing.
   */
  entryId?: string;
  /** Branch tip to return to; absent only when the gateway transcript was empty. */
  originalLeafId?: string;
  /** Fork point to rewind back to after returning to that tip, when the transcript stopped at one. */
  originalCutEntryId?: string;
  originalTranscriptId?: string;
  runId: string;
  prefixEntryIds: string[];
}

export interface ProjectionMessageRow {
  id: string;
  type: string;
  content: string;
  metadata: string | null;
  created_at: number;
  sequence: number;
}

/** A session's messages from one sequence onward, with the session state that belongs to them. */
export interface ProjectionSnapshot {
  messages: ProjectionMessageRow[];
  capsule: Record<string, unknown> | null;
  status: string;
  updatedAt: number;
}

export function readProjectionSnapshot(db: Database.Database, sessionId: string, fromSequence: number): ProjectionSnapshot {
  const session = db.prepare('SELECT status, updated_at FROM cowork_sessions WHERE id = ?')
    .get(sessionId) as { status: string; updated_at: number };
  return {
    messages: db.prepare(`SELECT id, type, content, metadata, created_at, sequence FROM cowork_messages
      WHERE session_id = ? AND sequence >= ? ORDER BY sequence, ROWID`)
      .all(sessionId, fromSequence) as ProjectionMessageRow[],
    capsule: db.prepare('SELECT * FROM cowork_session_capsules WHERE session_id = ?')
      .get(sessionId) as Record<string, unknown> | undefined ?? null,
    status: session.status,
    updatedAt: session.updated_at,
  };
}

/**
 * Replaces everything from `fromSequence` onward with the snapshot. Run inside
 * a write transaction. `keepUpdatedAt` leaves the session where it sorts today,
 * for a change that is a different view of the conversation rather than new activity.
 */
export function writeProjectionSnapshot(
  db: Database.Database,
  sessionId: string,
  fromSequence: number,
  snapshot: ProjectionSnapshot,
  options: { keepUpdatedAt?: boolean } = {},
): void {
  db.prepare('DELETE FROM cowork_messages WHERE session_id = ? AND sequence >= ?').run(sessionId, fromSequence);
  const insert = db.prepare(`INSERT INTO cowork_messages
    (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const row of snapshot.messages) {
    insert.run(row.id, sessionId, row.type, row.content, row.metadata, row.created_at, row.sequence);
  }
  db.prepare('DELETE FROM cowork_session_capsules WHERE session_id = ?').run(sessionId);
  if (snapshot.capsule) {
    const c = snapshot.capsule;
    db.prepare(`INSERT INTO cowork_session_capsules
      (session_id, version, revision, capsule_json, updated_at, last_source, last_compacted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(c.session_id, c.version, c.revision, c.capsule_json, c.updated_at, c.last_source, c.last_compacted_at);
  }
  if (options.keepUpdatedAt) {
    db.prepare('UPDATE cowork_sessions SET status = ? WHERE id = ?').run(snapshot.status, sessionId);
  } else {
    db.prepare('UPDATE cowork_sessions SET status = ?, updated_at = ? WHERE id = ?')
      .run(snapshot.status, snapshot.updatedAt, sessionId);
  }
}

type EditSnapshot = ProjectionSnapshot;

/** Durable recovery data is independent of the active message projection. */
export class CoworkMessageEditStore {
  constructor(
    private readonly db: Database.Database,
    private readonly write: <T>(sessionId: string, operation: () => T) => T,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS cowork_message_edits (
      operation_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES cowork_sessions(id) ON DELETE CASCADE,
      phase TEXT NOT NULL,
      operation_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cowork_message_edits_session ON cowork_message_edits(session_id);`);
  }

  pending(sessionId: string): CoworkMessageEditOperation | null {
    const row = this.db.prepare(`SELECT operation_json FROM cowork_message_edits
      WHERE session_id = ? AND phase NOT IN (?, ?) LIMIT 1`)
      .get(sessionId, CoworkMessageEditPhase.Committed, CoworkMessageEditPhase.Restored) as { operation_json: string } | undefined;
    return row ? JSON.parse(row.operation_json) as CoworkMessageEditOperation : null;
  }

  prepare(operation: CoworkMessageEditOperation): void {
    this.write(operation.sessionId, () => {
      if (this.pending(operation.sessionId)) throw new Error('A message edit is already pending.');
      const target = this.db.prepare('SELECT sequence, type FROM cowork_messages WHERE session_id = ? AND id = ?')
        .get(operation.sessionId, operation.messageId) as { sequence: number | null; type: string } | undefined;
      if (target?.type !== 'user' || target.sequence == null) throw new Error('Invalid edit boundary.');
      // Legacy mixed ordering cannot be truncated safely using sequence alone.
      const unsequenced = this.db.prepare('SELECT 1 FROM cowork_messages WHERE session_id = ? AND sequence IS NULL LIMIT 1')
        .get(operation.sessionId);
      if (unsequenced) throw new Error('Legacy message ordering cannot be edited safely.');
      const snapshot = readProjectionSnapshot(this.db, operation.sessionId, target.sequence);
      this.db.prepare('INSERT INTO cowork_message_edits VALUES (?, ?, ?, ?, ?)')
        .run(operation.operationId, operation.sessionId, operation.phase, JSON.stringify(operation), JSON.stringify(snapshot));
    });
  }

  /** Drops an edit that never touched either transcript, so it needs no recovery. */
  cancelPrepared(operation: CoworkMessageEditOperation): void {
    this.db.prepare('DELETE FROM cowork_message_edits WHERE operation_id = ? AND phase = ?')
      .run(operation.operationId, CoworkMessageEditPhase.Prepared);
  }

  setPhase(operation: CoworkMessageEditOperation, phase: CoworkMessageEditPhase): void {
    this.db.prepare('UPDATE cowork_message_edits SET phase = ?, operation_json = ? WHERE operation_id = ?')
      .run(phase, JSON.stringify({ ...operation, phase }), operation.operationId);
    operation.phase = phase;
  }

  private snapshot(operation: CoworkMessageEditOperation): EditSnapshot {
    const row = this.db.prepare('SELECT snapshot_json FROM cowork_message_edits WHERE operation_id = ? AND session_id = ?')
      .get(operation.operationId, operation.sessionId) as { snapshot_json: string } | undefined;
    if (!row) throw new Error('Message edit recovery copy is missing.');
    return JSON.parse(row.snapshot_json) as EditSnapshot;
  }

  discardedRequestIds(sessionId: string): string[] {
    const operation = this.pending(sessionId);
    if (!operation) return [];
    return this.snapshot(operation).messages.flatMap(row => {
      const metadata = row.metadata ? JSON.parse(row.metadata) as { openclawRequestId?: string } : {};
      return typeof metadata.openclawRequestId === 'string' ? [metadata.openclawRequestId] : [];
    });
  }

  truncate(operation: CoworkMessageEditOperation): void {
    this.write(operation.sessionId, () => {
      const snapshot = this.snapshot(operation);
      this.db.prepare('DELETE FROM cowork_messages WHERE session_id = ? AND sequence >= ?')
        .run(operation.sessionId, snapshot.messages[0].sequence);
      this.db.prepare('DELETE FROM cowork_session_capsules WHERE session_id = ?').run(operation.sessionId);
      this.db.prepare("UPDATE cowork_sessions SET status = 'idle', updated_at = ? WHERE id = ?")
        .run(Date.now(), operation.sessionId);
      this.setPhase(operation, CoworkMessageEditPhase.Rewound);
    });
  }

  restore(operation: CoworkMessageEditOperation): void {
    this.write(operation.sessionId, () => {
      const snapshot = this.snapshot(operation);
      writeProjectionSnapshot(this.db, operation.sessionId, snapshot.messages[0].sequence, snapshot);
      this.setPhase(operation, CoworkMessageEditPhase.Restored);
    });
  }

  commitRecovered(operation: CoworkMessageEditOperation, reply: CoworkMessage[], entryId: string): void {
    this.write(operation.sessionId, () => {
      const user = this.db.prepare(`SELECT id, sequence, metadata FROM cowork_messages
        WHERE session_id = ? AND type = 'user' AND json_extract(metadata, '$.openclawRequestId') = ?`)
        .get(operation.sessionId, operation.runId) as Pick<ProjectionMessageRow, 'id' | 'sequence' | 'metadata'> | undefined;
      if (!user) throw new Error('Accepted message is missing from the local recovery projection.');
      this.db.prepare('DELETE FROM cowork_messages WHERE session_id = ? AND sequence > ?').run(operation.sessionId, user.sequence);
      this.db.prepare('UPDATE cowork_messages SET metadata = ? WHERE id = ?')
        .run(JSON.stringify({ ...JSON.parse(user.metadata ?? '{}'), openclawEntryId: entryId }), user.id);
      const insert = this.db.prepare(`INSERT INTO cowork_messages
        (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      reply.forEach((message, index) => insert.run(message.id, operation.sessionId, message.type, message.content,
        JSON.stringify({ ...message.metadata, isStreaming: false, isFinal: true }), message.timestamp, user.sequence + index + 1));
      this.db.prepare("UPDATE cowork_sessions SET status = 'completed' WHERE id = ?").run(operation.sessionId);
      this.db.prepare('DELETE FROM cowork_session_capsules WHERE session_id = ?').run(operation.sessionId);
      this.setPhase(operation, CoworkMessageEditPhase.Committed);
    });
  }
}
