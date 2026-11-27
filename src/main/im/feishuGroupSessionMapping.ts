import type Database from 'better-sqlite3';

import { AgentId } from '../../shared/agent/constants';
import { RetainedImPlatform } from '../../shared/dshEngine/hostConstants';
import { parseImConversationId } from '../../shared/platform';
import { currentImBotIdentities } from '../migration/legacyImBotIdentities';
import type { SessionMappingRow } from './imStore';
import { resolveLegacyImAccountIds } from './legacyDirectSessionMapping';

export interface FeishuGroupSessionRoute {
  instanceId: string;
  agentId: string;
  chatId: string;
  conversationIds: string[];
}

export function findLegacyFeishuGroupSession(
  db: Database.Database,
  route: FeishuGroupSessionRoute,
  bindings: Record<string, string> | undefined,
): SessionMappingRow | null {
  const platform = RetainedImPlatform.Feishu;
  const accounts = resolveLegacyImAccountIds(db, platform, route.instanceId, route.chatId);
  if (!accounts.length) return null;

  const instancePlatform = `${platform}:${route.instanceId}`;
  const agentBots = currentImBotIdentities(db, platform).filter(bot =>
    (bindings?.[bot.key] || bindings?.[platform] || AgentId.Main) === route.agentId,
  );
  const canClaimAccountless = accounts.includes('')
    || (agentBots.length === 1 && agentBots[0].key === instancePlatform);
  const scopedPlatforms = accounts.filter(Boolean).map(account => `${platform}:${account}`);
  const platforms = [platform, ...scopedPlatforms];
  const unprefixedIds = route.conversationIds.flatMap(id => [id, `${platform}:${id}`]);
  const candidates = [...new Set([
    ...unprefixedIds,
    ...accounts.filter(Boolean).flatMap(account => route.conversationIds.map(id => `${account}:${id}`)),
  ])];

  const rows = db.prepare(`
    SELECT m.* FROM im_session_mappings m JOIN cowork_sessions s ON s.id = m.cowork_session_id
    WHERE m.agent_id = ? AND COALESCE(NULLIF(s.agent_id, ''), ?) = m.agent_id
      AND m.platform IN (${platforms.map(() => '?').join(', ')})
      AND m.im_conversation_id IN (${candidates.map(() => '?').join(', ')})
      AND (m.platform <> ? OR m.openclaw_session_key IS NOT NULL)
  `).all(route.agentId, AgentId.Main, ...platforms, ...candidates, instancePlatform) as SessionMappingRow[];
  const matches = rows.filter(row => {
    const account = parseImConversationId(row.im_conversation_id).accountId;
    if (account && account !== platform) return accounts.includes(account);
    return row.platform !== platform || canClaimAccountless;
  });
  const [first] = matches;
  return first && matches.every(match => match.cowork_session_id === first.cowork_session_id) ? first : null;
}
