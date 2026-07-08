import Database from 'better-sqlite3';

export type SubagentRunStatus = 'running' | 'done' | 'error';

export interface SubagentRun {
  id: string;
  parentSessionId: string;
  sessionKey: string | null;
  agentId: string | null;
  task: string | null;
  label: string | null;
  status: SubagentRunStatus;
  createdAt: number;
  endedAt: number | null;
}

export class SubagentRunStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  insertSubagentRun(run: Omit<SubagentRun, 'endedAt'> & { endedAt?: number | null }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO subagent_runs (id, parent_session_id, session_key, agent_id, task, label, status, created_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.parentSessionId,
        run.sessionKey ?? null,
        run.agentId ?? null,
        run.task ?? null,
        run.label ?? null,
        run.status,
        run.createdAt,
        run.endedAt ?? null,
      );
  }

  updateSubagentRunStatus(id: string, status: SubagentRunStatus, endedAt?: number): void {
    if (endedAt != null) {
      this.db.prepare('UPDATE subagent_runs SET status = ?, ended_at = ? WHERE id = ?')
        .run(status, endedAt, id);
    } else {
      this.db.prepare('UPDATE subagent_runs SET status = ? WHERE id = ?')
        .run(status, id);
    }
  }

  updateSubagentRunSessionKey(id: string, sessionKey: string): void {
    this.db.prepare('UPDATE subagent_runs SET session_key = ? WHERE id = ?')
      .run(sessionKey, id);
  }

  listSubagentRuns(parentSessionId: string): SubagentRun[] {
    interface Row {
      id: string;
      parent_session_id: string;
      session_key: string | null;
      agent_id: string | null;
      task: string | null;
      label: string | null;
      status: string;
      created_at: number;
      ended_at: number | null;
    }

    const rows = this.db
      .prepare(`SELECT * FROM subagent_runs WHERE parent_session_id = ? ORDER BY created_at ASC`)
      .all(parentSessionId) as Row[];

    return rows.map((row) => ({
      id: row.id,
      parentSessionId: row.parent_session_id,
      sessionKey: row.session_key,
      agentId: row.agent_id,
      task: row.task,
      label: row.label,
      status: row.status as SubagentRunStatus,
      createdAt: row.created_at,
      endedAt: row.ended_at,
    }));
  }

  getSubagentRun(id: string): SubagentRun | null {
    interface Row {
      id: string;
      parent_session_id: string;
      session_key: string | null;
      agent_id: string | null;
      task: string | null;
      label: string | null;
      status: string;
      created_at: number;
      ended_at: number | null;
    }

    const row = this.db
      .prepare('SELECT * FROM subagent_runs WHERE id = ?')
      .get(id) as Row | undefined;

    if (!row) return null;

    return {
      id: row.id,
      parentSessionId: row.parent_session_id,
      sessionKey: row.session_key,
      agentId: row.agent_id,
      task: row.task,
      label: row.label,
      status: row.status as SubagentRunStatus,
      createdAt: row.created_at,
      endedAt: row.ended_at,
    };
  }

  markMessagesPersisted(id: string): void {
    this.db.prepare('UPDATE subagent_runs SET messages_persisted = 1 WHERE id = ?')
      .run(id);
  }

  isMessagesPersisted(id: string): boolean {
    const row = this.db
      .prepare('SELECT messages_persisted FROM subagent_runs WHERE id = ?')
      .get(id) as { messages_persisted: number } | undefined;
    return row?.messages_persisted === 1;
  }

  getRunStatus(id: string): SubagentRunStatus | null {
    const row = this.db
      .prepare('SELECT status FROM subagent_runs WHERE id = ?')
      .get(id) as { status: string } | undefined;
    return (row?.status as SubagentRunStatus) ?? null;
  }

  deleteSubagentRunsByParent(parentSessionId: string): void {
    this.db.prepare('DELETE FROM subagent_runs WHERE parent_session_id = ?')
      .run(parentSessionId);
  }

  deleteSubagentRun(id: string): void {
    this.db.prepare('DELETE FROM subagent_runs WHERE id = ?')
      .run(id);
  }
}
