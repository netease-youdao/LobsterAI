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
    SELECT peer.group_peer, peer.union_id, (
      SELECT owner.union_id FROM im_qq_group_peers owner WHERE owner.group_peer = peer.group_peer
      ORDER BY owner.rowid LIMIT 1
    ) AS first_union FROM im_qq_group_peers peer WHERE peer.union_id = (
      SELECT union_id FROM im_qq_group_peers WHERE bot_platform = ? AND group_peer = ?
    ) ORDER BY peer.rowid LIMIT 1
  `).get(botPlatform, groupPeer) as { group_peer: string; union_id: string; first_union: string } | undefined;
  if (!row) return groupPeer;
  // App-local addresses can coincide. Keep the original queue and give a
  // positively identified different group its own queue.
  return row.union_id === row.first_union ? row.group_peer : `union:${row.union_id}`;
}

export function hasConflictingQQGroupPeer(db: Database.Database, botPlatform: Platform, groupPeer: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM im_qq_group_peers own JOIN im_qq_group_peers other
      ON own.group_peer = other.group_peer AND own.union_id <> other.union_id
    WHERE own.bot_platform = ? AND own.group_peer = ? LIMIT 1
  `).get(botPlatform, groupPeer));
}

/** Older builds could already have pointed both app-local peers at one transcript. */
export function canReuseQQGroupSession(
  db: Database.Database, botPlatform: Platform, groupPeer: string, sessionId: string,
): boolean {
  const conflict = db.prepare(`
    SELECT 1 FROM im_qq_group_peers own WHERE own.bot_platform = ? AND own.group_peer = ?
      AND own.union_id <> (
        SELECT peer.union_id FROM im_session_mappings m JOIN im_qq_group_peers peer
          ON m.platform = peer.bot_platform AND m.im_conversation_id = peer.group_peer
        WHERE m.cowork_session_id = ? ORDER BY peer.rowid LIMIT 1
      )
  `).get(botPlatform, groupPeer, sessionId);
  return !conflict;
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
