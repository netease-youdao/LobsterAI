import type Database from 'better-sqlite3';

import { SubagentCollaborationMode } from '../../shared/agent';

interface AgentCollaborationRow {
  id: string;
  subagent_collaboration_mode: string;
  subagent_allow_agent_ids: string;
  subagent_allow_agent_ids_snapshot: string;
}

function readPeerIds(json: string, agentId: string): Set<string> {
  try {
    const value: unknown = JSON.parse(json);
    if (Array.isArray(value)) {
      const selfId = agentId.trim();
      const ids = value.flatMap((item: unknown) => typeof item === 'string' ? [item.trim()] : []);
      return new Set(ids.filter(id => id && id !== selfId));
    }
  } catch {
    // A malformed legacy list contains no reliable selection.
  }
  return new Set();
}

// Remote-connect databases require an app-owned write context for migrations
// that update agents. The caller's transaction covers both the flag and the rows.
function withLegacyAgentWriteContext(db: Database.Database, write: () => void): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_write_context'").get()) {
    return write();
  }
  const trusted = db.prepare('SELECT trusted FROM agent_write_context WHERE id = 1').pluck().get();
  if (trusted === 1) return write();
  if (trusted !== 0) throw new Error('Invalid Agent write context');

  const setTrusted = db.prepare('UPDATE agent_write_context SET trusted = ? WHERE id = 1');
  setTrusted.run(1);
  try {
    write();
  } finally {
    setTrusted.run(0);
  }
}

export function migrateAgentCollaboration(db: Database.Database): boolean {
  return db.transaction(() => {
    const columns = new Set(
      (db.pragma('table_info(agents)') as Array<{ name: string }>).map(column => column.name),
    );
    const needsAllowlist = !columns.has('subagent_allow_agent_ids');
    const needsMode = !columns.has('subagent_collaboration_mode');
    const needsSnapshot = !columns.has('subagent_allow_agent_ids_snapshot');

    if (needsAllowlist) {
      db.exec("ALTER TABLE agents ADD COLUMN subagent_allow_agent_ids TEXT NOT NULL DEFAULT '[]'");
    }
    if (needsMode) {
      db.exec(`ALTER TABLE agents ADD COLUMN subagent_collaboration_mode TEXT NOT NULL DEFAULT '${SubagentCollaborationMode.All}'`);
    }
    if (needsSnapshot) {
      db.exec("ALTER TABLE agents ADD COLUMN subagent_allow_agent_ids_snapshot TEXT NOT NULL DEFAULT '[]'");
    }

    const rows = db.prepare(`
      SELECT id, subagent_collaboration_mode,
        COALESCE(subagent_allow_agent_ids, '[]') AS subagent_allow_agent_ids,
        subagent_allow_agent_ids_snapshot
      FROM agents
      WHERE COALESCE(subagent_allow_agent_ids, '[]') <> subagent_allow_agent_ids_snapshot
    `).all() as AgentCollaborationRow[];
    if (rows.length === 0) return needsAllowlist || needsMode || needsSnapshot;

    // The first snapshot of an existing DSH mode must preserve that mode. Later
    // list-only edits from older clients can change All to Allowlist.
    const preserveMode = needsSnapshot && !needsMode;
    const recordSelection = db.prepare(`
      UPDATE agents
      SET subagent_collaboration_mode = ?, subagent_allow_agent_ids_snapshot = ?
      WHERE id = ?
    `);
    withLegacyAgentWriteContext(db, () => {
      for (const row of rows) {
        let mode = row.subagent_collaboration_mode;
        if (!preserveMode && mode === SubagentCollaborationMode.All) {
          const selected = readPeerIds(row.subagent_allow_agent_ids, row.id);
          const previous = readPeerIds(row.subagent_allow_agent_ids_snapshot, row.id);
          if (selected.size > 0 && (selected.size !== previous.size || [...selected].some(id => !previous.has(id)))) {
            mode = SubagentCollaborationMode.Allowlist;
          }
        }
        recordSelection.run(mode, row.subagent_allow_agent_ids, row.id);
      }
    });
    return true;
  })();
}
