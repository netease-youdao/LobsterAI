import type Database from 'better-sqlite3';

import { AgentId } from '../../shared/agent/constants';
import { RetainedImPlatform } from '../../shared/dshEngine/hostConstants';
import { legacyWeixinAccountId } from '../../shared/im/weixin';
import { ImPeerKind, PlatformRegistry } from '../../shared/platform';
import {
  currentImBotIdentities,
  isLegacyDirectPlatform,
  type LegacyDirectPlatform,
  legacyImBotIdentities,
} from '../migration/legacyImBotIdentities';
import type { SessionMappingRow } from './imStore';

export interface DirectSessionRoute {
  platform: RetainedImPlatform;
  instanceId: string;
  agentId: string;
  chatId: string;
  senderId?: string;
}

const LEGACY_DEFAULT_ACCOUNT = 'default';
const LEGACY_DINGTALK_DEFAULT_ACCOUNT = '__default__';

export function resolveLegacyImAccountIds(db: Database.Database, platform: LegacyDirectPlatform, instanceId: string, peer: string): string[] {
  const configured = currentImBotIdentities(db, platform);
  const legacy = legacyImBotIdentities(db);
  if (platform === RetainedImPlatform.Weixin) {
    const [current] = configured;
    if (!current?.accountId) return [];
    const account = legacyWeixinAccountId(current.accountId);
    if (!account) return [];
    const prefixes = [account];
    const old = legacy?.find(bot => bot.key === platform);
    if (!old) return prefixes;
    const original = legacyWeixinAccountId(old.accountId);
    const owner = current.userId?.toLowerCase();
    // Older OpenClaw builds omitted the owner. In that case only the newly
    // authenticated owner's own DM can bridge a changed bot account.
    const sameOwner = owner && owner === (old.userId || peer).toLowerCase();
    if (original && (original === account || sameOwner)) prefixes.push(original, '');
    return prefixes;
  }

  const prefix = platform + ':';
  const key = prefix + instanceId;
  const current = configured.find(bot => bot.key === key);
  if (!current) return [];
  const oldBots = legacy?.filter(bot => bot.key.startsWith(prefix) || bot.key === platform);
  if (oldBots) {
    const sameBot = oldBots.some(bot => bot.key === key && bot.accountId === current.accountId);
    const formerSingleBot = oldBots.some(bot => bot.key === platform && bot.accountId === current.accountId)
      && configured.filter(bot => bot.accountId === current.accountId).length === 1;
    if (!current.accountId || (!sameBot && !formerSingleBot)) return [];
  }
  const keys = new Set([...configured, ...(oldBots ?? [])].map(bot => bot.key).filter(id => id.startsWith(prefix)));
  const accounts = [instanceId];
  const short = instanceId.slice(0, 8);
  if ([...keys].filter(id => id.startsWith(prefix + short)).length === 1) accounts.push(short);
  // In per-channel mode OpenClaw omitted the account. Multiple configured
  // bots (including disabled ones) cannot safely claim such a conversation.
  if (keys.size === 1) accounts.push(LEGACY_DEFAULT_ACCOUNT, '');
  return accounts;
}

// Some DingTalk connector versions stored a bare peer as the primary key.
// The original gateway key still proves that it was a DM on this bot.
function isDingTalkContext(row: SessionMappingRow, accounts: string[], route: DirectSessionRoute): boolean {
  const key = row.openclaw_session_key;
  const prefix = `agent:${route.agentId}:openai-user:`;
  if (!key?.startsWith(prefix)) return false;
  try {
    const ctx = JSON.parse(key.slice(prefix.length));
    const account = ctx.accountid === LEGACY_DINGTALK_DEFAULT_ACCOUNT ? '' : ctx.accountid ?? '';
    return typeof ctx.channel === 'string' && PlatformRegistry.platformOfChannel(ctx.channel) === route.platform
      && ctx.chattype === ImPeerKind.Direct && accounts.includes(account)
      && ctx.peerid === row.im_conversation_id;
  } catch {
    return false;
  }
}

function directPeerKeys(accounts: string[], peer: string): Set<string> {
  const keys = new Set<string>();
  for (const account of accounts) {
    const prefix = (account ? account + ':' : '') + ImPeerKind.Direct + ':';
    keys.add(prefix + peer);
    keys.add(prefix + peer.toLowerCase());
  }
  return keys;
}

export function findLegacyDirectSession(db: Database.Database, route: DirectSessionRoute): SessionMappingRow | null {
  if (!isLegacyDirectPlatform(route.platform)) return null;
  // DingTalk and Feishu use a conversation ID on the wire and a sender ID in
  // an OpenClaw DM. QQ and Weixin address their DM directly to the peer.
  const peer = route.senderId || (
    route.platform === RetainedImPlatform.QQ || route.platform === RetainedImPlatform.Weixin ? route.chatId : ''
  );
  if (!peer) return null;
  const accounts = resolveLegacyImAccountIds(db, route.platform, route.instanceId, peer);
  if (!accounts.length) return null;
  const keys = directPeerKeys(accounts, peer);
  const scopedPlatform = `${route.platform}:${route.instanceId}`;
  // Older single-to-multi migrations put the full bot UUID in the platform
  // column. That scope also identifies unprefixed and shortened keys.
  const scopedAccounts = route.platform === RetainedImPlatform.Weixin
    ? accounts : [...accounts, route.instanceId.slice(0, 8), LEGACY_DEFAULT_ACCOUNT, ''];
  const scopedKeys = directPeerKeys(scopedAccounts, peer);
  const candidates = [...scopedKeys];
  if (route.platform === RetainedImPlatform.DingTalk) candidates.push(peer, peer.toLowerCase());
  const placeholders = candidates.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT m.* FROM im_session_mappings m JOIN cowork_sessions s ON s.id = m.cowork_session_id
    WHERE m.agent_id = ? AND COALESCE(NULLIF(s.agent_id, ''), ?) = m.agent_id AND m.platform IN (?, ?)
      AND m.im_conversation_id IN (${placeholders})
  `).all(route.agentId, AgentId.Main, route.platform, scopedPlatform, ...candidates) as SessionMappingRow[];
  const matches = rows.filter(row => {
    const scoped = row.platform === scopedPlatform;
    return (scoped ? scopedKeys : keys).has(row.im_conversation_id)
      || isDingTalkContext(row, scoped ? scopedAccounts : accounts, route);
  });
  const [first] = matches;
  return first && matches.every(row => row.cowork_session_id === first.cowork_session_id) ? first : null;
}
