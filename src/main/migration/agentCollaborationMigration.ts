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
      if (!needsMode) {
        // Existing DSH rows can intentionally keep a list while collaboration is set to All.
        db.exec("UPDATE agents SET subagent_allow_agent_ids_snapshot = COALESCE(subagent_allow_agent_ids, '[]')");
        return true;
      }
    }

    // Older clients update the list without updating its snapshot or the collaboration mode.
    const rows = db.prepare(`
      SELECT id, subagent_collaboration_mode,
        COALESCE(subagent_allow_agent_ids, '[]') AS subagent_allow_agent_ids,
        subagent_allow_agent_ids_snapshot
      FROM agents
      WHERE COALESCE(subagent_allow_agent_ids, '[]') <> subagent_allow_agent_ids_snapshot
    `).all() as AgentCollaborationRow[];
    const recordSelection = db.prepare(`
      UPDATE agents
      SET subagent_collaboration_mode = ?, subagent_allow_agent_ids_snapshot = ?
      WHERE id = ?
    `);
    for (const row of rows) {
      let mode = row.subagent_collaboration_mode;
      if (mode === SubagentCollaborationMode.All) {
        const selected = readPeerIds(row.subagent_allow_agent_ids, row.id);
        const previous = readPeerIds(row.subagent_allow_agent_ids_snapshot, row.id);
        if (selected.size > 0 && (selected.size !== previous.size || [...selected].some(id => !previous.has(id)))) {
          mode = SubagentCollaborationMode.Allowlist;
        }
      }
      recordSelection.run(mode, row.subagent_allow_agent_ids, row.id);
    }
    return needsAllowlist || needsMode || needsSnapshot || rows.length > 0;
  })();
}
