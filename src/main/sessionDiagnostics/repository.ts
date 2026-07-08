import type Database from 'better-sqlite3';

import type {
  CoworkSessionDiagnosticsAgentSnapshot,
  CoworkSessionDiagnosticsCapsuleRow,
  CoworkSessionDiagnosticsData,
  CoworkSessionDiagnosticsMessageRow,
  CoworkSessionDiagnosticsSessionRow,
} from './types';

interface DiagnosticsAgentRow {
  id: string;
  name: string;
  model: string;
  source: string;
  preset_id: string;
  is_default: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

const mapAgentSnapshot = (
  row: DiagnosticsAgentRow | undefined,
): CoworkSessionDiagnosticsAgentSnapshot | null => (
  row
    ? {
      id: row.id,
      name: row.name,
      model: row.model,
      source: row.source,
      presetId: row.preset_id,
      isDefault: Boolean(row.is_default),
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    : null
);

export function readSessionDiagnosticsData(
  db: Database.Database,
  sessionId: string,
): CoworkSessionDiagnosticsData | null {
  const readSnapshot = db.transaction((): CoworkSessionDiagnosticsData | null => {
    const session = db.prepare(`
      SELECT
        id, title, claude_session_id, status, pinned, pin_order, cwd, system_prompt,
        model_override, execution_mode, parent_session_id, forked_from_message_id,
        forked_at, fork_mode, fork_workspace_path, fork_git_branch, fork_git_base_ref,
        goal_json, active_skill_ids, agent_id, created_at, updated_at
      FROM cowork_sessions
      WHERE id = ?
    `).get(sessionId) as CoworkSessionDiagnosticsSessionRow | undefined;
    if (!session) return null;

    const messages = db.prepare(`
      SELECT id, session_id, type, content, metadata, created_at, sequence
      FROM cowork_messages
      WHERE session_id = ?
      ORDER BY COALESCE(sequence, created_at) ASC, created_at ASC, ROWID ASC
    `).all(sessionId) as CoworkSessionDiagnosticsMessageRow[];

    const capsule = db.prepare(`
      SELECT session_id, version, revision, capsule_json, updated_at, last_source, last_compacted_at
      FROM cowork_session_capsules
      WHERE session_id = ?
    `).get(sessionId) as CoworkSessionDiagnosticsCapsuleRow | undefined;

    const agentId = session.agent_id || 'main';
    const agent = db.prepare(`
      SELECT id, name, model, source, preset_id, is_default, enabled, created_at, updated_at
      FROM agents
      WHERE id = ?
    `).get(agentId) as DiagnosticsAgentRow | undefined;

    return {
      session,
      messages,
      capsule: capsule ?? null,
      agent: mapAgentSnapshot(agent),
    };
  });

  return readSnapshot();
}
