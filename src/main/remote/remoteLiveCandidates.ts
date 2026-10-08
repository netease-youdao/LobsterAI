import type Database from 'better-sqlite3';

export interface RemoteLiveCandidate { object_id: string; revision: number; kind: 'message' | 'tool'; position: number }
const windowSize = 64;

/** Limit source rows before tool grouping. Historic tool memberships never enter the main-process scan. */
export function recentLiveCandidates(db: Database.Database, sessionId: string): RemoteLiveCandidate[] {
  return db.transaction(() => {
    const rows = db.prepare(`SELECT id,type,sequence,CASE WHEN type IN ('tool_use','tool_result') THEN
      CASE WHEN metadata IS NULL THEN id WHEN octet_length(metadata)<=32768 THEN
        CASE WHEN json_valid(metadata) THEN COALESCE(json_extract(metadata,'$.toolUseId'),json_extract(metadata,'$.toolCallId'),id) END
      END END AS tool_id
      FROM (SELECT id,type,sequence,metadata FROM cowork_messages WHERE session_id=? ORDER BY sequence DESC LIMIT 64)`)
      .all(sessionId) as Array<{ id: string; type: string; sequence: number; tool_id: unknown }>;
    const candidates: RemoteLiveCandidate[] = [];
    const tools = new Map<string, number>();
    for (const row of rows) {
      db.prepare(`INSERT INTO remote_live_revisions VALUES(?,?,1,0) ON CONFLICT(session_id,object_id) DO NOTHING`).run(sessionId, row.id);
      const revision = db.prepare('SELECT revision,deleted FROM remote_live_revisions WHERE session_id=? AND object_id=?')
        .get(sessionId, row.id) as { revision: number; deleted: number };
      if (!revision.deleted && ['user', 'assistant', 'system', 'tool_use', 'tool_result'].includes(row.type))
        candidates.push({ object_id: row.id, revision: revision.revision, kind: 'message', position: row.sequence });
      if (typeof row.tool_id !== 'string' || !row.tool_id || Buffer.byteLength(row.tool_id) > 32768) continue;
      db.prepare(`INSERT INTO remote_live_tool_sources VALUES(?,?,?) ON CONFLICT(session_id,message_id) DO UPDATE SET tool_id=excluded.tool_id`)
        .run(sessionId, row.id, row.tool_id);
      tools.set(row.tool_id, Math.max(tools.get(row.tool_id) || 0, row.sequence));
    }
    for (const [toolId, position] of tools) {
      db.prepare('INSERT INTO remote_live_tools VALUES(?,?,1) ON CONFLICT(session_id,tool_id) DO NOTHING').run(sessionId, toolId);
      const revision = db.prepare('SELECT revision FROM remote_live_tools WHERE session_id=? AND tool_id=?').get(sessionId, toolId) as { revision: number };
      candidates.push({ object_id: toolId, revision: revision.revision, kind: 'tool', position });
    }
    return candidates.sort((a, b) => b.position - a.position || b.kind.localeCompare(a.kind)).slice(0, windowSize);
  })();
}
