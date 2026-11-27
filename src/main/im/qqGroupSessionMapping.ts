import type Database from 'better-sqlite3';

import type { SessionMappingRow } from './imStore';
import type { Platform } from './types';

export function resolveQQGroupPeer(
  db: Database.Database, botPlatform: Platform, groupPeer: string, unionId?: string,
): string {
  if (unionId) {
    db.prepare(`
      INSERT INTO im_qq_group_peers (bot_platform, group_peer, union_id) VALUES (?, ?, ?)
      ON CONFLICT(bot_platform, group_peer) DO UPDATE SET union_id = excluded.union_id
      WHERE union_id <> excluded.union_id
    `).run(botPlatform, groupPeer, unionId);
  }
  // The first linked address keeps the queue stable when another bot joins.
  const row = db.prepare(`
    SELECT group_peer FROM im_qq_group_peers WHERE union_id = (
      SELECT union_id FROM im_qq_group_peers WHERE bot_platform = ? AND group_peer = ?
    ) ORDER BY rowid LIMIT 1
  `).get(botPlatform, groupPeer) as { group_peer: string } | undefined;
  return row?.group_peer ?? groupPeer;
}

export function findQQGroupSession(
  db: Database.Database, botPlatform: Platform, groupPeer: string, agentId: string,
): SessionMappingRow | undefined {
  // Keep the deliverable, bot-specific peer in each mapping. The union ID
  // only establishes that two such routes belong to the same physical group.
  return db.prepare(`
    SELECT m.* FROM im_qq_group_peers source
    JOIN im_qq_group_peers peer ON peer.union_id = source.union_id
    JOIN im_session_mappings m ON m.platform = peer.bot_platform AND m.im_conversation_id = peer.group_peer
    JOIN cowork_sessions s ON s.id = m.cowork_session_id
    WHERE source.bot_platform = ? AND source.group_peer = ?
      AND m.agent_id = ? AND COALESCE(NULLIF(s.agent_id, ''), 'main') = m.agent_id
    ORDER BY peer.rowid LIMIT 1
  `).get(botPlatform, groupPeer, agentId) as SessionMappingRow | undefined;
}
